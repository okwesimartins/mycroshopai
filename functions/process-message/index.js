const gemini = require('../../lib/gemini');
const whatsapp = require('../../lib/whatsapp');
const backendApi = require('../../lib/backend-api');
const firestore = require('../../lib/firestore');
const contactPricing = require('../../lib/contact-pricing');
const payments = require('../../lib/payments'); // for formatPaymentConfirmation only

// Initialize Gemini AI (key checked at first use to avoid startup failure)
const ai = new gemini(process.env.GEMINI_API_KEY || '');

/**
 * Process incoming WhatsApp message
 * @param {Object} messageData - Message data
 */
async function processMessage(messageData) {
  const {
    tenantId,
    accessToken,
    storeName,
    businessBio,
    subscriptionPlan: subscriptionPlanFromWebhook,
    defaultOnlineStoreId,
    customerPhone,
    message,
    messageId,
    phoneNumberId
  } = messageData;

  const subscriptionPlan = subscriptionPlanFromWebhook || 'enterprise';
  const storeNameResolved = storeName || 'our store';

  const logError = (step, err) => {
    console.error(`[processMessage] ERROR at ${step}:`, err?.message || err);
    if (err?.stack) {
      console.error(`[processMessage] ${step} stack:`, err.stack);
    }
    if (err?.response?.data) {
      console.error(`[processMessage] ${step} response:`, JSON.stringify(err.response.data).substring(0, 500));
    }
  };

  try {
    if (!process.env.GEMINI_API_KEY) {
      console.error('[processMessage] GEMINI_API_KEY is not set');
      throw new Error('GEMINI_API_KEY is not set');
    }
    const msgPreview = (message || '').trim();
    if (!msgPreview) {
      console.log('[processMessage] Empty message, skipping');
      return;
    }
    console.log(`[processMessage] Processing for tenant ${tenantId}, customer ${customerPhone}:`, msgPreview.substring(0, 80));

    // Check contact limit before processing (Firestore) – skip if Firestore not configured
    if (typeof firestore.checkContactLimit === 'function') {
      let contactLimit;
      try {
        contactLimit = await firestore.checkContactLimit(tenantId);
      } catch (err) {
        logError('contact_limit', err);
        throw err;
      }

      if (contactLimit.reached) {
        const isNewContact = typeof firestore.getConversationHistory === 'function'
          ? !(await firestore.getConversationHistory(tenantId, customerPhone, 1)).length > 0
          : true;
        if (isNewContact) {
          const upgradeMessage = contactPricing.getUpgradeMessage(contactLimit.count, contactLimit.limit);
          await sendWhatsAppResponse(
            phoneNumberId,
            customerPhone,
            `Sorry, you've reached your contact limit (${contactLimit.count}/${contactLimit.limit}). ` +
            `Please upgrade your plan to continue receiving messages from new customers. ` +
            `Contact support for assistance.`,
            accessToken
          );
          return;
        }
      }
    }

    // Get conversation history from Firestore (empty if Firestore not configured)
    let conversationHistory = [];
    if (typeof firestore.getConversationHistory === 'function') {
      try {
        conversationHistory = await firestore.getConversationHistory(tenantId, customerPhone);
      } catch (err) {
        logError('conversation_history', err);
        throw err;
      }
    }

    // Process message with Gemini AI
    const context = {
      tenant_id: tenantId,
      subscription_plan: subscriptionPlan,
      customer_phone: customerPhone,
      store_name: storeNameResolved,
      business_bio: businessBio || null,
      conversation_history: conversationHistory
    };

    let aiResponse;
    try {
      aiResponse = await ai.processMessage(message, context);
    } catch (err) {
      logError('ai_processMessage', err);
      throw err;
    }

    // Handle AI actions (via backend API) – intent drives which API we call
    let finalResponse = aiResponse.text;

    if (aiResponse.actions && aiResponse.actions.length > 0) {
      console.log('[processMessage] Intent -> API actions:', aiResponse.actions.map(a => a.type).join(', '));
      for (const action of aiResponse.actions) {
        const actionResult = await handleAction(action, {
          tenantId,
          subscriptionPlan,
          defaultOnlineStoreId,
          message,
          conversationHistory,
          accessToken,
          phoneNumberId,
          customerPhone
        });

        if (actionResult != null) {
          finalResponse = typeof actionResult === 'string' ? actionResult : actionResult.response || finalResponse;
        }
      }
    }

    // Remove any raw function names the model may have output so the reply feels human
    let cleaned = (finalResponse || '')
      .replace(/\b(list_inventory|query_inventory|create_order|check_payment)\b/gi, '')
      .replace(/\s*`[^`]*`\s*/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned.length > 0) finalResponse = humanizeOutgoingReply(cleaned, conversationHistory, message);

    // Send response via WhatsApp (using token from resolve-tenant)
    try {
      await sendWhatsAppResponse(phoneNumberId, customerPhone, finalResponse, accessToken);
    } catch (err) {
      logError('send_whatsapp_response', err);
      throw err;
    }

    // Save conversation history to Firestore (no-op if Firestore not configured)
    if (typeof firestore.saveMessage === 'function') {
      try {
        await firestore.saveMessage(tenantId, customerPhone, 'user', message, messageId);
        await firestore.saveMessage(tenantId, customerPhone, 'assistant', finalResponse);
      } catch (err) {
        logError('save_history', err);
        // Don't throw - message was already sent; log and continue
      }
    }

    // Check if follow-up should be scheduled (like a human sales agent would)
    await checkAndScheduleFollowUp(tenantId, customerPhone, message, finalResponse, conversationHistory);

  } catch (error) {
    console.error('[processMessage] FAILED:', error?.message || error);
    console.error('[processMessage] Full error:', error);
    if (error?.stack) {
      console.error('[processMessage] Stack:', error.stack);
    }
    
    // Send error message to customer
    try {
      await sendWhatsAppResponse(
        phoneNumberId,
        customerPhone,
        'Sorry, I encountered an error. Please try again or contact support.',
        accessToken
      );
    } catch (sendError) {
      console.error('[processMessage] Error sending fallback message to user:', sendError?.message || sendError);
    }
  }
}

/**
 * Handle AI actions (via backend API: inventory, list catalog, order, payment)
 */
async function handleAction(action, ctx) {
  const { tenantId, subscriptionPlan, defaultOnlineStoreId, message, conversationHistory } = ctx;
  try {
    switch (action.type) {
      case 'query_inventory':
        return await handleInventoryQuery(tenantId, subscriptionPlan, message, action.intent);

      case 'list_inventory':
        return await handleListInventory(ctx, action.share_media === true);

      case 'show_variations':
        return await handleShowVariations(ctx);

      case 'create_order':
        return await handleOrderCreation(tenantId, subscriptionPlan, defaultOnlineStoreId, message, conversationHistory);

      case 'check_payment':
        return await handlePaymentCheck(tenantId, message);

      default:
        return null;
    }
  } catch (error) {
    console.error('Error handling action:', error);
    return null;
  }
}

/**
 * Handle inventory query (via backend API) – single product (price, availability, stock)
 */
async function handleInventoryQuery(tenantId, subscriptionPlan, message, intent) {
  try {
    const productName = normalizeSearchTerm(extractProductName(message) || extractSearchTerm(message) || '');
    if (!productName) {
      if (intent === 'price') return 'Which product should I check the price for?';
      return 'Tell me the product name and I’ll check it for you.';
    }

    const result = await backendApi.checkProduct(tenantId, productName, subscriptionPlan);
    if (!result) {
      return 'I couldn’t check that right now. Please try again in a moment.';
    }

    if (result.exists && result.product) {
      const p = result.product;
      const stock = p.stock != null ? Number(p.stock) : null;
      const priceStr = p.price != null ? formatNaira(p.price) : null;
      const hasVariations = Array.isArray(p.variations) && p.variations.length > 0;

      if (intent === 'price') {
        return `${p.name}${priceStr ? ` is ${priceStr}` : hasVariations ? ' has a few price options depending on the variation' : ' is available'}.${stock != null ? stock > 0 ? ` We have ${stock} available right now.` : ' It’s currently out of stock.' : ''} ${hasVariations ? 'Want me to show you the options too?' : 'Want me to send a photo or help you order it?'}`.trim();
      }

      if (stock != null && stock <= 0) {
        return `${p.name} is in our catalog, but it’s currently out of stock.${priceStr ? ` Last listed price is ${priceStr}.` : ''} Want me to show you something similar instead?`;
      }

      return `Yes, we have ${p.name}.${priceStr ? ` It’s ${priceStr}.` : ''}${stock != null ? ` We currently have ${stock} available.` : ''} ${hasVariations ? 'Want the options as well?' : 'Want me to send a photo or help you place the order?'}`.trim();
    }
    return `I couldn’t find "${productName}" in the catalog right now. Want me to show you similar options or the full catalog instead?`;
  } catch (error) {
    console.error('Error handling inventory query:', error);
    return 'I ran into a problem checking that right now. Please try again.';
  }
}

/**
 * Handle "show variations" – use last product from conversation and return its variation options.
 */
async function handleShowVariations(ctx) {
  const { tenantId, subscriptionPlan, conversationHistory = [], message = '' } = ctx;
  const lastCatalogItems = getRecentAssistantCatalogItems(conversationHistory);
  const explicitProduct = normalizeSearchTerm(extractProductName(message) || '');
  let productName = explicitProduct;

  if (!productName) {
    if (lastCatalogItems.length === 1) {
      productName = lastCatalogItems[0];
    } else if (lastCatalogItems.length > 1) {
      const optionsPreview = lastCatalogItems.slice(0, 5).map(name => `• ${name}`).join('\n');
      return `Sure — which one do you want the options for?\n\n${optionsPreview}`;
    } else {
      productName = normalizeSearchTerm(extractLastProductFromConversation(conversationHistory) || '');
    }
  }

  if (!productName) {
    return 'Sure — send the product name and I’ll show you the available options.';
  }

  const listResult = await backendApi.listProducts(tenantId, subscriptionPlan, { search: productName, limit: 1 });
  if (!listResult || !listResult.products || listResult.products.length === 0) {
    return `I couldn’t find ${productName} in the catalog right now. Send the exact product name and I’ll check again.`;
  }

  const p = listResult.products[0];
  if (!p.variations || !p.variations.length) {
    return `${p.name} doesn’t have separate variations — it’s a single option${p.price != null ? ` at ${formatNaira(p.price)}` : ''}. Want me to help you order it?`;
  }

  let text = `Here are the options for ${p.name}:\n\n`;
  for (const v of p.variations) {
    const label = v.variation_name || 'Options';
    text += `${label}:\n`;
    const opts = (v.options || []).filter(o => o.is_available !== false);
    for (const o of opts) {
      const optionName = o.option_display_name || o.option_value || 'Option';
      const price = getVariationPrice(p, o);
      const stockNote = o.stock != null ? (Number(o.stock) > 0 ? ` (${o.stock} in stock)` : ' (out of stock)') : '';
      text += `• ${optionName}${price != null ? ` – ${formatNaira(price)}` : ''}${stockNote}\n`;
    }
    text += '\n';
  }
  text += 'Send the exact option you want and I’ll help you place the order.';
  return text.trim();
}

/**
 * Handle list inventory / catalog (via backend API). Optionally send product images via WhatsApp.
 */
function formatProductPriceAndStock(p) {
  if (p.variations && Array.isArray(p.variations) && p.variations.length > 0) {
    let minPrice = null;
    let totalStock = 0;
    for (const v of p.variations) {
      for (const opt of v.options || []) {
        const adj = parseFloat(opt.price_adjustment);
        if (!isNaN(adj) && (minPrice === null || adj < minPrice)) minPrice = adj;
        if (opt.stock != null) totalStock += Number(opt.stock);
      }
    }
    if (minPrice !== null) {
      const stockStr = totalStock > 0 ? ` (${totalStock} in stock)` : '';
      return { line: `from ${formatNaira(minPrice)}${stockStr}`, priceNum: minPrice };
    }
    const varNames = p.variations.map(v => v.variation_name).filter(Boolean).join(', ') || 'options';
    return { line: `various ${varNames}`, priceNum: 0 };
  }
  const price = parseFloat(p.price || 0);
  const stockStr = p.stock != null ? ` (${p.stock} in stock)` : '';
  return { line: `${formatNaira(price)}${stockStr}`, priceNum: price };
}

async function handleListInventory(ctx, shareMedia) {
  const { tenantId, subscriptionPlan, message, accessToken, phoneNumberId, customerPhone, conversationHistory = [] } = ctx;
  try {
    let rawSearch = extractProductName(message) || extractSearchTerm(message);
    let search = normalizeSearchTerm(rawSearch || '');

    if ((!search || isContextReference(search)) && (isGenericPictureRequest(message) || isContextReference(rawSearch || ''))) {
      const lastCatalogItems = getRecentAssistantCatalogItems(conversationHistory);
      if (lastCatalogItems.length === 1) {
        search = lastCatalogItems[0];
      } else {
        search = normalizeSearchTerm(extractLastProductFromConversation(conversationHistory) || extractLastMentionedProductFromHistory(conversationHistory) || '');
      }
    }

    const attempts = [];
    if (search) attempts.push(search);
    const relaxed = relaxSearchTerm(search);
    if (relaxed && !attempts.includes(relaxed)) attempts.push(relaxed);
    if (attempts.length === 0) attempts.push(undefined);

    let listResult = null;
    let matchedSearch = search;
    for (const candidate of attempts) {
      listResult = await backendApi.listProducts(tenantId, subscriptionPlan, {
        search: candidate || undefined,
        limit: candidate ? 10 : 15
      });
      if (listResult && Array.isArray(listResult.products) && listResult.products.length > 0) {
        matchedSearch = candidate;
        break;
      }
    }

    if (!listResult || !listResult.products || listResult.products.length === 0) {
      return search
        ? `I couldn’t find anything matching "${search}" right now. Want me to show you the full catalog instead?`
        : 'We don’t have any products in the catalog right now. Check back later.';
    }

    const products = listResult.products;
    const backendBaseUrl = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');
    const toFullImageUrl = (url) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      return `${backendBaseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
    };
    const withImages = products.filter(p => toFullImageUrl(p.image_url));

    if (shareMedia && withImages.length > 0 && accessToken && phoneNumberId && customerPhone) {
      const maxImages = 5;
      const toSend = withImages.slice(0, maxImages);
      for (const p of toSend) {
        const imageUrl = toFullImageUrl(p.image_url);
        const { line } = formatProductPriceAndStock(p);
        const caption = `${p.name} – ${line}`;
        try {
          await whatsapp.sendImage(phoneNumberId, accessToken, customerPhone, imageUrl, caption);
        } catch (err) {
          console.error('Error sending product image:', err.message);
        }
      }
    }

    const singleProduct = products.length === 1 && !!matchedSearch;
    let text = '';

    if (singleProduct) {
      const p = products[0];
      const { line } = formatProductPriceAndStock(p);
      text = `${shareMedia && withImages.length ? `I just sent ${p.name}.` : `Here’s ${p.name}.`}\n\n${p.name} – ${line}\n\n${p.variations && p.variations.length ? 'Want the variations too?' : 'Want me to help you place the order?'}`;
      return text;
    }

    text += shareMedia && withImages.length
      ? `I’ve sent the ${matchedSearch ? matchedSearch : 'options'} we have above.\n\n`
      : `Here are the ${matchedSearch ? matchedSearch : 'products'} we have right now:\n\n`;

    products.forEach((p, i) => {
      const { line } = formatProductPriceAndStock(p);
      text += `${i + 1}. ${p.name} – ${line}\n`;
    });

    text += '\nIf any one catches your eye, send the name and I’ll show the price, photo, or variations.';
    return text.trim();
  } catch (error) {
    console.error('Error handling list inventory:', error);
    return 'I couldn’t load the catalog right now. Please try again.';
  }
}


function getVariationPrice(product, option) {
  if (option == null) return product?.price != null ? Number(product.price) : null;
  if (option.price != null && !isNaN(Number(option.price))) return Number(option.price);
  if (option.price_adjustment != null && !isNaN(Number(option.price_adjustment))) return Number(option.price_adjustment);
  if (product?.price != null && !isNaN(Number(product.price))) return Number(product.price);
  return null;
}

function normalizeSearchTerm(term) {
  if (!term || typeof term !== 'string') return null;
  let value = term.trim().replace(/[?!.]+$/g, '');
  if (!value) return null;

  value = value
    .replace(/^(can i see|show me|send me|i want to see|let me see|do you have|i need|i want|looking for|search for|find)\s+/i, '')
    .replace(/^(?:the\s+)?(?:product\s+)?(?:images?|pictures?|photos?|pics?)\s+(?:of\s+)?/i, '')
    .replace(/^(?:the\s+)?(?:variations?|options?|sizes?|colors?)\s+(?:for\s+)?/i, '')
    .replace(/\b(?:you have|you've got|available|in stock|for sale|right now|please)\b/gi, '')
    .replace(/\b(?:the ones|that one|those ones|ones you have|what you have)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  value = value.replace(/^(the|a|an)\s+/i, '').trim();
  if (!value || isMediaOnlyWord(value) || isContextReference(value)) return null;
  return value;
}

function relaxSearchTerm(term) {
  if (!term || typeof term !== 'string') return null;
  const relaxed = term
    .replace(/\b(?:for men|for women|men|women|male|female)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!relaxed || relaxed === term) return null;
  return relaxed;
}

function getRecentAssistantCatalogItems(conversationHistory) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) return [];
  const recentAssistant = conversationHistory.slice(-6).reverse().find(msg => msg.role === 'assistant' && typeof msg.text === 'string' && /\d+\.\s+.+[–\-]/.test(msg.text));
  if (!recentAssistant) return [];
  const names = [];
  for (const line of recentAssistant.text.split(/\n+/)) {
    const match = line.match(/^\s*\d+\.\s+([^–\-]+?)\s+[–\-]\s+/);
    if (match && match[1]) names.push(match[1].trim());
  }
  return [...new Set(names)];
}

function humanizeOutgoingReply(text, conversationHistory = [], customerMessage = '') {
  let cleaned = String(text || '').trim();
  if (!cleaned) return cleaned;
  const hasHistory = Array.isArray(conversationHistory) && conversationHistory.length > 0;
  const customer = String(customerMessage || '').trim().toLowerCase();
  const directIntent = /(price|cost|how much|show|send|picture|pictures|image|images|photo|photos|catalog|product|products|variations|options|sizes|colors|recommend|order|buy|available|in stock)/i.test(customer);

  if (hasHistory || directIntent) {
    cleaned = cleaned
      .replace(/^(hi|hello|hey)\s+there[!.,\s]*/i, '')
      .replace(/^(hi|hello|hey)[!.,\s]*/i, '')
      .replace(/^i'?d love to help[^.?!]*[.?!]\s*/i, '')
      .replace(/^to give you the best recommendation[^.?!]*[.?!]\s*/i, '')
      .trim();
  }

  cleaned = cleaned
    .replace(/\bkindly note\b/gi, 'please note')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

function extractSearchTerm(message) {
  const m = (message || '').toLowerCase();
  const patterns = [
    /(?:show|list|get|send|see).*?(?:products?|items?|catalog|inventory)\s+(?:for|about|like)?\s*[:\-]?\s*(.+?)(?:\?|$|\.)/i,
    /(?:what|which)\s+(?:products?|items?).*?(?:have|offer|sell)\s+(?:for|about)?\s*(.+?)(?:\?|$|\.)/i,
    /(?:search|find)\s+(.+?)(?:\?|$|\.)/i
  ];
  for (const pattern of patterns) {
    const match = (message || '').match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

/**
 * Handle order creation (via backend API)
 */
async function handleOrderCreation(tenantId, subscriptionPlan, defaultOnlineStoreId, message, conversationHistory) {
  try {
    const orderDetails = await ai.extractOrderDetails(message, conversationHistory);

    if (!orderDetails || !orderDetails.items || orderDetails.items.length === 0) {
      return 'I need more information to create your order. Please tell me:\n' +
             '1. What products you want\n' +
             '2. How many of each\n' +
             '3. Your name and contact details';
    }

    if (!defaultOnlineStoreId) {
      return 'Sorry, this store has no online store configured. Please contact the merchant.';
    }

    const validatedItems = [];
    for (const item of orderDetails.items) {
      const result = await backendApi.checkProduct(tenantId, item.product_name, subscriptionPlan);
      if (!result || !result.exists || !result.product) {
        return `Sorry, "${item.product_name}" is not available. ${(result && result.message) || ''}`;
      }
      const p = result.product;
      const qty = item.quantity || 1;
      const stock = p.stock != null ? p.stock : 0;
      if (stock < qty) {
        return `Sorry, "${p.name}" has only ${stock} in stock. You requested ${qty}.`;
      }
      validatedItems.push({
        product_id: p.id,
        product_name: p.name,
        quantity: qty,
        price: p.price
      });
    }

    const orderResult = await backendApi.createOrder(tenantId, {
      online_store_id: defaultOnlineStoreId,
      items: validatedItems,
      customer_info: {
        name: orderDetails.customer_name || 'WhatsApp Customer',
        email: orderDetails.customer_email || '',
        phone: orderDetails.customer_phone || '',
        shipping_address: orderDetails.shipping_address || ''
      }
    });

    if (orderResult.success) {
      return formatOrderConfirmation(orderResult.order, orderResult.paymentLink);
    }
    return 'Sorry, I encountered an error creating your order. Please try again.';
  } catch (error) {
    console.error('Error handling order creation:', error);
    return 'Sorry, I encountered an error creating your order. Please try again or contact support.';
  }
}

function formatOrderConfirmation(order, paymentLink) {
  let msg = `✅ Order created!\n\nOrder #${order?.id || order?.order_number || 'N/A'}\n`;
  if (order?.total != null) {
    msg += `Total: ₦${parseFloat(order.total).toLocaleString()}\n`;
  }
  if (paymentLink) {
    msg += `\nPay here: ${paymentLink}`;
  }
  return msg;
}

/**
 * Handle payment check (via backend API)
 */
async function handlePaymentCheck(tenantId, message) {
  try {
    const reference = extractPaymentReference(message);
    if (!reference) {
      return 'Please provide your payment reference number to check payment status.';
    }

    const paymentResult = await backendApi.verifyPayment(tenantId, reference);
    return payments.formatPaymentConfirmation(paymentResult);
  } catch (error) {
    console.error('Error handling payment check:', error);
    return 'Sorry, I encountered an error checking your payment. Please try again.';
  }
}

/**
 * Send WhatsApp response (access token from resolve-tenant, no DB)
 */
async function sendWhatsAppResponse(phoneNumberId, to, message, accessToken) {
  if (!accessToken) {
    throw new Error('Access token not found for phone number');
  }
  await whatsapp.sendMessage(phoneNumberId, accessToken, to, message);
}

/** Format amount as Naira (₦) with thousands separator and optional decimals */
function formatNaira(amount) {
  const n = Number(amount);
  if (isNaN(n)) return '₦0';
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Words that mean "photos/pictures" — never use these as product search terms */
const MEDIA_WORDS = new Set(['image', 'images', 'picture', 'pictures', 'photo', 'photos', 'pic', 'pics']);

/** Phrases that refer to "what we were just discussing" — use chat history, not as search term */
const CONTEXT_REFERENCE_PHRASES = new Set([
  'ones you have', 'the ones you have', 'what you have', 'what you showed', 'the ones you showed',
  'that one', 'those', 'the ones', 'your options', 'your selection', 'what you got', 'the options'
]);

function isMediaOnlyWord(term) {
  if (!term || typeof term !== 'string') return false;
  return MEDIA_WORDS.has(term.trim().toLowerCase());
}

function isContextReference(term) {
  if (!term || typeof term !== 'string') return false;
  const t = term.trim().toLowerCase();
  if (CONTEXT_REFERENCE_PHRASES.has(t)) return true;
  if (/^(the\s+)?ones\s+(you\s+)?have$/i.test(t)) return true;
  if (/^what\s+you\s+(have|showed|got)$/i.test(t)) return true;
  if (/\bones\s+you\s+have\b/i.test(t) || /\bwhat\s+you\s+have\b/i.test(t)) return true;
  return false;
}

/** Check if message is a generic "show picture" or "show me what you have" (use chat history) */
function isGenericPictureRequest(message) {
  if (!message || typeof message !== 'string') return false;
  const m = message.trim().toLowerCase();
  if (/^(\s*yes\s*)$/i.test(m)) return true;
  if (/^(yes\s+)?(let me see|show me|send me|i want to see)\s+(?:the\s+)?(picture|image|photo)s?\.?$/i.test(m)) return true;
  if (/^(yes\s+)?(picture|image|photo)s?\.?$/i.test(m)) return true;
  if (/(?:let me see|show me)\s+(?:the\s+)?(?:images?|pictures?|photos?)\s+of\s+(?:the\s+)?ones\s+you\s+have/i.test(m)) return true;
  if (/(?:let me see|show me)\s+(?:the\s+)?(?:images?|pictures?)\s+of\s+what\s+you\s+have/i.test(m)) return true;
  return false;
}

/**
 * Get the last product name mentioned by the user in conversation history.
 */
function extractLastMentionedProductFromHistory(conversationHistory) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) return null;
  const recent = conversationHistory.slice(-8).reverse();
  for (const msg of recent) {
    if (msg.role === 'user' && msg.text) {
      const name = extractProductName(msg.text);
      if (name && !isContextReference(name) && !isMediaOnlyWord(name)) return name;
    }
  }
  return null;
}

/**
 * Get the last product name from the whole conversation (user or assistant), e.g. for "show variations".
 */
function extractLastProductFromConversation(conversationHistory) {
  const fromUser = extractLastMentionedProductFromHistory(conversationHistory);
  if (fromUser) return fromUser;
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) return null;
  const recent = conversationHistory.slice(-6).reverse();
  for (const msg of recent) {
    if (msg.role === 'assistant' && msg.text) {
      const t = msg.text;
      const assistantList = getRecentAssistantCatalogItems([msg]);
      if (assistantList.length === 1) return assistantList[0];
      const m = t.match(/(?:here(?:'s| is)|i just sent|sending you)\s+([^:!.\n]+?)(?:\s*[:\-]|!|\.|\n|$)/i);
      if (m && m[1]) return m[1].trim();
      const m2 = t.match(/([A-Za-z0-9\s&()'\/]+?)\s+[–\-]\s+(?:from\s+)?₦/);
      if (m2 && m2[1]) return m2[1].trim();
    }
  }
  return null;
}

/**
 * Extract product name from message (all permutations: availability, price, cost, order, image of X, etc.)
 */
function extractProductName(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.trim();

  const patterns = [
    // "image/picture/photo of X" — user wants to see a specific product's image (must come first)
    /(?:can i see|show me|send me|i want to see|let me see|send)\s+(?:the\s+)?(?:product\s+)?(?:image|picture|photo|pic)s?\s+(?:of\s+)(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    /(?:can i see|show me|send me|i want to see|let me see)\s+(?:the\s+)?(.+?)\s+(?:images?|pictures?|photos?)?(?:\?|$|\.)/i,
    /(?:image|picture|photo|pic)s?\s+(?:of\s+)(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    // "let me see X" / "show me X" — product by name (must check inventory; do not assume by name)
    /(?:let me see|show me)\s+(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    // Price / cost
    /(?:how much (?:is|for|does)\s+)(?:the\s+)?(.+?)(?:\s+cost|\s+go\s+for|\?|$|\.)/i,
    /(?:price|cost|amount)\s+(?:of|for)\s+(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    /(?:what('s| is) the (?:price|cost)\s+)(?:of\s+)?(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    /(?:how much (?:does)\s+)(?:the\s+)?(.+?)(?:\s+cost|\?|$|\.)/i,
    /(?:what does)\s+(?:the\s+)?(.+?)(?:\s+cost|\s+go\s+for|\?|$|\.)/i,
    /(?:how much for)\s+(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    // Availability / have / stock
    /(?:do you have|is|are)\s+(?:there\s+)?(?:any\s+)?(?:the\s+)?(.+?)(?:\s+(?:in stock|available|\?)|$|\.)/i,
    /(?:show me|i want|i need|looking for)\s+(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    /(?:product|item)\s+(.+?)(?:\?|$|\.)/i,
    /(?:tell me about|details on|info on|what is)\s+(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    // Order
    /(?:i want to buy|get me|i need)\s+(?:some\s+)?(?:the\s+)?(.+?)(?:\?|$|\.)/i,
    /(?:order|buy)\s+(?:some\s+)?(?:the\s+)?(.+?)(?:\?|$|\.)/i
  ];

  for (const pattern of patterns) {
    const match = m.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name.length > 0 && name.length < 120 && !isMediaOnlyWord(name)) return name;
    }
  }

  return null;
}

/**
 * Extract payment reference from message
 */
function extractPaymentReference(message) {
  // Look for reference patterns
  const patterns = [
    /(?:reference|ref|payment ref|txn ref)[\s:]+([A-Z0-9]+)/i,
    /([A-Z0-9]{8,})/ // Generic alphanumeric code
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Schedule follow-up (e.g. abandoned cart, payment reminder).
 * No-op when not using Cloud Scheduler; can be wired to a job queue later.
 */
async function checkAndScheduleFollowUp() {
  // Optional: call Cloud Scheduler or internal queue when running on Google Cloud
}

module.exports = { processMessage };

