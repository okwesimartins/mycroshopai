const GeminiAI       = require('../../lib/gemini');
const whatsapp       = require('../../lib/whatsapp');
const backendApi     = require('../../lib/backend-api');
const firestore      = require('../../lib/firestore');
const contactPricing = require('../../lib/contact-pricing');

// Patch backendApi calls to log full error details for debugging
const origCheckProduct = backendApi.checkProduct.bind(backendApi);
backendApi.checkProduct = async (tenantId, productName, plan) => {
  try {
    const result = await origCheckProduct(tenantId, productName, plan);
    if (!result) {
      console.warn(`[BackendAPI:checkProduct] returned null for "${productName}" (tenant=${tenantId})`);
    }
    return result;
  } catch (e) {
    const status = e.response?.status;
    const body   = JSON.stringify(e.response?.data || {}).substring(0, 300);
    console.error(`[BackendAPI:checkProduct] FAILED for "${productName}" | HTTP ${status} | ${body} | ${e.message}`);
    return null;
  }
};

const ai = new GeminiAI(process.env.GEMINI_API_KEY || '');

/**
 * processMessage — the conversation engine
 *
 * Flow:
 * 1. Dedup + contact limit check
 * 2. Load conversation history + order state from Firestore
 * 3. Detect intent → pre-fetch product data from backend
 * 4. Call Gemini WITH the product data already injected
 *    → Gemini writes a COMPLETE natural reply using real data
 *    → Gemini also returns actions to execute
 * 5. Execute actions (send images, confirm order, verify payment)
 * 6. Gemini's reply is the message — action results refine/replace only when needed
 * 7. Send to WhatsApp, save history
 *
 * The key insight: Gemini must see real data BEFORE writing the reply.
 * That's what makes it sound natural instead of "Checking now... [separate data dump]"
 */
async function processMessage(messageData) {
  const {
    tenantId,
    accessToken,
    storeName,
    businessBio,
    subscriptionPlan: spRaw,
    defaultOnlineStoreId,
    customerPhone,
    message,
    messageId,
    phoneNumberId,
  } = messageData;

  const subscriptionPlan  = spRaw || 'enterprise';
  const storeNameResolved = storeName || 'our store';

  const log    = (tag, ...a) => console.log(`[pm:${tag}]`, ...a);
  const logErr = (tag, err) => {
    console.error(`[pm:ERR:${tag}]`, err?.message || err);
    if (err?.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
  };

  try {
    // ── Guard ────────────────────────────────────────────────────────────
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    const msgText = (message || '').trim();
    if (!msgText) { log('skip', 'empty message'); return; }
    log('start', `tenant=${tenantId} customer=${customerPhone} msg="${msgText.substring(0, 80)}"`);

    // ── Deduplication ────────────────────────────────────────────────────
    // WhatsApp retries webhooks on slow responses — skip already-processed
    if (messageId && typeof firestore.hasProcessedMessage === 'function') {
      const done = await firestore.hasProcessedMessage(tenantId, messageId).catch(() => false);
      if (done) { log('dedup', 'already processed, skipping'); return; }
    }

    // ── Contact limit ────────────────────────────────────────────────────
    if (typeof firestore.checkContactLimit === 'function') {
      const limit = await firestore.checkContactLimit(tenantId)
        .catch(e => { logErr('contactLimit', e); throw e; });
      if (limit.reached) {
        const prev = await firestore.getConversationHistory(tenantId, customerPhone, 1).catch(() => []);
        if (!prev.length) {
          await safeSend(phoneNumberId, customerPhone, accessToken,
            `Sorry, this store has reached its contact limit. Please reach out to the merchant directly.`);
          return;
        }
      }
    }

    // ── Track contact ────────────────────────────────────────────────────
    await firestore.trackContact?.(tenantId, customerPhone).catch(() => {});

    // ── Load conversation history + order state ──────────────────────────
    const rawHistory = typeof firestore.getConversationHistory === 'function'
      ? await firestore.getConversationHistory(tenantId, customerPhone).catch(e => { logErr('history', e); throw e; })
      : [];

    // Sanitise history: if any assistant turn stored raw JSON (old bug), extract just the reply text.
    // This prevents Gemini from seeing {"reply":"...","actions":[]} in model turns and mirroring it.
    const conversationHistory = rawHistory.map(msg => {
      if (msg.role !== 'user' && typeof msg.text === 'string' && msg.text.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(msg.text);
          if (parsed.reply && typeof parsed.reply === 'string') {
            return { ...msg, text: parsed.reply };
          }
        } catch (_) {
          const m = msg.text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) {
            try { return { ...msg, text: JSON.parse('"' + m[1] + '"') }; } catch (_2) {}
          }
        }
      }
      return msg;
    });

    let orderState   = 'idle';
    let pendingOrder = null;
    if (typeof firestore.getOrderState === 'function') {
      const saved = await firestore.getOrderState(tenantId, customerPhone).catch(() => null);
      if (saved) { orderState = saved.state || 'idle'; pendingOrder = saved.pending_order || null; }
    }

    // ── PRE-FETCH product data ───────────────────────────────────────────
    // This is what makes Gemini sound natural:
    // We give it REAL product names and prices BEFORE it writes its reply.
    // Instead of "Checking now..." it can say "Jordan 1 is ₦38k, we have 4 left. What size?"
    let inventoryText = null;
    const inventoryIntent = detectInventoryIntent(msgText, conversationHistory, orderState);

    if (inventoryIntent.needed) {
      try {
        const result = await backendApi.listProducts(tenantId, subscriptionPlan, {
          search: inventoryIntent.search || undefined,
          limit:  inventoryIntent.search ? 12 : 20,
        });

        if (result?.products?.length) {
          inventoryText = formatProductsForPrompt(result.products);
          log('preload', `${result.products.length} products injected (search: ${inventoryIntent.search || 'all'})`);
        } else {
          inventoryText = '[No products found in catalog right now]';
          log('preload', 'no products found');
        }
      } catch (e) {
        logErr('preload', e); // non-fatal — Gemini still responds
      }
    }

    // ── Call Gemini ──────────────────────────────────────────────────────
    const aiResponse = await ai.processMessage(msgText, {
      tenant_id:            tenantId,
      subscription_plan:    subscriptionPlan,
      customer_phone:       customerPhone,
      store_name:           storeNameResolved,
      business_bio:         businessBio || null,
      conversation_history: conversationHistory,
      order_state:          orderState,
      pending_order:        pendingOrder,
    }, inventoryText).catch(e => { logErr('gemini', e); throw e; });

    log('gemini', `reply="${aiResponse.text?.substring(0, 80)}" actions=[${aiResponse.actions?.map(a=>a.type).join(',')||'none'}]`);

    // ── Execute actions ──────────────────────────────────────────────────
    let finalReply    = aiResponse.text || '';
    let newOrderState = aiResponse.order_state || orderState;
    let newPending    = pendingOrder;

    for (const action of (aiResponse.actions || [])) {
      const result = await handleAction(action, {
        tenantId, subscriptionPlan, defaultOnlineStoreId,
        message: msgText, conversationHistory, customerPhone,
        accessToken, phoneNumberId, pendingOrder,
        aiResponse, // pass full response so handlers can see all actions this turn
      });

      if (!result) continue;

      if (result.type === 'order_pending') {
        // Partial order — save collected data, Gemini's collecting-details reply stays
        newPending    = result.pending_order;
        newOrderState = 'collecting_details';

      } else if (result.type === 'replace') {
        // Hard replace — order confirmation, payment result, error messages
        finalReply = result.text || finalReply;

      } else if (result.type === 'soft_replace') {
        // Soft replace — only overwrite if Gemini wrote a placeholder, not a real answer
        // (Gemini may have already answered perfectly from pre-injected PRODUCT DATA)
        if (isPlaceholder(finalReply) || !finalReply.includes('₦')) {
          finalReply = result.text || finalReply;
        }

      } else if (result.type === 'append_images') {
        // Images sent inline; append formatted catalog text after Gemini's intro
        if (result.text) finalReply = mergeIntroAndData(finalReply, result.text);

      } else if (result.type === 'data') {
        // Backend returned richer data than what was pre-loaded — replace Gemini's text
        // ONLY if Gemini's reply looks like a placeholder (it said "checking" or similar)
        if (result.text && isPlaceholder(finalReply)) {
          finalReply = result.text;
        } else if (result.text) {
          finalReply = mergeIntroAndData(finalReply, result.text);
        }
      }
    }

    // ── Final cleanup ────────────────────────────────────────────────────
    finalReply = (finalReply || '')
      .replace(/\b(list_inventory|query_inventory|create_order|check_payment|show_variations)\b/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      .trim();

    if (!finalReply) finalReply = 'Something went wrong on my end. Try again in a moment.';

    // ── Final JSON leak guard ────────────────────────────────────────────
    // Last-resort safety: if finalReply is still a JSON object string, extract the reply field.
    // This should never happen if the above parsing worked, but belt-and-suspenders.
    if (finalReply.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(finalReply);
        if (parsed.reply && typeof parsed.reply === 'string') {
          log('json-guard', 'Caught JSON leaking to customer — extracting reply field');
          finalReply = parsed.reply.trim();
        }
      } catch (_) {
        // Try regex
        const m = finalReply.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m) {
          try { finalReply = JSON.parse('"' + m[1] + '"'); } catch (_2) { finalReply = m[1]; }
          log('json-guard', 'Regex-extracted reply from JSON string');
        } else {
          // Completely unparseable JSON — use safe fallback
          finalReply = "Hey, what can I help you with?";
          log('json-guard', 'Could not parse JSON, using safe fallback');
        }
      }
    }

    // ── Send to customer ─────────────────────────────────────────────────
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone, finalReply)
      .catch(e => { logErr('send', e); throw e; });

    // ── Persist ──────────────────────────────────────────────────────────
    if (typeof firestore.saveMessage === 'function') {
      await Promise.all([
        firestore.saveMessage(tenantId, customerPhone, 'user',      msgText,    messageId),
        firestore.saveMessage(tenantId, customerPhone, 'assistant', finalReply),
      ]).catch(e => logErr('save', e));
    }

    if (typeof firestore.saveOrderState === 'function') {
      await firestore.saveOrderState(tenantId, customerPhone, {
        state: newOrderState, pending_order: newPending,
      }).catch(() => {});
    }

    if (messageId && typeof firestore.markMessageProcessed === 'function') {
      await firestore.markMessageProcessed(tenantId, messageId).catch(() => {});
    }

  } catch (err) {
    logErr('FATAL', err);
    await safeSend(phoneNumberId, customerPhone, accessToken,
      'Sorry, something went wrong. Try again in a moment.').catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Action Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleAction(action, ctx) {
  const { tenantId, subscriptionPlan, defaultOnlineStoreId,
          message, conversationHistory, customerPhone,
          accessToken, phoneNumberId, pendingOrder,
          aiResponse } = ctx;
  try {
    switch (action.type) {
      case 'list_inventory':
        return await handleListInventory({
          tenantId, subscriptionPlan,
          search:      action.search      ?? null,
          share_media: action.share_media === true,
          accessToken, phoneNumberId, customerPhone, conversationHistory,
        });

      case 'query_inventory':
        return await handleQueryInventory({
          tenantId, subscriptionPlan,
          productName: action.product_name || extractProductName(message),
          intent: action.intent,
          share_media: action.share_media !== false, // default true for single product queries
          accessToken, phoneNumberId, customerPhone,
        });

      case 'show_variations': {
        const varProductName = action.product_name || extractLastProduct(conversationHistory);
        // Skip if query_inventory already ran for this same product this turn
        // (query_inventory includes variations in its response, so this would duplicate)
        const queryRanForSameProduct = (aiResponse?.actions || []).some(a =>
          a.type === 'query_inventory' &&
          (a.product_name || '').toLowerCase() === (varProductName || '').toLowerCase()
        );
        return await handleShowVariations(
          tenantId, subscriptionPlan,
          varProductName,
          queryRanForSameProduct,
        );
      }

      case 'create_order':
        return await handleOrderCreation({
          tenantId, subscriptionPlan, defaultOnlineStoreId,
          message, conversationHistory, customerPhone,
          orderDataFromGemini: action.order_data || null,
          pendingOrder,
        });

      case 'check_payment':
        return await handlePaymentCheck(tenantId, message);

      default:
        console.warn('[handleAction] unknown action:', action.type);
        return null;
    }
  } catch (err) {
    console.error('[handleAction] error in', action.type, err?.message);
    return null;
  }
}

// ── List inventory ────────────────────────────────────────────────────────────
async function handleListInventory({ tenantId, subscriptionPlan, search, share_media,
    accessToken, phoneNumberId, customerPhone, conversationHistory }) {

  const result = await backendApi.listProducts(tenantId, subscriptionPlan, {
    search: search || undefined,
    limit:  search ? 12 : 20,
  });

  if (!result?.products?.length) {
    return {
      type: 'replace',
      text: search
        ? `We don't have anything matching "${search}" right now. Want to see the full catalog?`
        : "Catalog's being updated right now. Ask about a specific product and I'll check for you.",
    };
  }

  const products  = result.products;
  const base      = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');
  const toUrl     = url => !url ? null : url.startsWith('http') ? url : `${base}${url.startsWith('/')? '':'/'}${url}`;

  // Send images inline when requested
  if (share_media && accessToken && phoneNumberId && customerPhone) {
    const imgs = products.filter(p => toUrl(p.image_url)).slice(0, 5);
    for (const p of imgs) {
      const { line } = priceStock(p);
      await whatsapp.sendImage(phoneNumberId, accessToken, customerPhone, toUrl(p.image_url), `${p.name} – ${line}`)
        .catch(e => console.error('[list] image fail:', e.message));
    }
  }

  // Build readable catalog text
  let text = '';
  products.forEach((p, i) => {
    const { line } = priceStock(p);
    text += `${i + 1}. ${p.name} – ${line}\n`;
  });
  if (products.length > 1) text += '\nWhich one are you interested in?';

  return { type: share_media ? 'append_images' : 'data', text: text.trim() };
}

// ── Query specific product ────────────────────────────────────────────────────
async function handleQueryInventory({ tenantId, subscriptionPlan, productName, intent,
    share_media = true, accessToken, phoneNumberId, customerPhone }) {

  if (!productName) return { type: 'replace', text: 'Which product were you asking about?' };

  const base  = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');
  const toUrl = url => !url ? null : url.startsWith('http') ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`;

  // Strategy: try checkProduct first, fall back to listProducts search.
  // Many backends don't implement checkProduct reliably, but listProducts search always works.
  let product = null;

  try {
    const checkResult = await backendApi.checkProduct(tenantId, productName, subscriptionPlan);
    if (checkResult?.exists && checkResult.product) {
      product = checkResult.product;
      console.log('[queryInventory] checkProduct found:', product.name);
    }
  } catch (e) {
    console.warn('[queryInventory] checkProduct threw error:', e.message, '— trying listProducts fallback');
  }

  // Fallback: search by name if checkProduct failed or returned nothing
  if (!product) {
    try {
      const searchResult = await backendApi.listProducts(tenantId, subscriptionPlan, {
        search: productName, limit: 5
      });
      if (searchResult?.products?.length) {
        // Find best match — exact name first, then partial
        product = searchResult.products.find(p =>
          p.name?.toLowerCase() === productName.toLowerCase()
        ) || searchResult.products.find(p =>
          p.name?.toLowerCase().includes(productName.toLowerCase())
        ) || searchResult.products[0];
        console.log('[queryInventory] listProducts fallback found:', product?.name);
      }
    } catch (e) {
      console.error('[queryInventory] listProducts fallback also failed:', e.message);
    }
  }

  if (!product) {
    // Try even broader search before giving up
    try {
      const broad = await backendApi.listProducts(tenantId, subscriptionPlan, {
        search: productName.split(' ')[0], limit: 5 // search just first word
      });
      if (broad?.products?.length) {
        let text = `Couldn't find "${productName}" exactly. Did you mean:\n\n`;
        broad.products.forEach((p, i) => { const { line } = priceStock(p); text += `${i+1}. ${p.name} – ${line}\n`; });
        text += '\nWhich one?';
        return { type: 'replace', text };
      }
    } catch (_) {}
    return { type: 'replace', text: `We don't have "${productName}" right now. Want to see everything we carry?` };
  }

  // ── We have the product — build the rich response ────────────────────────
  const priceStr  = fmtN(product.price);
  const stockNum  = product.stock;
  const stockInfo = stockNum != null
    ? (stockNum > 0 ? `${stockNum} in stock` : 'Out of stock')
    : '';

  // 1. Send product image if available and requested
  const imageUrl = toUrl(product.image_url || product.imageUrl);
  if (share_media && imageUrl && accessToken && phoneNumberId && customerPhone) {
    const caption = `${product.name} — ${priceStr}${stockInfo ? ` | ${stockInfo}` : ''}`;
    await whatsapp.sendImage(phoneNumberId, accessToken, customerPhone, imageUrl, caption)
      .catch(e => console.error('[queryInventory] image send failed:', e.message));
  }

  // 2. Build detail + variations text
  let text = '';

  if (product.description && product.description.trim()) {
    text += `${product.description.trim()}\n\n`;
  }

  text += `💰 Price: ${priceStr}`;
  if (stockInfo) text += `\n📦 Stock: ${stockInfo}`;

  // 3. Append variations if present
  if (product.variations?.length) {
    text += '\n\n';
    for (const v of product.variations) {
      const opts = (v.options || []).filter(o => o.is_available !== false);
      if (!opts.length) continue;
      if (v.variation_name) text += `${v.variation_name}:\n`;
      for (const o of opts) {
        const price = parseFloat(o.price_adjustment || o.price) || parseFloat(product.price) || 0;
        const oStock = o.stock != null ? ` (${o.stock} left)` : '';
        text += `• ${o.option_display_name || o.option_value} — ${fmtN(price)}${oStock}\n`;
      }
      text += '\n';
    }
    text = text.trimEnd() + '\n\nWhich option works for you?';
  } else {
    text += '\n\nWant to order?';
  }

  return { type: 'replace', text };
}

// ── Show variations ───────────────────────────────────────────────────────────
async function handleShowVariations(tenantId, subscriptionPlan, productName, skipIfAlreadyInReply = false) {
  if (!productName) return null;
  // If called alongside query_inventory on same product, query_inventory already includes variations
  if (skipIfAlreadyInReply) return null;

  const result = await backendApi.listProducts(tenantId, subscriptionPlan, { search: productName, limit: 5 })
    .catch(e => { console.error('[showVariations] listProducts error:', e.message); return null; });

  if (!result?.products?.length) return null;

  const p = result.products.find(x => x.name?.toLowerCase().includes(productName.toLowerCase()))
         || result.products[0];

  if (!p.variations?.length) {
    // No variations — product detail already sent by query_inventory, nothing to add
    return null;
  }

  let text = `${p.name} options:\n\n`;
  for (const v of p.variations) {
    const opts = (v.options || []).filter(o => o.is_available !== false);
    if (!opts.length) continue;
    if (v.variation_name) text += `${v.variation_name}:\n`;
    for (const o of opts) {
      const price = parseFloat(o.price_adjustment || o.price) || parseFloat(p.price) || 0;
      const stock = o.stock != null ? ` (${o.stock} left)` : '';
      text += `• ${o.option_display_name || o.option_value} — ${fmtN(price)}${stock}\n`;
    }
    text += '\n';
  }
  text = text.trimEnd() + '\n\nWhich would you like?';
  return { type: 'replace', text };
}

// ── Order creation ────────────────────────────────────────────────────────────
async function handleOrderCreation({ tenantId, subscriptionPlan, defaultOnlineStoreId,
    message, conversationHistory, customerPhone, orderDataFromGemini, pendingOrder }) {

  if (!defaultOnlineStoreId) {
    return { type: 'replace', text: "This store isn't set up for online orders yet. Reach out to the merchant directly." };
  }

  // Use Gemini's parsed order_data when available — avoids a second AI call
  let details;
  if (orderDataFromGemini?.product_name) {
    details = {
      items: [{
        product_name: orderDataFromGemini.product_name,
        product_id:   orderDataFromGemini.product_id || null,
        quantity:     orderDataFromGemini.quantity || 1,
      }],
      customer_name:    orderDataFromGemini.customer_name    || null,
      customer_phone:   orderDataFromGemini.customer_phone   || customerPhone,
      customer_email:   orderDataFromGemini.customer_email   || null,
      shipping_address: orderDataFromGemini.customer_address || null,
      ready_to_create: !!(
        orderDataFromGemini.product_name &&
        orderDataFromGemini.customer_name &&
        (orderDataFromGemini.customer_phone || customerPhone) &&
        orderDataFromGemini.customer_address
      ),
    };
  } else {
    details = await ai.extractOrderDetails(message, conversationHistory, pendingOrder);
  }

  if (!details) return { type: 'replace', text: 'What would you like to order?' };

  // Not ready — save what we have and let Gemini's reply ask for the rest
  if (!details.ready_to_create) {
    return {
      type: 'order_pending',
      pending_order: {
        items:            details.items || [],
        customer_name:    details.customer_name,
        customer_phone:   details.customer_phone || customerPhone,
        customer_email:   details.customer_email,
        shipping_address: details.shipping_address,
      },
    };
  }

  // Validate products against backend
  const validItems = [];
  for (const item of details.items) {
    const check = await backendApi.checkProduct(tenantId, item.product_name, subscriptionPlan);
    if (!check?.exists || !check.product) {
      return { type: 'replace', text: `"${item.product_name}" isn't available right now. Want to see what we have?` };
    }
    const p = check.product;
    const qty = item.quantity || 1;
    if (p.stock != null && p.stock < qty) {
      return { type: 'replace', text: `We only have ${p.stock} of the ${p.name} left — you wanted ${qty}. Want to adjust?` };
    }
    validItems.push({ product_id: p.id, product_name: p.name, quantity: qty, price: p.price });
  }

  const order = await backendApi.createOrder(tenantId, {
    online_store_id: defaultOnlineStoreId,
    items: validItems,
    customer_info: {
      name:             details.customer_name    || 'WhatsApp Customer',
      email:            details.customer_email   || '',
      phone:            details.customer_phone   || customerPhone,
      shipping_address: details.shipping_address || '',
    },
  });

  if (order.success) {
    const o = order.order;
    let msg = `✅ Order confirmed!\n\nOrder #${o?.id || o?.order_number || 'N/A'}\n`;
    if (o?.total != null) msg += `Total: ${fmtN(o.total)}\n`;
    if (order.paymentLink) msg += `\nPay here 👇\n${order.paymentLink}`;
    msg += '\n\nOnce payment is confirmed we\'ll process it right away.';
    return { type: 'replace', text: msg };
  }

  return { type: 'replace', text: "Ran into an issue placing the order. Give it another try or contact us directly." };
}

// ── Payment check ─────────────────────────────────────────────────────────────
async function handlePaymentCheck(tenantId, message) {
  const ref = extractPaymentRef(message);
  if (!ref) return { type: 'replace', text: "What's your payment reference? I'll verify it." };

  const result = await backendApi.verifyPayment(tenantId, ref);
  if (!result?.success) return { type: 'replace', text: "Couldn't look that up right now. Try again in a moment." };

  if (result.paid) {
    const txn = result.transaction;
    let msg = `✅ Payment confirmed!\n\nRef: ${txn?.reference || ref}\n`;
    if (txn?.amount) msg += `Amount: ${fmtN(txn.amount)}\n`;
    if (result.order?.id) msg += `Order #${result.order.id} is now being processed.`;
    return { type: 'replace', text: msg };
  }

  return { type: 'replace', text: `Payment for ref ${ref} hasn't come through yet. Complete the payment and try again.` };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Intent detection + helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether to pre-fetch inventory before calling Gemini.
 * Returns { needed: bool, search: string|null }
 *
 * We pre-fetch when the customer is asking about products so Gemini has
 * real data and can write a complete, accurate reply in one shot.
 */
function detectInventoryIntent(message, conversationHistory, orderState) {
  // Don't fetch during active order collection — it's just detail gathering
  if (orderState === 'collecting_details' || orderState === 'confirming') {
    return { needed: false, search: null };
  }

  const m = message.toLowerCase();

  // Generic product/catalog queries
  const genericPatterns = [
    /\b(what.*you have|what.*you got|what.*you sell|your products|your catalog|your items|price list|send.*catalog|show.*products|show.*items|wetin.*you get|watin.*you get|what.*in stock|see.*products)\b/,
    /\b(catalog|inventory|list|browse)\b/,
  ];
  if (genericPatterns.some(p => p.test(m))) {
    return { needed: true, search: null }; // full catalog
  }

  // Specific category or product search
  const specificPatterns = [
    /(?:show me|you have|do you have|got any|any|see|find)\s+(?:the\s+|some\s+)?([a-z][a-z0-9 ]{1,30}?)(?:\?|$|\.|please)/i,
    /(?:how much is|price of|cost of|how much for)\s+(?:the\s+)?([a-z][a-z0-9 ]{1,30}?)(?:\?|$|\.)/i,
    /(?:picture|photo|image)s?\s+(?:of\s+)?(?:the\s+)?([a-z][a-z0-9 ]{1,30}?)(?:\?|$|\.)/i,
  ];
  const skipTerms = /^(me|your|the|a|an|any|some|picture|photo|image|catalog|products|items|stuff|price|prices)$/i;

  for (const p of specificPatterns) {
    const match = message.match(p);
    if (match?.[1] && !skipTerms.test(match[1].trim())) {
      return { needed: true, search: match[1].trim() };
    }
  }

  // Price/availability/stock questions
  if (/\b(price|cost|how much|available|in stock|e dey|do you have|you get)\b/.test(m)) {
    return { needed: true, search: null };
  }

  // Picture requests (use context for search term)
  if (/\b(picture|photo|image|pic)\b/.test(m)) {
    const lastProduct = extractLastProduct(conversationHistory);
    return { needed: true, search: lastProduct };
  }

  return { needed: false, search: null };
}

/** Format products as readable text for prompt injection */
function formatProductsForPrompt(products) {
  return products.slice(0, 20).map((p, i) => {
    const { line } = priceStock(p);
    return `${i + 1}. ${p.name} – ${line}`;
  }).join('\n');
}

/** Format price and stock for one product */
function priceStock(p) {
  if (p.variations?.length) {
    let min = null, total = 0;
    for (const v of p.variations) {
      for (const o of (v.options || [])) {
        const n = parseFloat(o.price_adjustment || o.price);
        if (!isNaN(n) && (min === null || n < min)) min = n;
        if (o.stock != null) total += Number(o.stock);
      }
    }
    if (min !== null) return { line: `from ${fmtN(min)}${total > 0 ? ` (${total} in stock)` : ''}`, priceNum: min };
    return { line: 'multiple options', priceNum: 0 };
  }
  const price = parseFloat(p.price || 0);
  const stock = p.stock != null ? ` (${p.stock} in stock)` : '';
  return { line: `${fmtN(price)}${stock}`, priceNum: price };
}

/** Format Naira */
function fmtN(amount) {
  const n = Number(amount);
  if (isNaN(n)) return '₦0';
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Is this reply a placeholder that should be replaced by real data? */
function isPlaceholder(text) {
  return /^(on it|sure|ok|checking|let me|pulling|one sec|hold on|gimme|alright|yeah)/i.test((text || '').trim());
}

/**
 * Merge Gemini's intro with backend catalog data.
 *
 * Rules:
 * 1. If Gemini already has prices/products in its reply → it used the injected data → DON'T append (would duplicate)
 * 2. If Gemini wrote a short placeholder (1-2 lines, no prices) → append the real data
 * 3. If Gemini wrote a full multi-line reply without prices → trust it, don't append
 */
function mergeIntroAndData(geminiReply, dataText) {
  if (!geminiReply?.trim()) return dataText;
  if (!dataText?.trim())    return geminiReply;

  const reply = geminiReply.trim();

  // Gemini already wrote product data (has ₦ prices) — don't duplicate
  if (reply.includes('₦')) return reply;

  // Gemini already has a numbered list — don't duplicate
  if (/^\d+\.\s/m.test(reply)) return reply;

  // Gemini wrote a multi-line substantive reply — trust it
  if (reply.split('\n').length > 3) return reply;

  // Short intro or placeholder — append the catalog data below it
  return `${reply}\n\n${dataText.trim()}`;
}

/** Extract a product name from customer message */
function extractProductName(message) {
  if (!message) return null;
  const patterns = [
    /(?:price|cost|how much|available|in stock|do you have|show me|order|buy)\s+(?:of|for|is|the)?\s*(?:the\s+)?([A-Za-z0-9 ]{2,50}?)(?:\?|$|\.)/i,
    /(?:image|picture|photo)\s+of\s+(?:the\s+)?([A-Za-z0-9 ]{2,50}?)(?:\?|$|\.)/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m?.[1]?.trim().length > 1) return m[1].trim();
  }
  return null;
}

/** Get last product mentioned in conversation (for context-based requests) */
function extractLastProduct(history) {
  if (!Array.isArray(history)) return null;
  for (const msg of [...history].reverse().slice(0, 12)) {
    if (!msg.text) continue;
    // Numbered list item: "1. Air Max – ₦25,000"
    const list = msg.text.match(/\d+\.\s+([^–\-\n]{2,50}?)\s+[–\-]/);
    if (list?.[1]) return list[1].trim();
    // "Here you go" / "Here's the X" patterns
    if (msg.role === 'assistant') {
      const here = msg.text.match(/(?:here(?:'s| are the| you go)|sending the)\s+([^:\n.!]{2,50})/i);
      if (here?.[1]) return here[1].trim();
    }
    // User asked about a product
    if (msg.role === 'user') {
      const name = extractProductName(msg.text);
      if (name) return name;
    }
  }
  return null;
}

/** Extract payment reference from message */
function extractPaymentRef(message) {
  const patterns = [
    /(?:reference|ref|txn|payment)[:\s#]+([A-Z0-9]{5,})/i,
    /\b([A-Z]{2,}[0-9]{4,})\b/,
    /\b([0-9]{6,}[A-Z]{2,})\b/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Fire-and-forget send that never crashes the main flow */
async function safeSend(phoneNumberId, to, accessToken, text) {
  if (!accessToken || !phoneNumberId || !to) return;
  await whatsapp.sendMessage(phoneNumberId, accessToken, to, text)
    .catch(e => console.error('[safeSend]', e.message));
}

module.exports = { processMessage };
