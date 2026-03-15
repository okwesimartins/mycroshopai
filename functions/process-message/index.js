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
    quotedMessageId = null,
    incomingImage   = null,
    buttonReply     = null,   // store owner tapped Approve/Decline button
    // Payment configuration from merchant's store settings
    paymentInstructionType = null,
    paypalEmail            = null,
    bankAccountName        = null,
    bankName               = null,
    bankAccountNumber      = null,
    bankCode               = null,
    paymentInstructions    = null,
    ownerWhatsappNumber    = null,
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
    // For image messages, text might be empty — use caption if provided, or a placeholder
    // The image itself carries the content — Gemini will see it via Vision
    const captionText = incomingImage?.caption?.trim() || '';
    const msgText = (message || captionText || (incomingImage ? '[image]' : '')).trim();
    if (!msgText && !incomingImage) { log('skip', 'empty message'); return; }
    log('start', `tenant=${tenantId} customer=${customerPhone} msg="${msgText.substring(0, 80)}"`);

    // ── Parallelised setup reads ─────────────────────────────────────────
    // All three Firestore reads are independent — run simultaneously.
    // This saves ~300-500ms vs sequential awaits on every single message.
    const t0 = Date.now();
    const [isDuplicate, rawHistory, savedOrderState] = await Promise.all([
      // 1. Dedup — did we already process this message ID?
      (messageId && typeof firestore.hasProcessedMessage === 'function')
        ? firestore.hasProcessedMessage(tenantId, messageId).catch(() => false)
        : Promise.resolve(false),

      // 2. Conversation history (last 30 turns)
      typeof firestore.getConversationHistory === 'function'
        ? firestore.getConversationHistory(tenantId, customerPhone).catch(e => { logErr('history', e); return []; })
        : Promise.resolve([]),

      // 3. Active order state (for multi-turn ordering)
      typeof firestore.getOrderState === 'function'
        ? firestore.getOrderState(tenantId, customerPhone).catch(() => null)
        : Promise.resolve(null),
    ]);
    log('setup', `parallel Firestore reads: ${Date.now() - t0}ms`);

    if (isDuplicate) { log('dedup', 'already processed, skipping'); return; }

    // Mark message as read immediately — shows blue ticks to customer
    whatsapp.markAsRead(phoneNumberId, accessToken, messageId).catch(() => {});

    // ── Store owner button reply (Approve / Decline) ─────────────────────
    // When the store owner taps a button on the receipt notification,
    // handle it here and do NOT run the normal AI flow.
    if (buttonReply) {
      await handleOwnerButtonReply({
        buttonReply, tenantId, phoneNumberId, accessToken,
      });
      return;
    }

    // Download incoming image — could be a receipt OR a product screenshot
    // Decision is made AFTER we know the order state
    let incomingImageData = null;
    if (incomingImage?.mediaId) {
      log('image', `Customer sent image — downloading media ${incomingImage.mediaId}`);
      incomingImageData = await whatsapp.downloadMedia(incomingImage.mediaId, accessToken)
        .catch(e => { logErr('downloadMedia', e); return null; });
      if (incomingImageData) {
        log('image', `Downloaded ${incomingImageData.mimeType}, ${incomingImageData.base64.length} chars`);
      }
    }

    // Contact limit — only matters for brand new customers (first message ever)
    const isNewCustomer = rawHistory.length === 0;
    if (isNewCustomer && typeof firestore.checkContactLimit === 'function') {
      const limit = await firestore.checkContactLimit(tenantId).catch(() => ({ reached: false }));
      if (limit.reached) {
        await safeSend(phoneNumberId, customerPhone, accessToken,
          `Sorry, this store has reached its contact limit. Please reach out to the merchant directly.`);
        return;
      }
    }

    // Track contact — fire-and-forget, never block the main flow
    firestore.trackContact?.(tenantId, customerPhone).catch(() => {});

    // Sanitise history — strip raw JSON from model turns (old bug: prevents Gemini mirroring format)
    const conversationHistory = rawHistory.map(msg => {
      if (msg.role !== 'user' && typeof msg.text === 'string' && msg.text.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(msg.text);
          if (parsed.reply && typeof parsed.reply === 'string') return { ...msg, text: parsed.reply };
        } catch (_) {
          const m = msg.text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) { try { return { ...msg, text: JSON.parse('"' + m[1] + '"') }; } catch (_2) {} }
        }
      }
      return msg;
    });

    let orderState   = 'idle';
    let pendingOrder = null;
    if (savedOrderState) { orderState = savedOrderState.state || 'idle'; pendingOrder = savedOrderState.pending_order || null; }
    // If in pending_approval state and customer sends any text, reassure them
    if (orderState === 'pending_approval' && !incomingImageData) {
      const orderNum = pendingOrder?.order_number || '';
      await safeSend(phoneNumberId, customerPhone, accessToken,
        `Your receipt for Order ${orderNum} has been received and is being reviewed by the store. ` +
        `You'll get a notification here as soon as it's confirmed. Thank you for your patience! 🙏`
      );
      return;
    }

    // ── Receipt intercept ────────────────────────────────────────────────
    // Fires when customer sends an image that is a payment receipt.
    //
    // PRIMARY trigger: state = awaiting_payment + has an order_id in Firestore.
    // SECONDARY trigger: customer quoted a specific order confirmation message.
    //   This handles the multi-order case — customer scrolls back to a specific
    //   order confirmation and replies to it with their receipt. We look up the
    //   exact order_id from the quoted message ID, bypassing Firestore state entirely.
    //
    // This means receipts are always attached to the RIGHT order, even when:
    //   - Customer has multiple pending orders simultaneously
    //   - Firestore state was overwritten by a newer order
    //   - Customer's state is pending_approval for one order but they're paying for another

    const isReceiptByState  = orderState === 'awaiting_payment' && incomingImageData && pendingOrder?.order_id;
    const isReceiptByQuote  = incomingImageData && quotedMessageId; // resolve order from quoted msg
    const isReceiptMessage  = isReceiptByState || isReceiptByQuote;

    if (isReceiptMessage) {
      // For quote-based receipts, we may not have pendingOrder yet — create a minimal placeholder
      const receiptPendingOrder = pendingOrder || { order_id: null };

      await handleReceiptSubmission({
        tenantId, customerPhone, phoneNumberId, accessToken,
        pendingOrder: receiptPendingOrder, incomingImageData, incomingImage,
        ownerWhatsappNumber, storeNameResolved,
        quotedMessageId,
      });

      // Update Firestore state — only if we resolved an order_id
      if (isReceiptByState) {
        firestore.saveOrderState?.(tenantId, customerPhone, {
          state: 'pending_approval',
          pending_order: pendingOrder,
        }).catch(() => {});
      }
      return;
    }

        // ── PRE-FETCH product data ───────────────────────────────────────────
    // Give Gemini REAL product data BEFORE it writes its reply.
    // KEY RULE: If customer says "can I see a picture" after mentioning a specific product,
    // we fetch ONLY that product — not the whole catalog. Prevents catalog dumping.
    let inventoryText = null;
    let prefetchedProducts = null; // cached from pre-fetch — passed to action handlers to avoid double backend calls
    let forcedProductName = null;
    // For incoming images, always pre-fetch the full catalog so Gemini can match the photo to a product
    const inventoryIntent = incomingImageData
      ? { needed: true, search: null, isImageSearch: true }
      : detectInventoryIntent(msgText, conversationHistory, orderState);

    if (inventoryIntent.needed) {
      try {
        // If this is a contextual picture request (customer already said what they want),
        // fetch ONLY that specific product so Gemini doesn't have 16 products to pick from
        const searchTerm = inventoryIntent.search || undefined;
        const limit = searchTerm ? 5 : 20;

        const result = await backendApi.listProducts(tenantId, subscriptionPlan, { search: searchTerm, limit });

        if (result?.products?.length) {
          // For contextual requests (picture of X), inject only the matched product
          const products = inventoryIntent.contextual && result.products.length > 1
            ? result.products.slice(0, 1)  // just the top match
            : result.products;

          inventoryText = formatProductsForPrompt(products);
          prefetchedProducts = products; // cache — action handlers will use this, not re-fetch
          if (inventoryIntent.contextual) {
            forcedProductName = products[0]?.name || searchTerm;
          }
          log('preload', `${products.length} products injected (search: ${searchTerm || 'all'}, contextual: ${!!inventoryIntent.contextual})`);
        } else {
          inventoryText = '[No products found in catalog right now]';
          log('preload', 'no products found');
        }
      } catch (e) {
        logErr('preload', e); // non-fatal — Gemini still responds
      }
    }

    // ── Call Gemini ──────────────────────────────────────────────────────
    // For contextual picture requests, tell Gemini exactly what to do
    let inventoryMeta = null;
    if (inventoryIntent.contextual && forcedProductName) {
      inventoryMeta = `INSTRUCTION: Customer is asking to see a picture of "${forcedProductName}" based on earlier conversation. Emit query_inventory with product_name="${forcedProductName}" and share_media:true. Do NOT use list_inventory. Do NOT send the whole catalog.`;
    } else if (inventoryIntent.colorHint) {
      inventoryMeta = `CONTEXT: Customer wants "${inventoryIntent.colorHint}" color/variant. Check the product variations for this color option and highlight it in your reply. If found, mention it specifically. If not found, suggest the closest available colors.`;
    }

    // If customer explicitly asked for variations in the same message (e.g. "show me sneakers and the variations"),
    // tell Gemini to always emit show_variations — don't leave it to chance
    if (inventoryIntent.wantsVariations && inventoryIntent.search) {
      const varNote = `\nINSTRUCTION: Customer also explicitly asked to see the variations/options. Always emit show_variations action for ${inventoryIntent.search} in your response.`;
      inventoryMeta = (inventoryMeta || '') + varNote;
    }

    // Image search — customer sent a photo, Gemini will identify the product via Vision
    if (inventoryIntent.isImageSearch) {
      inventoryMeta = (inventoryMeta ? inventoryMeta + '\n' : '') +
        'INSTRUCTION: Customer has sent a photo. Identify the product in the image and match it to the catalog below. ' +
        'If matched: show that product with query_inventory + show_variations. ' +
        'If unsure: ask "Is this [your best guess]?" and emit query_inventory for that product.';
    }

    // Resolve quoted message — when customer replies to a specific message ("I want this")
    // WhatsApp sends context.id with the quoted message ID. We find its content from history.
    let quotedContext = null;
    if (quotedMessageId && conversationHistory.length > 0) {
      // Find the most recent assistant message — that's almost certainly what they quoted
      const recentAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');
      if (recentAssistant?.text) {
        quotedContext = `[CUSTOMER IS REPLYING TO THIS SPECIFIC MESSAGE: "${recentAssistant.text.substring(0, 300)}"]`;
        log('quoted', `Resolved quoted msg → "${recentAssistant.text.substring(0, 80)}"`);
      }
    }

    const aiResponse = await ai.processMessage(msgText, {
      tenant_id:            tenantId,
      subscription_plan:    subscriptionPlan,
      customer_phone:       customerPhone,
      store_name:           storeNameResolved,
      business_bio:         businessBio || null,
      conversation_history: conversationHistory,
      order_state:          orderState,
      pending_order:        pendingOrder,
      inventory_meta:       inventoryMeta,
      quoted_context:       quotedContext,
      incomingImage:        incomingImageData,  // base64 image for Gemini Vision
    }, inventoryText).catch(e => { logErr('gemini', e); throw e; });

    log('gemini', `reply="${aiResponse.text?.substring(0, 80)}" actions=[${aiResponse.actions?.map(a=>a.type).join(',')||'none'}]`);

    // ── Execute actions ──────────────────────────────────────────────────
    let finalReply    = aiResponse.text || '';
    let newOrderState = aiResponse.order_state || orderState;
    let newPending    = pendingOrder;
    let pendingImages = []; // images to send AFTER the text reply

    // Safety net: if Gemini emits list_inventory with share_media for a contextual picture request,
    // convert it to query_inventory for the specific product so we don't dump the whole catalog
    let actionsToRun = aiResponse.actions || [];
    if (inventoryIntent.contextual && forcedProductName) {
      actionsToRun = actionsToRun.map(a => {
        if (a.type === 'list_inventory' && a.share_media) {
          log('ctx-override', `Converting list_inventory→query_inventory for contextual picture: ${forcedProductName}`);
          return { ...a, type: 'query_inventory', intent: 'availability', product_name: forcedProductName, share_media: true };
        }
        return a;
      });
    }

    for (const action of actionsToRun) {
      const result = await handleAction(action, {
        tenantId, subscriptionPlan, defaultOnlineStoreId,
        message: msgText, conversationHistory, customerPhone,
        accessToken, phoneNumberId, pendingOrder,
        aiResponse,
        prefetchedProducts,
        // Payment config — needed by handleOrderCreation
        paymentInstructionType, paypalEmail,
        bankAccountName, bankName, bankAccountNumber, bankCode,
        paymentInstructions,
      });

      if (!result) continue;

      if (result.type === 'order_pending') {
        // Partial order — save collected data, Gemini's collecting-details reply stays
        newPending    = result.pending_order;
        newOrderState = 'collecting_details';

      } else if (result.type === 'replace') {
        finalReply = result.text || finalReply;
        if (result.new_order_state)   newOrderState = result.new_order_state;
        if (result.new_pending_order) newPending    = result.new_pending_order;
        // Order confirmation is the final word — stop processing other actions.
        // Prevents Gemini's co-emitted list_inventory from dumping random product images.
        if (result.new_order_state === 'awaiting_payment') break;

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
      } else if (result.type === 'catalog_media') {
        // Catalog with images — Gemini's intro text is the reply, images come after
        if (result.images?.length) {
          pendingImages.push(...result.images);
        }

      } else if (result.type === 'product_card') {
        // Product query: merge variation text into reply, queue images to send after text
        if (result.variationsText) {
          if (!finalReply.includes('•') && !finalReply.includes('Which works')) {
            finalReply = finalReply.trimEnd() + '\n\n' + result.variationsText;
          }
        }
        // result.images is now an array of { url, caption } — one per colour variant
        if (result.images?.length) {
          pendingImages.push(...result.images);
        }

      } else if (result.type === 'noop') {
        // Action completed (e.g. images sent) but no text change needed — leave finalReply as-is
      }
    }

    // ── Final cleanup ────────────────────────────────────────────────────
    finalReply = (finalReply || '')
      .replace(/\b(list_inventory|query_inventory|create_order|check_payment|show_variations)\b/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      // Remove exclamation marks — they read as robotic/bot-like, not human
      // Exception: emoji sequences and order confirmations (✅) are fine
      // Replace "word!" with "word." and "word! " with "word. " naturally
      .replace(/([a-zA-Z0-9])!(?=[^!]|$)/g, (_, c) => c + '.')
      .replace(/\.{2,}/g, '.')   // "word.." → "word."
      .trim();

    // If Gemini returned empty reply (JSON parse failed and no rescue), use a safe default
    if (!finalReply || !finalReply.trim()) {
      finalReply = 'Give me a sec on that.';
    }

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

    // ── Persist history BEFORE sending ──────────────────────────────────
    // Save both turns so follow-up messages always read correct history.
    // Each individual save catches its own error — Promise.all will never reject.
    await Promise.all([
      typeof firestore.saveMessage === 'function'
        ? firestore.saveMessage(tenantId, customerPhone, 'user',      msgText,    messageId).catch(e => logErr('saveUser', e))
        : Promise.resolve(),
      typeof firestore.saveMessage === 'function'
        ? firestore.saveMessage(tenantId, customerPhone, 'assistant', finalReply).catch(e => logErr('saveAI', e))
        : Promise.resolve(),
    ]).catch(() => {}); // outer catch — absolutely never let a save failure kill the send

    // ── Send to customer ─────────────────────────────────────────────────
    // TEXT FIRST — customer reads full context (price, variations, question)
    // Capture the returned message ID — needed to link order confirmations to orders.
    const sendResult = await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone, finalReply, messageId)
      .catch(e => { logErr('send', e); throw e; });

    // If this was an order confirmation (state just moved to awaiting_payment),
    // record the link between the WhatsApp message ID and the order.
    // This lets us resolve the exact order when customer replies with their receipt.
    if (newOrderState === 'awaiting_payment' && newPending?.order_id && sendResult?.messageId) {
      backendApi.recordConfirmationMessage(tenantId, newPending.order_id, sendResult.messageId)
        .catch(e => console.error('[pm] recordConfirmationMessage failed:', e.message)); // fire-and-forget
      log('order', `Confirmation msg ${sendResult.messageId} linked to order ${newPending.order_id}`);
    }

    // IMAGES AFTER TEXT — loads after customer has already read the context
    // Parallel send for multiple images
    if (pendingImages.length > 0) {
      await Promise.all(pendingImages.map(img =>
        whatsapp.sendImage(phoneNumberId, accessToken, customerPhone, img.url, img.caption)
          .catch(e => logErr('sendImage', e))
      ));
    }

    // ── Remaining writes — fire and forget ───────────────────────────────
    // Order state and dedup are less time-sensitive — fine to write in background.
    Promise.all([
      typeof firestore.saveOrderState === 'function'
        ? firestore.saveOrderState(tenantId, customerPhone, { state: newOrderState, pending_order: newPending }).catch(() => {})
        : null,
      messageId && typeof firestore.markMessageProcessed === 'function'
        ? firestore.markMessageProcessed(tenantId, messageId).catch(() => {})
        : null,
    ].filter(Boolean)).catch(() => {});

  } catch (err) {
    logErr('FATAL', err);
    await safeSend(phoneNumberId, customerPhone, accessToken,
      'Sorry, something went wrong. Try again in a moment.').catch(() => {});
  }
}

// ── Receipt submission ────────────────────────────────────────────────────────
// Called when customer is in 'awaiting_payment' state and sends an image.
// Attaches the receipt to the order, then notifies the store owner with approve/decline buttons.
async function handleReceiptSubmission({
  tenantId, customerPhone, phoneNumberId, accessToken,
  pendingOrder, incomingImageData, incomingImage,
  ownerWhatsappNumber, storeNameResolved, quotedMessageId,
}) {
  const log = (tag, ...a) => console.log(`[receipt:${tag}]`, ...a);

  // ── Resolve exact order_id ───────────────────────────────────────────
  // Priority 1 (most reliable): customer quoted a specific order confirmation message.
  //   → call GET by-confirmation-message to get the exact order_id.
  //   → This is the ONLY reliable way when a customer has multiple pending orders.
  //
  // Priority 2 (fallback): use the order_id stored in Firestore pendingOrder.
  //   → Used when customer just sends an image without quoting (single pending order case).
  //
  // Priority 3: try GET pending-by-phone as a last resort.
  let orderId     = pendingOrder.order_id || null;
  let orderNumber = pendingOrder.order_number || (orderId ? `#${orderId}` : null);

  if (quotedMessageId) {
    log('resolve', `Resolving order from quoted msg ${quotedMessageId}`);
    const resolvedId = await backendApi.getOrderByConfirmationMessage(tenantId, quotedMessageId)
      .catch(e => { console.error('[receipt] getOrderByConfirmationMessage failed:', e.message); return null; });

    if (resolvedId) {
      if (resolvedId !== orderId) {
        log('resolve', `Quoted msg → order ${resolvedId} (overrides Firestore order ${orderId})`);
      } else {
        log('resolve', `Quoted msg confirms Firestore order ${orderId}`);
      }
      orderId = resolvedId;
      orderNumber = `#${orderId}`;
    } else {
      log('resolve', `Quoted msg not in DB — falling back to Firestore order ${orderId}`);
    }
  }

  // Last resort: if still no order_id, look up by phone
  if (!orderId) {
    log('resolve', 'No order_id from state or quote — trying pending-by-phone');
    const latestOrder = await backendApi.getPendingOrderByPhone(tenantId, customerPhone).catch(() => null);
    if (latestOrder?.id) {
      orderId     = latestOrder.id;
      orderNumber = latestOrder.order_number || `#${orderId}`;
      log('resolve', `Found pending order ${orderId} via phone lookup`);
    } else {
      log('resolve', 'No pending order found — cannot attach receipt');
      await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
        "I couldn't find a pending order to attach your receipt to. Please make sure you're replying to your order confirmation message, or contact the store directly.",
        null
      );
      return;
    }
  }

  // 1. Attach the receipt to the order in the backend
  log('attach', `order ${orderId}`);
  const attached = await backendApi.attachOrderReceipt(tenantId, orderId, {
    receipt_image_base64: incomingImageData.base64,
    mime_type:            incomingImageData.mimeType,
  }).catch(e => { console.error('[receipt] attachOrderReceipt failed:', e.message); return null; });

  if (!attached) {
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      "I couldn't process your receipt right now. Please try again or contact the store directly.",
      null
    );
    return;
  }
  log('attached', 'receipt saved to order');

  // 2. Tell customer their receipt was received
  await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
    `✅ Receipt received for Order ${orderNumber}!\n\nThe store is reviewing your payment and will confirm shortly. I'll let you know as soon as it's approved. 🙏`,
    null
  );

  // 3. Notify store owner — send receipt image + order summary + Approve/Decline buttons
  if (!ownerWhatsappNumber) {
    log('owner', 'no owner_whatsapp_number — skipping owner notification');
    return;
  }

  const ownerPhone = ownerWhatsappNumber.replace(/[+\s]/g, '');

  // Build a clear order summary for the owner
  const itemsSummary = (pendingOrder.items || [])
    .map(i => `• ${i.product_name}${i.quantity > 1 ? ` x${i.quantity}` : ''} — ${fmtN(i.unit_price || i.price || 0)}`)
    .join('\n');

  const ownerBody = [
    `💰 *Payment Receipt — ${storeNameResolved}*`,
    ``,
    `Order: *${orderNumber}*`,
    `Customer: ${pendingOrder.customer_name || 'Unknown'} (${customerPhone})`,
    `Address: ${pendingOrder.shipping_address || 'N/A'}`,
    ``,
    itemsSummary || '(no items)',
    ``,
    pendingOrder.total ? `Total: *${pendingOrder.total}*` : '',
    ``,
    `Customer has sent a payment receipt. Approve or decline below.`,
  ].filter(l => l !== undefined).join('\n');

  // Send the receipt image to the owner first
  const imageUrl = null; // We have base64 but not a URL — send as caption approach
  // Build a short image-not-available fallback if we can't forward the image directly
  // (WhatsApp Cloud API can't forward base64 images — they need a public URL)
  // The receipt IS attached to the order on the backend; owner can view it in the dashboard.
  // We notify them with text + buttons, and the receipt is in their dashboard.
  log('owner', `Sending approval request to ${ownerPhone}`);

  // Encode customer phone into button IDs so we can look them up when owner replies
  const btnApprove = `approve_${orderId}_${customerPhone}`;
  const btnDecline = `decline_${orderId}_${customerPhone}`;

  await whatsapp.sendInteractiveButtons(
    phoneNumberId, accessToken, ownerPhone,
    ownerBody,
    [
      { id: btnApprove, title: '✅ Approve' },
      { id: btnDecline, title: '❌ Decline' },
    ],
    `Order ${orderNumber}`,
    `Reply within 24hrs • ${storeNameResolved}`
  ).catch(e => console.error('[receipt] owner notification failed:', e.message));

  log('owner', 'notification sent');
}

// ── Owner button reply handler ─────────────────────────────────────────────────
// Called at the TOP of processMessage when a buttonReply is detected.
// The store owner tapped Approve or Decline on the receipt notification.
async function handleOwnerButtonReply({ buttonReply, tenantId, phoneNumberId, accessToken }) {
  const log = (tag, ...a) => console.log(`[owner-btn:${tag}]`, ...a);

  // Button ID format: "approve_{orderId}_{customerPhone}" or "decline_{orderId}_{customerPhone}"
  const parts = (buttonReply.id || '').split('_');
  if (parts.length < 3) {
    log('skip', `Unrecognised button id: ${buttonReply.id}`);
    return;
  }

  const action       = parts[0];          // 'approve' or 'decline'
  const orderId      = parseInt(parts[1], 10);
  const customerPhone = parts.slice(2).join('_'); // phone may contain underscores

  if (!['approve', 'decline'].includes(action) || !orderId) {
    log('skip', `Invalid action/orderId: ${action} / ${orderId}`);
    return;
  }

  log('action', `${action} order ${orderId} for customer ${customerPhone}`);

  // 1. Call the backend confirm endpoint
  let confirmResult;
  try {
    confirmResult = await backendApi.confirmOrderPayment(tenantId, orderId, action);
  } catch (e) {
    console.error('[owner-btn] confirmOrderPayment failed:', e.message);
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      `Couldn't ${action} the order right now. Please try again from your dashboard.`, null
    ).catch(() => {});
    return;
  }

  // 2. Notify customer of the outcome
  let customerMsg;
  if (action === 'approve') {
    customerMsg = [
      `🎉 Great news! Your payment has been confirmed.`,
      ``,
      `Order *${confirmResult.order?.order_number || `#${orderId}`}* is now being processed.`,
      `We'll prepare your order and reach out with delivery updates. Thank you! 🙏`,
    ].join('\n');
  } else {
    customerMsg = [
      `Hi, regarding your Order *#${orderId}*:`,
      ``,
      `Unfortunately we couldn't verify your payment receipt. This could be because:`,
      `• The receipt was unclear or incomplete`,
      `• The payment amount didn't match`,
      ``,
      `Please resend a clear photo of your payment receipt, or contact us directly for help.`,
    ].join('\n');
  }

  await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone, customerMsg, null)
    .catch(e => console.error('[owner-btn] customer notify failed:', e.message));

  // 3. Update order state in Firestore
  // On approve: order is done — clear the pending state
  // On decline: go back to awaiting_payment so customer can resubmit
  // We need firestore here — load it from the outer scope module
  const newState = action === 'approve' ? 'complete' : 'awaiting_payment';
  // Note: we pass customerPhone here — Firestore uses this as the document key
  // We don't have pendingOrder here so just update the state field
  firestore.saveOrderState?.(tenantId, customerPhone, {
    state: newState,
    pending_order: action === 'decline'
      ? { order_id: orderId, order_number: confirmResult.order?.order_number }
      : null,
  }).catch(() => {});

  log('done', `Customer notified, state → ${newState}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Action Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleAction(action, ctx) {
  const { tenantId, subscriptionPlan, defaultOnlineStoreId,
          message, conversationHistory, customerPhone,
          accessToken, phoneNumberId, pendingOrder,
          aiResponse, prefetchedProducts,
          paymentInstructionType, paypalEmail,
          bankAccountName, bankName, bankAccountNumber, bankCode,
          paymentInstructions } = ctx;
  try {
    switch (action.type) {
      case 'list_inventory':
        return await handleListInventory({
          tenantId, subscriptionPlan,
          search:      action.search      ?? null,
          share_media: action.share_media === true,
          accessToken, phoneNumberId, customerPhone, conversationHistory,
          prefetchedProducts, // use cached data if available
        });

      case 'query_inventory':
        return await handleQueryInventory({
          tenantId, subscriptionPlan,
          productName:      action.product_name || extractProductName(message),
          intent:           action.intent,
          share_media:      action.share_media !== false,
          optionRequested:  action.option_requested || null, // specific variant customer asked for
          accessToken, phoneNumberId, customerPhone,
          prefetchedProducts,
        });

      case 'show_variations': {
        const varProductName = action.product_name || extractLastProduct(conversationHistory);
        // Skip if query_inventory already ran for this same product this turn
        const queryRanForSameProduct = (aiResponse?.actions || []).some(a =>
          a.type === 'query_inventory' &&
          (a.product_name || '').toLowerCase() === (varProductName || '').toLowerCase()
        );
        return await handleShowVariations(
          tenantId, subscriptionPlan,
          varProductName,
          queryRanForSameProduct,
          prefetchedProducts, // avoid re-fetch
        );
      }

      case 'create_order':
        return await handleOrderCreation({
          tenantId, subscriptionPlan, defaultOnlineStoreId,
          message, conversationHistory, customerPhone,
          orderDataFromGemini: action.order_data || null,
          pendingOrder,
          paymentInstructionType, paypalEmail,
          bankAccountName, bankName, bankAccountNumber, bankCode,
          paymentInstructions,
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
    accessToken, phoneNumberId, customerPhone, conversationHistory, prefetchedProducts }) {

  // Use pre-fetched products if available (same search term already loaded before Gemini call)
  // This avoids a duplicate backend call — saves ~200-500ms
  let products;
  if (prefetchedProducts?.length) {
    products = prefetchedProducts;
    console.log(`[listInventory] using ${products.length} pre-fetched products (no backend call)`);
  } else {
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
    products = result.products;
  }
  const base = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');

  // Build readable catalog text
  let text = '';
  products.forEach((p, i) => {
    const { line } = priceStock(p);
    text += `${i + 1}. ${p.name} – ${line}\n`;
  });
  if (products.length > 1) text += '\nWhich one are you interested in?';

  if (share_media) {
    // Return image URLs to the main flow — images sent AFTER text, not before
    // Use priority: variant image → variation-option image → product image
    const imgs = products
      .map(p => ({ url: pickProductImageUrl(p, base), p }))
      .filter(x => x.url)
      .slice(0, 5)
      .map(x => ({ url: x.url, caption: `${x.p.name} – ${priceStock(x.p).line}` }));
    return { type: 'catalog_media', images: imgs };
  }

  return { type: 'data', text: text.trim() };
}

// ── Query specific product ────────────────────────────────────────────────────
async function handleQueryInventory({ tenantId, subscriptionPlan, productName, intent,
    share_media = true, optionRequested = null, accessToken, phoneNumberId, customerPhone, prefetchedProducts }) {

  if (!productName) {
    console.warn('[queryInventory] called with no product_name — skipping action, using Gemini reply');
    return null;
  }

  const base  = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');

  // Use pre-fetched products first — find the best match by name
  // This avoids checkProduct + listProducts calls (saves ~400-800ms)
  let product = null;
  if (prefetchedProducts?.length) {
    product = prefetchedProducts.find(p =>
      p.name?.toLowerCase() === productName.toLowerCase()
    ) || prefetchedProducts.find(p =>
      p.name?.toLowerCase().includes(productName.toLowerCase())
    ) || prefetchedProducts.find(p =>
      productName.toLowerCase().includes(p.name?.toLowerCase())
    ) || (prefetchedProducts.length === 1 ? prefetchedProducts[0] : null);

    if (product) {
      console.log(`[queryInventory] using pre-fetched product: ${product.name} (no backend call)`);
    }
  }

  // Only hit backend if pre-fetch didn't have a match
  if (!product) {
    try {
      const checkResult = await backendApi.checkProduct(tenantId, productName, subscriptionPlan);
      if (checkResult?.exists && checkResult.product) {
        product = checkResult.product;
      }
    } catch (e) {
      console.warn('[queryInventory] checkProduct error:', e.message);
    }
  }

  if (!product) {
    try {
      const searchResult = await backendApi.listProducts(tenantId, subscriptionPlan, { search: productName, limit: 5 });
      if (searchResult?.products?.length) {
        product = searchResult.products.find(p =>
          p.name?.toLowerCase() === productName.toLowerCase()
        ) || searchResult.products.find(p =>
          p.name?.toLowerCase().includes(productName.toLowerCase())
        ) || searchResult.products[0];
      }
    } catch (e) {
      console.error('[queryInventory] listProducts fallback failed:', e.message);
    }
  }

  if (!product) {
    try {
      const broad = await backendApi.listProducts(tenantId, subscriptionPlan, {
        search: productName.split(' ')[0], limit: 5
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

  const hasVariants   = product.variants?.length > 0;
  const hasVariations = product.variations?.length > 0;

  // Display price: variants have absolute prices → use min variant price
  // variations-only → use min price_adjustment; simple product → use product.price
  const { line: priceStr, stockInfo } = buildPriceStockDisplay(product);

  // Build options/variants text — grouped for readability
  const variationsText = buildVariationsText(product);

  if (!share_media) {
    return { type: 'product_card', images: [], variationsText: variationsText || null };
  }

  const isValidUrl = u => u && !u.startsWith('data:') && u.startsWith('http');
  const imagesToSend = [];

  // normalise optionRequested for case-insensitive matching
  const reqOpt = optionRequested?.trim().toLowerCase() || null;

  // Helper: does an option value match what was requested?
  const matchesRequest = o => {
    if (!reqOpt) return true; // no filter — include everything
    const val = (o.option_display_name || o.option_value || '').toLowerCase();
    return val === reqOpt || val.includes(reqOpt) || reqOpt.includes(val);
  };

  if (hasVariants && product.variants.length) {
    // Product has explicit SKU combos (e.g. Nike Black+42, Nike White+44)
    // If a specific option was requested, only show images for matching variants.
    // If no specific option was requested, show one image per primary-option group.

    if (reqOpt) {
      // Filter to variants that contain the requested option in ANY dimension
      const matched = product.variants.filter(v =>
        v.options.some(o => matchesRequest(o))
      );
      const src = matched.length ? matched : product.variants; // fallback to all if nothing matched

      // Collect distinct image URLs from matching variants, prefer variation-option images
      const seenUrl = new Set();
      for (const v of src) {
        // Find the variation-group image for the requested option if possible
        let imgUrl = null;
        for (const opt of v.options) {
          if (!matchesRequest(opt)) continue;
          // Look up the variation option that has an image
          for (const vg of (product.variations || [])) {
            const vo = vg.options?.find(x =>
              (x.option_display_name || x.option_value)?.toLowerCase() === (opt.option_display_name || opt.option_value)?.toLowerCase()
            );
            if (vo && isValidUrl(vo.image_url)) { imgUrl = vo.image_url; break; }
          }
          if (imgUrl) break;
        }
        if (!imgUrl) imgUrl = pickProductImageUrl(product, base);
        if (!imgUrl || seenUrl.has(imgUrl)) continue;
        seenUrl.add(imgUrl);

        const label = v.options.map(o => o.option_display_name || o.option_value).join(' / ');
        const vPrice = v.price ? ` — ${fmtN(v.price)}` : '';
        const vStock = v.stock != null ? ` (${v.stock} left)` : '';
        imagesToSend.push({ url: imgUrl, caption: `${product.name} — ${label}${vPrice}${vStock}` });
        if (imagesToSend.length >= 5) break;
      }
    } else {
      // No specific option requested — one image per primary-option group (e.g. one per colour)
      const primaryVariation = product.variations?.[0]; // first variation group = primary
      const seenPrimary = new Set();
      for (const v of product.variants) {
        const primary = v.options?.[0]?.option_display_name || v.options?.[0]?.option_value || '';
        if (seenPrimary.has(primary)) continue;
        seenPrimary.add(primary);

        // Image: check primary variation-option first, then product image
        const primaryOpt = primaryVariation?.options?.find(o =>
          (o.option_display_name || o.option_value) === primary
        );
        const imgUrl = isValidUrl(primaryOpt?.image_url)
          ? primaryOpt.image_url
          : pickProductImageUrl(product, base);
        if (!imgUrl) continue;

        const siblingLabels = product.variants
          .filter(x => (x.options?.[0]?.option_display_name || x.options?.[0]?.option_value) === primary)
          .map(x => x.options.slice(1).map(o => o.option_display_name || o.option_value).join('+'))
          .filter(Boolean).join(' / ');
        const caption = siblingLabels
          ? `${product.name} — ${primary} | ${siblingLabels} | ${priceStr}`
          : `${product.name} — ${primary} | ${priceStr}`;
        imagesToSend.push({ url: imgUrl, caption });
        if (imagesToSend.length >= 5) break;
      }
    }

  } else if (hasVariations) {
    // Product has variation option groups but no explicit SKU combos
    // If a specific option was requested, send only that option's image.
    // Otherwise send images for all available options that have one.
    for (const vg of product.variations) {
      const opts = (vg.options || []).filter(o =>
        o.is_available !== false && isValidUrl(o.image_url) && matchesRequest(o)
      );
      for (const o of opts) {
        const optPrice = parseFloat(o.price_adjustment || o.price);
        const priceDisplay = !isNaN(optPrice) && optPrice > 0 ? ` — ${fmtN(optPrice)}` : '';
        const stockDisplay = o.stock != null ? ` (${o.stock} left)` : '';
        imagesToSend.push({
          url: o.image_url,
          caption: `${product.name} — ${o.option_display_name || o.option_value}${priceDisplay}${stockDisplay}`,
        });
        if (imagesToSend.length >= 5) break;
      }
      if (imagesToSend.length >= 5) break;
    }
    // Fall back to main product image if no variation-option images exist
    if (!imagesToSend.length) {
      const imgUrl = pickProductImageUrl(product, base);
      if (imgUrl) imagesToSend.push({
        url: imgUrl,
        caption: `${product.name} — ${priceStr}${stockInfo ? ` | ${stockInfo}` : ''}`,
      });
    }

  } else {
    // Simple product — one image
    const imgUrl = pickProductImageUrl(product, base);
    if (imgUrl) imagesToSend.push({
      url: imgUrl,
      caption: `${product.name} — ${priceStr}${stockInfo ? ` | ${stockInfo}` : ''}`,
    });
  }

  return {
    type: 'product_card',
    images: imagesToSend,
    variationsText: variationsText || null,
  };
}

// ── Show variations ───────────────────────────────────────────────────────────
async function handleShowVariations(tenantId, subscriptionPlan, productName, skipIfAlreadyInReply = false, prefetchedProducts = null) {
  if (!productName) return null;
  if (skipIfAlreadyInReply) return null;

  // Use pre-fetched product if available
  let p = null;
  if (prefetchedProducts?.length) {
    p = prefetchedProducts.find(x => x.name?.toLowerCase().includes(productName.toLowerCase()))
      || prefetchedProducts[0];
  }

  if (!p) {
    const result = await backendApi.listProducts(tenantId, subscriptionPlan, { search: productName, limit: 5 })
      .catch(e => { console.error('[showVariations] listProducts error:', e.message); return null; });
    if (!result?.products?.length) return null;
    p = result.products.find(x => x.name?.toLowerCase().includes(productName.toLowerCase()))
      || result.products[0];
  }

  if (!p.variants?.length && !p.variations?.length) return null;

  const text = buildVariationsText(p);
  if (!text) return null;
  return { type: 'soft_replace', text };
}

// ── Order creation ────────────────────────────────────────────────────────────
async function handleOrderCreation({ tenantId, subscriptionPlan, defaultOnlineStoreId,
    message, conversationHistory, customerPhone, orderDataFromGemini, pendingOrder,
    paymentInstructionType, paypalEmail, bankAccountName, bankName,
    bankAccountNumber, bankCode, paymentInstructions }) {

  if (!defaultOnlineStoreId) {
    return { type: 'replace', text: "This store isn't set up for online orders yet. Reach out to the merchant directly." };
  }

  // Parse order details from Gemini's structured output or extract from conversation
  let details;
  if (orderDataFromGemini?.product_name) {
    details = {
      items: [{
        product_name: orderDataFromGemini.product_name,
        product_id:   orderDataFromGemini.product_id   || null,
        variant_id:   orderDataFromGemini.variant_id   || null,
        quantity:     orderDataFromGemini.quantity      || 1,
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

  if (!details) return { type: 'replace', text: "What would you like to order?" };

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

  // Validate each item and resolve product_id + variant_id
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
    // Resolve variant_id from SKU combos if customer specified one
    let resolvedVariantId = item.variant_id || null;
    if (!resolvedVariantId && item.option_requested && p.variants?.length) {
      const matched = p.variants.find(v =>
        v.options?.some(o =>
          (o.option_display_name || o.option_value)?.toLowerCase() === item.option_requested?.toLowerCase()
        )
      );
      if (matched) resolvedVariantId = matched.id;
    }
    const unitPrice = resolvedVariantId
      ? (p.variants?.find(v => v.id === resolvedVariantId)?.price ?? p.price)
      : p.price;
    validItems.push({
      product_id: p.id,
      variant_id: resolvedVariantId,
      product_name: p.name,
      quantity: qty,
      price: parseFloat(unitPrice) || 0,
    });
  }

  // Create the order
  const orderResult = await backendApi.createOrder(tenantId, {
    online_store_id: defaultOnlineStoreId,
    items: validItems,
    customer_info: {
      name:             details.customer_name    || 'WhatsApp Customer',
      email:            details.customer_email   || '',
      phone:            details.customer_phone   || customerPhone,
      shipping_address: details.shipping_address || '',
    },
  });

  if (!orderResult.success) {
    return { type: 'replace', text: "Ran into an issue placing the order. Give it another try or contact us directly." };
  }

  const o = orderResult.order;
  const orderId     = o?.id;
  const orderNumber = o?.order_number || `#${orderId}`;
  const total       = o?.total != null ? fmtN(o.total) : null;

  // Build payment instructions based on merchant's configured payment method
  const payInstructions = buildPaymentInstructions({
    paymentInstructionType, paypalEmail,
    bankAccountName, bankName, bankAccountNumber,
    paymentInstructions, total,
    paymentLink: orderResult.paymentLink,
  });

  // Compose the order confirmation + payment instruction message
  let itemsList = (o?.OnlineStoreOrderItems || validItems).map(i =>
    `• ${i.product_name}${i.quantity > 1 ? ` x${i.quantity}` : ''} — ${fmtN(i.unit_price || i.price)}`
  ).join('\n');

  let msg = `✅ Order placed!\n\nOrder ${orderNumber}\n${itemsList}`;
  if (total) msg += `\n\nTotal: *${total}*`;
  msg += `\n\n${payInstructions}`;
  msg += `\n\nOnce you've paid, *send me a photo of your receipt* and I'll notify the store right away. 📸`;

  return {
    type: 'replace',
    text: msg,
    // Save order_id so receipt handler knows which order to attach to
    new_order_state: 'awaiting_payment',
    new_pending_order: {
      ...(pendingOrder || {}),
      order_id:     orderId,
      order_number: orderNumber,
      total,
      items:        validItems,
      customer_name:   details.customer_name,
      customer_phone:  details.customer_phone || customerPhone,
      shipping_address: details.shipping_address,
    },
  };
}

/**
 * Build a human-readable payment instruction block based on merchant settings.
 */
function buildPaymentInstructions({ paymentInstructionType, paypalEmail, bankAccountName,
    bankName, bankAccountNumber, paymentInstructions, total, paymentLink }) {

  // Custom instructions from merchant take priority
  if (paymentInstructions?.trim()) {
    return `*Payment Instructions:*\n${paymentInstructions.trim()}`;
  }

  const type = (paymentInstructionType || '').toLowerCase();

  if (type === 'paystack' && paymentLink) {
    return `*Pay online:*\n${paymentLink}\n\nOr tap the link above to pay securely with your card.`;
  }

  if (type === 'paypal' && paypalEmail) {
    return `*Pay via PayPal:*\nSend ${total || 'the total amount'} to: *${paypalEmail}*\nUse "Goods & Services" and add the order number as reference.`;
  }

  if (type === 'bank_transfer' && bankAccountNumber) {
    let instr = `*Bank Transfer:*`;
    if (bankName)          instr += `\nBank: ${bankName}`;
    if (bankAccountName)   instr += `\nAccount Name: ${bankAccountName}`;
    if (bankAccountNumber) instr += `\nAccount Number: *${bankAccountNumber}*`;
    if (total)             instr += `\nAmount: *${total}*`;
    return instr;
  }

  if (paymentLink) {
    return `*Pay here:*\n${paymentLink}`;
  }

  return `Please send payment and share your receipt once done.`;
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
  // Key insight: strip color/attribute qualifiers before using as search term.
  // "sneakers touch of ash colors" → search "sneakers", note color=ash
  // "blue Air Force 1" → search "Air Force 1", note color=blue
  const colorWords = /\b(red|blue|green|black|white|grey|gray|ash|brown|pink|yellow|purple|orange|nude|beige|navy|cream|gold|silver|maroon|cyan|teal|olive|coral|mint|lavender|charcoal|khaki|tan|multicolor|multi)\b/gi;

  // Words that TERMINATE the product name — everything after these is not the product
  // e.g. "sneakers AND the variations" → stop at "and", searchTerm = "sneakers"
  const stopWords = /^(and|with|or|but|for|variations?|options?|sizes?|colors?|colours?|pictures?|photos?|images?|please|thanks?)$/i;
  // Words to skip entirely (articles, possessives that appear inside the product phrase)
  const skipTerms = /^(me|your|the|a|an|any|some|picture|photo|image|catalog|products|items|stuff|price|prices|touch|of|in|type|kind|style|color|colour|colors|colours)$/i;

  const specificPatterns = [
    /(?:can i see|show me|you have|do you have|got any|any|see|find|need|want|looking for)\s+(?:the\s+|some\s+|a\s+|your\s+)?([a-z][a-z0-9 ]{1,40}?)(?:\?|$|\.|please|,|\band\b)/i,
    /(?:how much is|price of|cost of|how much for)\s+(?:the\s+)?([a-z][a-z0-9 ]{1,40}?)(?:\?|$|\.)/i,
    /(?:picture|photo|image)s?\s+(?:of\s+)?(?:the\s+)?([a-z][a-z0-9 ]{1,40}?)(?:\?|$|\.)/i,
    /(?:i need|i want)\s+(?:the\s+|some\s+|a\s+)?([a-z][a-z0-9 ]{1,40}?)(?:\?|$|\.|,|please)/i,
  ];

  for (const p of specificPatterns) {
    const match = message.match(p);
    if (match?.[1]) {
      const raw = match[1].trim();
      // Strip color words first
      const decolored = raw.replace(colorWords, '').replace(/\s{2,}/g, ' ').trim();
      // Walk word by word — stop at the first stop word so "variations" never joins the search
      const words = [];
      for (const w of decolored.split(' ')) {
        if (stopWords.test(w)) break;
        if (!skipTerms.test(w)) words.push(w);
      }
      const searchTerm = words.join(' ').trim();

      if (searchTerm && searchTerm.length > 1) {
        const colorMatches = raw.match(colorWords);
        const colorHint = colorMatches ? colorMatches.join(', ') : null;
        // Flag if the message also explicitly asked for variations
        const wantsVariations = /\b(variation|option|size|color|colour)s?\b/i.test(message);
        return { needed: true, search: searchTerm, colorHint, wantsVariations };
      }
    }
  }

  // Price/availability/stock questions
  // Special case: "how much is the white" / "price of the black one"
  // The color IS the variation they're asking about — resolve product from history
  if (/\b(price|cost|how much|available|in stock|e dey|do you have|you get)\b/.test(m)) {
    const lastProduct = extractLastProduct(conversationHistory);
    // If asking about a color/variant with a known product in context, search that product
    const colorInQuery = message.match(colorWords);
    if (colorInQuery && lastProduct) {
      return { needed: true, search: lastProduct, colorHint: colorInQuery[0] };
    }
    return { needed: true, search: lastProduct || null };
  }

  // Picture requests — use conversation context to find what they mean
  if (/\b(picture|photo|image|pic)\b/.test(m)) {
    const lastProduct = extractLastProduct(conversationHistory);
    // If we know what product they're asking about from context,
    // return it as a targeted search so we only fetch that product
    // (not the whole catalog). Gemini will emit query_inventory, not list_inventory.
    return { needed: true, search: lastProduct, contextual: !!lastProduct };
  }

  return { needed: false, search: null };
}

/** Format products as readable text for prompt injection into Gemini */
function formatProductsForPrompt(products) {
  return products.slice(0, 20).map((p, i) => {
    const { line } = priceStock(p);
    let entry = `${i + 1}. ${p.name} – ${line}`;
    if (p.variants?.length) {
      // Compact grouped summary: "Black: 42/43 · White: 44/45"
      const summary = buildVariantSummary(p.variants);
      if (summary) entry += ` | ${summary}`;
    } else if (p.variations?.length) {
      // Show option group names only: "Color: Red/Blue · Size: 42/43"
      const parts = p.variations.map(v => {
        const opts = (v.options || []).filter(o => o.is_available !== false)
          .map(o => o.option_display_name || o.option_value).join('/');
        return v.variation_name ? `${v.variation_name}: ${opts}` : opts;
      }).filter(Boolean);
      if (parts.length) entry += ` | ${parts.join(' · ')}`;
    }
    return entry;
  }).join('\n');
}

/**
 * Build a compact variant summary for the Gemini prompt.
 * Groups variants by their first-option value (usually Color) and lists sizes.
 * e.g. "Black: 42, 43 · White: 44, 45"
 */
function buildVariantSummary(variants) {
  if (!variants?.length) return '';
  // Group by first option label
  const groups = {};
  for (const v of variants) {
    if (!v.options?.length) continue;
    const key   = v.options[0].option_display_name || v.options[0].option_value;
    const rest  = v.options.slice(1).map(o => o.option_display_name || o.option_value).join('+');
    const label = rest || `₦${v.price}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(label);
  }
  return Object.entries(groups).map(([k, vs]) => `${k}: ${vs.join('/')}`).join(' · ');
}

/**
 * buildPriceStockDisplay — returns { line, stockInfo } for a product card heading.
 * Uses variant prices when available (most accurate), falls back to variations/simple.
 */
function buildPriceStockDisplay(p) {
  if (p.variants?.length) {
    const prices = p.variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n));
    const total  = p.variants.reduce((s, v) => s + Number(v.stock || 0), 0);
    const min    = prices.length ? Math.min(...prices) : null;
    const max    = prices.length ? Math.max(...prices) : null;
    const priceStr = min !== null
      ? (min === max ? fmtN(min) : `from ${fmtN(min)}`)
      : 'see options';
    return { line: priceStr, stockInfo: total > 0 ? `${total} in stock` : '' };
  }
  if (p.variations?.length) {
    let min = null, total = 0;
    for (const v of p.variations) {
      for (const o of (v.options || [])) {
        if (o.is_available === false) continue;
        const n = parseFloat(o.price_adjustment || o.price);
        if (!isNaN(n) && n > 0 && (min === null || n < min)) min = n;
        if (o.stock != null) total += Number(o.stock);
      }
    }
    return {
      line: min !== null ? `from ${fmtN(min)}` : 'see options',
      stockInfo: total > 0 ? `${total} in stock` : '',
    };
  }
  const price = parseFloat(p.price || 0);
  const stock = p.stock != null ? `${p.stock} in stock` : '';
  return { line: fmtN(price), stockInfo: stock };
}

/**
 * buildVariationsText — formats product options for display in a WhatsApp message.
 *
 * When variants[] exist (Color+Size combos with absolute prices):
 *   Groups by primary dimension (Color), lists secondary (Size) under each.
 *   Nike:
 *   *Black* — ₦30,000
 *     · Size 42 (5 left)
 *     · Size 43 (4 left)
 *   *White* — ₦30,500
 *     · Size 44 (3 left)
 *
 * When only variations[] exist (independent option groups):
 *   Color:
 *   • Red — ₦25 (30 left)
 *   • Blue — ₦27 (25 left)
 */
function buildVariationsText(p) {
  if (p.variants?.length) {
    // Group by primary option (first in options array, usually Color)
    const groups = new Map();
    for (const v of p.variants) {
      if (!v.options?.length) continue;
      const primary = v.options[0].option_display_name || v.options[0].option_value;
      const secondary = v.options.slice(1).map(o => o.option_display_name || o.option_value).join(' + ');
      if (!groups.has(primary)) groups.set(primary, { price: v.price, entries: [] });
      groups.get(primary).entries.push({
        label: secondary || null,
        stock: v.stock,
        price: v.price,
      });
    }

    let text = `${p.name}:\n\n`;
    for (const [primary, g] of groups) {
      // Show price per colour group (all sizes same price → show once)
      const prices = [...new Set(g.entries.map(e => e.price))];
      const priceStr = prices.length === 1 ? fmtN(prices[0]) : `from ${fmtN(Math.min(...prices))}`;
      text += `*${primary}* — ${priceStr}\n`;
      for (const e of g.entries) {
        if (e.label) {
          const stockStr = e.stock != null ? ` (${e.stock} left)` : '';
          text += `  · ${e.label}${stockStr}\n`;
        }
      }
      text += '\n';
    }
    return text.trimEnd() + '\n\nWhich works for you?';
  }

  if (p.variations?.length) {
    let text = '';
    for (const v of p.variations) {
      const opts = (v.options || []).filter(o => o.is_available !== false);
      if (!opts.length) continue;
      if (v.variation_name) text += `${v.variation_name}:\n`;
      for (const o of opts) {
        const optPrice  = parseFloat(o.price_adjustment || o.price);
        const basePrice = parseFloat(p.price);
        const finalPrice = !isNaN(optPrice) && optPrice > 0
          ? (o.price_adjustment != null && !isNaN(basePrice) && basePrice > 0
              ? basePrice + optPrice
              : optPrice)
          : (!isNaN(basePrice) && basePrice > 0 ? basePrice : null);
        const oStock = o.stock != null ? ` (${o.stock} left)` : '';
        const priceDisplay = finalPrice !== null ? ` — ${fmtN(finalPrice)}` : '';
        text += `• ${o.option_display_name || o.option_value}${priceDisplay}${oStock}\n`;
      }
      text += '\n';
    }
    return text.trim() ? text.trimEnd() + '\n\nWhich works for you?' : '';
  }

  return ''; // simple product — no options
}

/** Format price and stock for one product — handles variants, variations, and simple products */
function priceStock(p) {
  // Case 1: product has explicit variants (colour+size combos with absolute prices)
  if (p.variants?.length) {
    const prices = p.variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n));
    const stocks = p.variants.map(v => Number(v.stock || 0));
    const min    = prices.length ? Math.min(...prices) : null;
    const total  = stocks.reduce((s, n) => s + n, 0);
    if (min !== null) return { line: `from ${fmtN(min)}${total > 0 ? ` (${total} in stock)` : ''}`, priceNum: min };
    return { line: 'multiple options', priceNum: 0 };
  }
  // Case 2: variations only (price_adjustment per option, no variant combos)
  if (p.variations?.length) {
    let min = null, total = 0;
    for (const v of p.variations) {
      for (const o of (v.options || [])) {
        const n = parseFloat(o.price_adjustment || o.price);
        if (!isNaN(n) && n > 0 && (min === null || n < min)) min = n;
        if (o.stock != null) total += Number(o.stock);
      }
    }
    if (min !== null) return { line: `from ${fmtN(min)}${total > 0 ? ` (${total} in stock)` : ''}`, priceNum: min };
    return { line: 'multiple options', priceNum: 0 };
  }
  // Case 3: simple product
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

/**
 * Pick the best image URL for a product.
 * Priority: variant image → variation-option image → product image → null
 * Skips data: URIs — they cannot be sent as WhatsApp image URLs.
 */
function pickProductImageUrl(p, base) {
  const toUrl = url => {
    if (!url) return null;
    if (url.startsWith('data:')) return null;  // base64 inline — unusable as WhatsApp image URL
    if (url.startsWith('http')) return url;
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  // 1. First variant that has an image URL
  if (p.variants?.length) {
    for (const v of p.variants) {
      const u = toUrl(v.image_url);
      if (u) return u;
    }
  }

  // 2. First available variation option that has a real image URL
  if (p.variations?.length) {
    for (const v of p.variations) {
      for (const o of (v.options || [])) {
        if (o.is_available === false) continue;
        const u = toUrl(o.image_url);
        if (u) return u;
      }
    }
  }

  // 3. Main product image
  return toUrl(p.image_url || p.imageUrl);
}

/** Is this reply a placeholder that should be replaced by real data? */
function isPlaceholder(text) {
  const t = (text || '').trim();
  if (!t) return true; // empty = definitely a placeholder
  return /^(on it|sure|ok|checking|let me|pulling|one sec|hold on|gimme|alright|yeah|give me a sec|let me pull|hang on|just a)/i.test(t);
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
  const recent = [...history].reverse().slice(0, 16);

  // PRIORITY 1: What did the USER explicitly ask about or mention wanting?
  // This is the most reliable signal — the customer's own words.
  for (const msg of recent) {
    if (msg.role !== 'user' || !msg.text) continue;
    const t = msg.text.toLowerCase();

    // "I'm looking for sneakers", "I want sneakers", "looking for X"
    const lookingFor = msg.text.match(/(?:looking for|want|need|interested in|after)\s+(?:a\s+|some\s+|the\s+)?([A-Za-z][A-Za-z0-9 ]{2,35}?)(?:\s+please|\?|$|\.)/i);
    if (lookingFor?.[1]) {
      const term = lookingFor[1].trim();
      // Skip generic words
      if (!/^(a|an|the|some|any|something|stuff|products?|items?|things?)$/i.test(term)) {
        return term;
      }
    }

    // Direct product name in a buy/order/price context
    const name = extractProductName(msg.text);
    if (name) return name;
  }

  // PRIORITY 2: What was the LAST specific product the assistant mentioned?
  // Only single-product mentions, not catalog lists.
  for (const msg of recent) {
    if (msg.role !== 'assistant' || !msg.text) continue;
    // Skip messages that look like catalog lists (have multiple numbered items)
    const numberedItems = (msg.text.match(/^\d+\./gm) || []).length;
    if (numberedItems > 1) continue; // this is a catalog, not a single product reference

    // Single numbered item (e.g. from a focused search result)
    const single = msg.text.match(/^1\.\s+([^–\-\n]{2,40}?)\s+[–\-]/m);
    if (single?.[1]) return single[1].trim();
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
