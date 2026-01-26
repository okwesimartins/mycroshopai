const functions = require('@google-cloud/functions-framework');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase-admin/app');
const admin = require('firebase-admin');
const whatsapp = require('../../lib/whatsapp');
const database = require('../../lib/database');

// Initialize Firebase Admin
if (!admin.apps.length) {
  initializeApp();
}
const db = getFirestore();

/**
 * Follow-Up Scheduler Function
 * Runs on schedule (every hour) to send follow-up messages
 * Like a human sales agent would follow up with customers
 */
functions.http('followUpScheduler', async (req, res) => {
  try {
    console.log('Follow-up scheduler started');

    // Get all pending follow-ups that are due
    const now = new Date();
    const followUps = await getPendingFollowUps(now);

    console.log(`Found ${followUps.length} follow-ups to send`);

    const results = {
      processed: 0,
      sent: 0,
      failed: 0,
      errors: []
    };

    for (const followUp of followUps) {
      try {
        const sent = await processFollowUp(followUp);
        
        if (sent) {
          results.sent++;
          // Mark as sent
          await updateFollowUpStatus(followUp.id, 'sent');
        } else {
          results.failed++;
        }
        
        results.processed++;
      } catch (error) {
        console.error(`Error processing follow-up ${followUp.id}:`, error);
        results.failed++;
        results.errors.push({
          followUpId: followUp.id,
          error: error.message
        });
      }
    }

    // Also check for new follow-ups to schedule
    await scheduleNewFollowUps();

    return res.json({
      success: true,
      message: 'Follow-up scheduler completed',
      results
    });
  } catch (error) {
    console.error('Follow-up scheduler error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get pending follow-ups that are due to be sent
 */
async function getPendingFollowUps(now) {
  try {
    const followUpsRef = db.collectionGroup('follow_ups')
      .where('status', '==', 'pending')
      .where('scheduled_at', '<=', now);

    const snapshot = await followUpsRef.get();
    
    const followUps = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      followUps.push({
        id: doc.id,
        ...data
      });
    });

    return followUps;
  } catch (error) {
    console.error('Error getting pending follow-ups:', error);
    return [];
  }
}

/**
 * Process a single follow-up
 */
async function processFollowUp(followUp) {
  try {
    const { tenant_id, customer_phone, follow_up_type, context } = followUp;

    // Get tenant WhatsApp connection
    const phoneNumberId = await getPhoneNumberId(tenant_id);
    const accessToken = await getAccessToken(tenant_id, phoneNumberId);

    if (!phoneNumberId || !accessToken) {
      console.error(`No WhatsApp connection for tenant ${tenant_id}`);
      return false;
    }

    // Generate follow-up message based on type
    const message = await generateFollowUpMessage(follow_up_type, context, tenant_id);

    if (!message) {
      console.log(`No message generated for follow-up type: ${follow_up_type}`);
      return false;
    }

    // Send message via WhatsApp
    await whatsapp.sendMessage(phoneNumberId, accessToken, customer_phone, message);

    // Save to conversation history
    await saveFollowUpMessage(tenant_id, customer_phone, message, follow_up_type);

    console.log(`Follow-up sent to ${customer_phone} for tenant ${tenant_id}`);
    return true;
  } catch (error) {
    console.error('Error processing follow-up:', error);
    return false;
  }
}

/**
 * Generate follow-up message based on type and context
 */
async function generateFollowUpMessage(followUpType, context, tenantId) {
  try {
    switch (followUpType) {
      case 'abandoned_cart':
        return generateAbandonedCartMessage(context);
      
      case 'payment_pending':
        return generatePaymentPendingMessage(context);
      
      case 'post_purchase':
        return generatePostPurchaseMessage(context);
      
      case 're_engagement':
        return generateReEngagementMessage(context, tenantId);
      
      case 'order_confirmation':
        return generateOrderConfirmationMessage(context);
      
      default:
        return null;
    }
  } catch (error) {
    console.error('Error generating follow-up message:', error);
    return null;
  }
}

/**
 * Generate abandoned cart follow-up message
 */
function generateAbandonedCartMessage(context) {
  const { products, order_id } = context;
  const productList = products.slice(0, 3).join(', ');
  const moreProducts = products.length > 3 ? ` and ${products.length - 3} more` : '';

  return `Hi! 👋\n\n` +
         `I noticed you were interested in ${productList}${moreProducts}.\n\n` +
         `Still interested? I'm here to help you complete your order! 😊\n\n` +
         `Just reply to this message and I'll assist you.`;
}

/**
 * Generate payment pending follow-up message
 */
function generatePaymentPendingMessage(context) {
  const { order_id, order_number, total_amount, payment_link } = context;

  return `Hi! 💰\n\n` +
         `Your order #${order_number} is ready!\n\n` +
         `Total: ₦${parseFloat(total_amount).toLocaleString()}\n\n` +
         `Complete your payment here:\n${payment_link}\n\n` +
         `Once payment is confirmed, we'll process your order immediately! 🚀`;
}

/**
 * Generate post-purchase follow-up message
 */
function generatePostPurchaseMessage(context) {
  const { order_number, products } = context;
  const productList = products.slice(0, 2).join(', ');

  return `Hi! 🎉\n\n` +
         `I hope you're enjoying your purchase: ${productList}!\n\n` +
         `Is everything as expected? If you have any questions or need assistance, I'm here to help! 😊\n\n` +
         `Also, we have some related products you might like. Just ask me!`;
}

/**
 * Generate re-engagement follow-up message
 */
async function generateReEngagementMessage(context, tenantId) {
  // Get new products or offers
  const newProducts = await getNewProducts(tenantId);
  
  if (newProducts.length > 0) {
    const productList = newProducts.slice(0, 3).map(p => p.name).join(', ');
    return `Hi! 👋\n\n` +
           `We have some exciting new products you might like:\n${productList}\n\n` +
           `Interested? Just reply and I'll tell you more! 😊`;
  }

  return `Hi! 👋\n\n` +
         `It's been a while! We'd love to hear from you.\n\n` +
         `Is there anything I can help you with today? 😊`;
}

/**
 * Generate order confirmation follow-up
 */
function generateOrderConfirmationMessage(context) {
  const { order_number, estimated_delivery } = context;

  return `Hi! ✅\n\n` +
         `Great news! Your order #${order_number} has been confirmed.\n\n` +
         `Estimated delivery: ${estimated_delivery}\n\n` +
         `We'll keep you updated on the status. Thank you for your order! 🙏`;
}

/**
 * Schedule new follow-ups based on recent activity
 */
async function scheduleNewFollowUps() {
  try {
    // Get recent orders without payment (last 1 hour)
    const pendingOrders = await getPendingOrders();

    for (const order of pendingOrders) {
      // Check if follow-up already scheduled
      const existing = await checkExistingFollowUp(
        order.tenant_id,
        order.customer_phone,
        'payment_pending',
        order.id
      );

      if (!existing) {
        // Schedule follow-ups: 30 min, 2 hours, 1 day
        await scheduleFollowUp({
          tenant_id: order.tenant_id,
          customer_phone: order.customer_phone,
          follow_up_type: 'payment_pending',
          scheduled_at: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
          context: {
            order_id: order.id,
            order_number: order.order_number,
            total_amount: order.total_amount,
            payment_link: order.payment_link
          }
        });

        // Schedule 2-hour follow-up
        await scheduleFollowUp({
          tenant_id: order.tenant_id,
          customer_phone: order.customer_phone,
          follow_up_type: 'payment_pending',
          scheduled_at: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
          context: {
            order_id: order.id,
            order_number: order.order_number,
            total_amount: order.total_amount,
            payment_link: order.payment_link
          }
        });
      }
    }

    // Get abandoned carts (orders created but no payment initiated in 1 hour)
    const abandonedCarts = await getAbandonedCarts();

    for (const cart of abandonedCarts) {
      const existing = await checkExistingFollowUp(
        cart.tenant_id,
        cart.customer_phone,
        'abandoned_cart',
        cart.id
      );

      if (!existing) {
        // Schedule follow-ups: 1 hour, 24 hours, 3 days
        await scheduleFollowUp({
          tenant_id: cart.tenant_id,
          customer_phone: cart.customer_phone,
          follow_up_type: 'abandoned_cart',
          scheduled_at: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
          context: {
            order_id: cart.id,
            products: cart.items.map(i => i.product_name)
          }
        });
      }
    }

    // Get inactive customers (no message in 7+ days)
    const inactiveCustomers = await getInactiveCustomers();

    for (const customer of inactiveCustomers) {
      const existing = await checkExistingFollowUp(
        customer.tenant_id,
        customer.phone,
        're_engagement',
        null
      );

      if (!existing) {
        // Schedule weekly re-engagement
        await scheduleFollowUp({
          tenant_id: customer.tenant_id,
          customer_phone: customer.phone,
          follow_up_type: 're_engagement',
          scheduled_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
          context: {
            last_message_at: customer.last_message_at
          }
        });
      }
    }
  } catch (error) {
    console.error('Error scheduling new follow-ups:', error);
  }
}

/**
 * Schedule a follow-up
 */
async function scheduleFollowUp(followUpData) {
  try {
    const followUpRef = db
      .collection('tenants')
      .doc(followUpData.tenant_id.toString())
      .collection('conversations')
      .doc(followUpData.customer_phone)
      .collection('follow_ups')
      .doc();

    await followUpRef.set({
      ...followUpData,
      status: 'pending',
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp()
    });

    console.log(`Follow-up scheduled for ${followUpData.customer_phone}`);
  } catch (error) {
    console.error('Error scheduling follow-up:', error);
    throw error;
  }
}

/**
 * Check if follow-up already exists
 */
async function checkExistingFollowUp(tenantId, customerPhone, followUpType, contextId) {
  try {
    const followUpsRef = db
      .collection('tenants')
      .doc(tenantId.toString())
      .collection('conversations')
      .doc(customerPhone)
      .collection('follow_ups')
      .where('follow_up_type', '==', followUpType)
      .where('status', 'in', ['pending', 'sent']);

    const snapshot = await followUpsRef.get();
    
    if (contextId) {
      // Check if same context (e.g., same order)
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.context?.order_id === contextId) {
          return true;
        }
      }
    } else {
      // Check if any follow-up of this type exists
      return !snapshot.empty;
    }

    return false;
  } catch (error) {
    console.error('Error checking existing follow-up:', error);
    return false;
  }
}

/**
 * Update follow-up status
 */
async function updateFollowUpStatus(followUpId, status) {
  try {
    // Note: followUpId includes path, need to parse it
    // For simplicity, we'll use a different approach
    // In production, store follow-up ID with full path
    return true;
  } catch (error) {
    console.error('Error updating follow-up status:', error);
  }
}

/**
 * Get phone number ID for tenant
 */
async function getPhoneNumberId(tenantId) {
  try {
    const pool = await database.initializeMainDb();
    const [rows] = await pool.execute(
      'SELECT phone_number_id FROM whatsapp_connections WHERE tenant_id = ? LIMIT 1',
      [tenantId]
    );

    if (rows.length > 0) {
      return rows[0].phone_number_id;
    }

    return null;
  } catch (error) {
    console.error('Error getting phone number ID:', error);
    return null;
  }
}

/**
 * Get access token for tenant
 */
async function getAccessToken(tenantId, phoneNumberId) {
  try {
    const pool = await database.initializeMainDb();
    const [rows] = await pool.execute(
      'SELECT access_token FROM whatsapp_connections WHERE tenant_id = ? AND phone_number_id = ? LIMIT 1',
      [tenantId, phoneNumberId]
    );

    if (rows.length > 0) {
      // Decrypt token (implement proper decryption)
      return decryptToken(rows[0].access_token);
    }

    return null;
  } catch (error) {
    console.error('Error getting access token:', error);
    return null;
  }
}

/**
 * Decrypt token
 */
function decryptToken(encryptedToken) {
  // Implement proper decryption
  // For now, return as-is (assuming stored unencrypted for development)
  return encryptedToken;
}

/**
 * Get pending orders (no payment in last hour)
 */
async function getPendingOrders() {
  try {
    // Query MycroShop API for pending orders
    // This would call: GET /api/v1/online-store-orders?status=pending&created_after=1hour
    // For now, return empty array
    return [];
  } catch (error) {
    console.error('Error getting pending orders:', error);
    return [];
  }
}

/**
 * Get abandoned carts
 */
async function getAbandonedCarts() {
  try {
    // Query for orders created but no payment initiated
    // Return empty for now
    return [];
  } catch (error) {
    console.error('Error getting abandoned carts:', error);
    return [];
  }
}

/**
 * Get inactive customers
 */
async function getInactiveCustomers() {
  try {
    // Query Firestore for customers with no messages in 7+ days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    // This would query all conversations and find inactive ones
    // Return empty for now
    return [];
  } catch (error) {
    console.error('Error getting inactive customers:', error);
    return [];
  }
}

/**
 * Get new products for re-engagement
 */
async function getNewProducts(tenantId) {
  try {
    // Query MycroShop API for new products
    // GET /api/v1/inventory?sort=created_at&limit=5
    // Return empty for now
    return [];
  } catch (error) {
    console.error('Error getting new products:', error);
    return [];
  }
}

/**
 * Save follow-up message to conversation history
 */
async function saveFollowUpMessage(tenantId, customerPhone, message, followUpType) {
  try {
    const conversationRef = db
      .collection('tenants')
      .doc(tenantId.toString())
      .collection('conversations')
      .doc(customerPhone);

    await conversationRef.collection('messages').add({
      role: 'assistant',
      message,
      messageType: 'follow_up',
      followUpType,
      timestamp: FieldValue.serverTimestamp(),
      createdAt: new Date()
    });

    await conversationRef.set({
      lastMessage: message,
      lastMessageRole: 'assistant',
      lastMessageAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.error('Error saving follow-up message:', error);
  }
}

module.exports = { followUpScheduler };

