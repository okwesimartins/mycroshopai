const database = require('../../lib/database');
const gemini = require('../../lib/gemini');
const whatsapp = require('../../lib/whatsapp');
const inventory = require('../../lib/inventory');
const orders = require('../../lib/orders');
const payments = require('../../lib/payments');
const firestore = require('../../lib/firestore');
const contactPricing = require('../../lib/contact-pricing');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase-admin/app');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase-admin/app');
const admin = require('firebase-admin');

// Initialize Gemini AI
const ai = new gemini(process.env.GEMINI_API_KEY);

/**
 * Process incoming WhatsApp message
 * @param {Object} messageData - Message data
 */
async function processMessage(messageData) {
  const { tenantId, customerPhone, message, messageId, phoneNumberId } = messageData;

  try {
    console.log(`Processing message for tenant ${tenantId}:`, message);

    // Get tenant information
    const tenantInfo = await database.getTenantInfo(tenantId);
    const subscriptionPlan = tenantInfo.subscription_plan || 'free';

    // Check contact limit before processing
    const contactLimit = await firestore.checkContactLimit(tenantId);
    
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
          `Contact support for assistance.`
        );
        return;
      }
      // Allow existing contacts to continue messaging
    }

    // Get conversation history from Firestore
    const conversationHistory = await firestore.getConversationHistory(tenantId, customerPhone);

    // Process message with Gemini AI
    const context = {
      tenant_id: tenantId,
      subscription_plan: subscriptionPlan,
      customer_phone: customerPhone,
      conversation_history: conversationHistory
    };

    const aiResponse = await ai.processMessage(message, context);

    // Handle AI actions
    let finalResponse = aiResponse.text;

    if (aiResponse.actions && aiResponse.actions.length > 0) {
      for (const action of aiResponse.actions) {
        const actionResult = await handleAction(action, tenantId, subscriptionPlan, message, conversationHistory);
        
        if (actionResult) {
          finalResponse = actionResult;
        }
      }
    }

    // Send response via WhatsApp
    await sendWhatsAppResponse(phoneNumberId, customerPhone, finalResponse);

    // Save conversation history to Firestore
    await firestore.saveMessage(tenantId, customerPhone, 'user', message, messageId);
    await firestore.saveMessage(tenantId, customerPhone, 'assistant', finalResponse);

    // Check if follow-up should be scheduled (like a human sales agent would)
    await checkAndScheduleFollowUp(tenantId, customerPhone, message, finalResponse, conversationHistory);

  } catch (error) {
    console.error('Error processing message:', error);
    
    // Send error message to customer
    try {
      await sendWhatsAppResponse(
        phoneNumberId,
        customerPhone,
        'Sorry, I encountered an error. Please try again or contact support.'
      );
    } catch (sendError) {
      console.error('Error sending error message:', sendError);
    }
  }
}

/**
 * Handle AI actions (query inventory, create order, etc.)
 */
async function handleAction(action, tenantId, subscriptionPlan, message, conversationHistory) {
  try {
    switch (action.type) {
      case 'query_inventory':
        return await handleInventoryQuery(tenantId, subscriptionPlan, message);

      case 'create_order':
        return await handleOrderCreation(tenantId, subscriptionPlan, message, conversationHistory);

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
 * Handle inventory query
 */
async function handleInventoryQuery(tenantId, subscriptionPlan, message) {
  try {
    // Extract product name from message
    const productName = extractProductName(message);
    
    if (!productName) {
      return 'Could you please specify which product you\'re looking for?';
    }

    // Check availability
    const availability = await inventory.checkAvailability(
      tenantId,
      subscriptionPlan,
      productName
    );

    if (availability.available) {
      return `✅ ${availability.message}\n\n` +
             `Product: ${availability.product.name}\n` +
             `Price: ₦${parseFloat(availability.product.price || 0).toLocaleString()}\n` +
             `Stock: ${availability.stock} available\n\n` +
             `Would you like to place an order?`;
    } else {
      return `❌ ${availability.message}`;
    }
  } catch (error) {
    console.error('Error handling inventory query:', error);
    return 'Sorry, I encountered an error checking availability. Please try again.';
  }
}

/**
 * Handle order creation
 */
async function handleOrderCreation(tenantId, subscriptionPlan, message, conversationHistory) {
  try {
    // Extract order details using AI
    const orderDetails = await ai.extractOrderDetails(message, conversationHistory);

    if (!orderDetails || !orderDetails.items || orderDetails.items.length === 0) {
      return 'I need more information to create your order. Please tell me:\n' +
             '1. What products you want\n' +
             '2. How many of each\n' +
             '3. Your name and contact details';
    }

    // Validate and check availability for each item
    const validatedItems = [];
    for (const item of orderDetails.items) {
      const availability = await inventory.checkAvailability(
        tenantId,
        subscriptionPlan,
        item.product_name,
        item.quantity
      );

      if (!availability.available) {
        return `Sorry, "${item.product_name}" is not available in the quantity you requested. ${availability.message}`;
      }

      validatedItems.push({
        product_id: availability.product.id || availability.product.product_id,
        product_name: availability.product.name,
        quantity: item.quantity,
        price: availability.product.price
      });
    }

    // Create order
    const orderResult = await orders.createOrder(tenantId, {
      items: validatedItems,
      customer_info: {
        name: orderDetails.customer_name || 'WhatsApp Customer',
        email: orderDetails.customer_email || '',
        phone: orderDetails.customer_phone || '',
        shipping_address: orderDetails.shipping_address || ''
      }
    });

    if (orderResult.success) {
      return orders.formatOrderConfirmation(orderResult.order, orderResult.paymentLink);
    } else {
      return 'Sorry, I encountered an error creating your order. Please try again.';
    }
  } catch (error) {
    console.error('Error handling order creation:', error);
    return 'Sorry, I encountered an error creating your order. Please try again or contact support.';
  }
}

/**
 * Handle payment check
 */
async function handlePaymentCheck(tenantId, message) {
  try {
    // Extract payment reference from message
    const reference = extractPaymentReference(message);
    
    if (!reference) {
      return 'Please provide your payment reference number to check payment status.';
    }

    const paymentResult = await payments.verifyPayment(reference, tenantId);

    return payments.formatPaymentConfirmation(paymentResult);
  } catch (error) {
    console.error('Error handling payment check:', error);
    return 'Sorry, I encountered an error checking your payment. Please try again.';
  }
}

/**
 * Send WhatsApp response
 */
async function sendWhatsAppResponse(phoneNumberId, to, message) {
  try {
    // Get access token for this phone number
    // In production, you'd get this from database
    const accessToken = await getAccessToken(phoneNumberId);

    if (!accessToken) {
      throw new Error('Access token not found for phone number');
    }

    await whatsapp.sendMessage(phoneNumberId, accessToken, to, message);
  } catch (error) {
    console.error('Error sending WhatsApp response:', error);
    throw error;
  }
}

/**
 * Get access token for phone number
 */
async function getAccessToken(phoneNumberId) {
  try {
    // Query database for access token
    const pool = await database.initializeMainDb();
    const [rows] = await pool.execute(
      'SELECT access_token FROM whatsapp_connections WHERE phone_number_id = ? LIMIT 1',
      [phoneNumberId]
    );

    if (rows.length > 0) {
      // Decrypt token (in production, use proper encryption)
      return decryptToken(rows[0].access_token);
    }

    return null;
  } catch (error) {
    console.error('Error getting access token:', error);
    return null;
  }
}

/**
 * Extract product name from message
 */
function extractProductName(message) {
  // Simple extraction - can be enhanced with NLP
  const lowerMessage = message.toLowerCase();
  
  // Common patterns
  const patterns = [
    /(?:do you have|is|are|show me|i want|i need|looking for)\s+(.+?)(?:\?|$|\.)/i,
    /(?:product|item)\s+(.+?)(?:\?|$|\.)/i
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
 * Decrypt token (placeholder - implement proper encryption)
 */
function decryptToken(encryptedToken) {
  // In production, use proper decryption
  // For now, return as-is (assuming stored unencrypted for development)
  return encryptedToken;
}

module.exports = { processMessage };

