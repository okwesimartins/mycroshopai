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

    // Check contact limit before processing (Firestore)
    let contactLimit;
    try {
      contactLimit = await firestore.checkContactLimit(tenantId);
    } catch (err) {
      logError('contact_limit', err);
      throw err;
    }
    
    if (contactLimit.reached) {
      // Check if this is a new contact
      const isNewContact = !(await firestore.getConversationHistory(tenantId, customerPhone, 1)).length > 0;
      
      if (isNewContact) {
        // Block new contacts if limit reached
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
      // Allow existing contacts to continue messaging
    }

    // Get conversation history from Firestore
    let conversationHistory;
    try {
      conversationHistory = await firestore.getConversationHistory(tenantId, customerPhone);
    } catch (err) {
      logError('conversation_history', err);
      throw err;
    }

    // Process message with Gemini AI
    const context = {
      tenant_id: tenantId,
      subscription_plan: subscriptionPlan,
      customer_phone: customerPhone,
      store_name: storeNameResolved,
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

    // Send response via WhatsApp (using token from resolve-tenant)
    try {
      await sendWhatsAppResponse(phoneNumberId, customerPhone, finalResponse, accessToken);
    } catch (err) {
      logError('send_whatsapp_response', err);
      throw err;
    }

    // Save conversation history to Firestore
    try {
      await firestore.saveMessage(tenantId, customerPhone, 'user', message, messageId);
      await firestore.saveMessage(tenantId, customerPhone, 'assistant', finalResponse);
    } catch (err) {
      logError('save_history', err);
      // Don't throw - message was already sent; log and continue
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
    const productName = extractProductName(message);
    if (!productName) {
      if (intent === 'price') return null;
      return 'Could you please specify which product you\'re looking for?';
    }

    const result = await backendApi.checkProduct(tenantId, productName, subscriptionPlan);
    if (!result) {
      return 'Sorry, I couldn\'t check availability. Please try again.';
    }

    if (result.exists && result.product) {
      const p = result.product;
      const stock = p.stock != null ? p.stock : 0;
      return `✅ ${result.message || 'Product found'}\n\n` +
             `Product: ${p.name}\n` +
             `Price: ₦${parseFloat(p.price || 0).toLocaleString()}\n` +
             `Stock: ${stock} available\n\n` +
             `Would you like to place an order?`;
    }
    return `❌ ${result.message || 'Product not found'}`;
  } catch (error) {
    console.error('Error handling inventory query:', error);
    return 'Sorry, I encountered an error checking availability. Please try again.';
  }
}

/**
 * Handle list inventory / catalog (via backend API). Optionally send product images via WhatsApp.
 */
async function handleListInventory(ctx, shareMedia) {
  const { tenantId, subscriptionPlan, message, accessToken, phoneNumberId, customerPhone } = ctx;
  try {
    const search = extractProductName(message) || extractSearchTerm(message);
    const listResult = await backendApi.listProducts(tenantId, subscriptionPlan, {
      search: search || undefined,
      limit: 15
    });

    if (!listResult || !listResult.products || listResult.products.length === 0) {
      return search
        ? `We don't have any products matching "${search}" right now. Try another search or ask for our full catalog.`
        : 'We don\'t have any products in the catalog at the moment. Check back later!';
    }

    const products = listResult.products;
    const withImages = products.filter(p => p.image_url && p.image_url.startsWith('http'));

    if (shareMedia && withImages.length > 0 && accessToken && phoneNumberId && customerPhone) {
      const maxImages = 5;
      for (let i = 0; i < Math.min(withImages.length, maxImages); i++) {
        const p = withImages[i];
        const caption = `${p.name} – ₦${parseFloat(p.price || 0).toLocaleString()}${p.stock != null ? ` (${p.stock} in stock)` : ''}`;
        try {
          await whatsapp.sendImage(phoneNumberId, accessToken, customerPhone, p.image_url, caption);
        } catch (err) {
          console.error('Error sending product image:', err.message);
        }
      }
    }

    let text = `📦 Here are our products${search ? ` matching "${search}"` : ''}:\n\n`;
    products.forEach((p, i) => {
      text += `${i + 1}. ${p.name} – ₦${parseFloat(p.price || 0).toLocaleString()}`;
      if (p.stock != null) text += ` (${p.stock} in stock)`;
      text += '\n';
    });
    text += '\nWould you like details on any product or to place an order?';
    return text;
  } catch (error) {
    console.error('Error handling list inventory:', error);
    return 'Sorry, I couldn\'t load the catalog. Please try again.';
  }
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

/**
 * Extract product name from message (all permutations: availability, price, cost, order, etc.)
 */
function extractProductName(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.trim();
  const lowerMessage = m.toLowerCase();

  const patterns = [
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
      if (name.length > 0 && name.length < 120) return name;
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

