const functions = require('@google-cloud/functions-framework');
const whatsapp = require('../../lib/whatsapp');
const database = require('../../lib/database');
const { processMessage } = require('../process-message');

/**
 * WhatsApp Webhook Handler
 * Receives webhooks from Meta WhatsApp Business API
 */
functions.http('whatsappWebhook', async (req, res) => {
  try {
    // Handle webhook verification (GET request)
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
        console.log('Webhook verified');
        return res.status(200).send(challenge);
      }

      return res.status(403).send('Forbidden');
    }

    // Handle webhook events (POST request)
    if (req.method === 'POST') {
      // Verify webhook signature
      const signature = req.headers['x-hub-signature-256'];
      const isValid = whatsapp.verifyWebhookSignature(
        signature,
        JSON.stringify(req.body),
        process.env.META_APP_SECRET
      );

      if (!isValid) {
        console.error('Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // Parse webhook payload
      const messageData = whatsapp.parseWebhook(req.body);

      if (!messageData) {
        console.log('No message data in webhook');
        return res.status(200).json({ status: 'ok' });
      }

      console.log('Received message:', messageData);

      // Get tenant from phone number ID
      // In production, you'd have a mapping table: phone_number_id -> tenant_id
      // For now, we'll extract from WhatsApp connection or use a default
      const tenantId = await getTenantFromPhoneNumber(messageData.phoneNumberId);

      if (!tenantId) {
        console.error('Tenant not found for phone number:', messageData.phoneNumberId);
        return res.status(200).json({ status: 'ok' }); // Return 200 to prevent retries
      }

      // Process message asynchronously
      processMessage({
        tenantId,
        customerPhone: messageData.from,
        message: messageData.text,
        messageId: messageData.messageId,
        phoneNumberId: messageData.phoneNumberId
      }).catch(error => {
        console.error('Error processing message:', error);
      });

      // Return 200 immediately to acknowledge receipt
      return res.status(200).json({ status: 'ok' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get tenant ID from WhatsApp phone number ID
 * In production, this would query a database table mapping phone_number_id to tenant_id
 */
async function getTenantFromPhoneNumber(phoneNumberId) {
  try {
    // Option 1: Query database for WhatsApp connection
    // This assumes you have a whatsapp_connections table
    const pool = await database.initializeMainDb();
    const [rows] = await pool.execute(
      'SELECT tenant_id FROM whatsapp_connections WHERE phone_number_id = ? LIMIT 1',
      [phoneNumberId]
    );

    if (rows.length > 0) {
      return rows[0].tenant_id;
    }

    // Option 2: Use environment variable for single tenant (development)
    if (process.env.DEFAULT_TENANT_ID) {
      return parseInt(process.env.DEFAULT_TENANT_ID);
    }

    return null;
  } catch (error) {
    console.error('Error getting tenant from phone number:', error);
    return null;
  }
}

