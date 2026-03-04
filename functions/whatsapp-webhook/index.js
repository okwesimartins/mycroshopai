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
      // Basic logging to confirm that POST webhooks are reaching the service
      console.log('Incoming WhatsApp webhook', {
        method: req.method,
        path: req.path,
        headers: {
          'x-hub-signature-256': req.headers['x-hub-signature-256'],
          'user-agent': req.headers['user-agent']
        }
      });

      const skipSignatureCheck = process.env.META_SKIP_SIGNATURE_CHECK === 'true';

      if (!skipSignatureCheck) {
        // Verify webhook signature using the raw request body when available
        const rawPayload = req.rawBody
          ? req.rawBody.toString('utf8')
          : JSON.stringify(req.body || {});

        const signature = req.headers['x-hub-signature-256'];
        const isValid = whatsapp.verifyWebhookSignature(
          signature,
          rawPayload,
          process.env.META_APP_SECRET
        );

        if (!isValid) {
          console.error('Invalid webhook signature');
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } else {
        console.warn('Skipping WhatsApp webhook signature verification because META_SKIP_SIGNATURE_CHECK=true');
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
    const debugStart = Date.now();
    console.log('[WhatsAppWebhook] Resolving tenant from phone number', {
      phoneNumberId
    });

    // Option 1: Query database for WhatsApp connection (if DB is reachable)
    // This assumes you have a whatsapp_connections table
    const pool = await database.initializeMainDb();
    console.log('[WhatsAppWebhook] Main DB pool acquired in', `${Date.now() - debugStart}ms`, {
      mainDbHost: process.env.MAIN_DB_HOST,
      mainDbName: process.env.MAIN_DB_NAME || 'mycroshop_main'
    });

    const queryStart = Date.now();
    const [rows] = await pool.execute(
      'SELECT tenant_id FROM whatsapp_connections WHERE phone_number_id = ? LIMIT 1',
      [phoneNumberId]
    );
    console.log('[WhatsAppWebhook] Query completed in', `${Date.now() - queryStart}ms`, {
      rowsFound: rows.length
    });

    if (rows.length > 0) {
      return rows[0].tenant_id;
    }

    // Option 2: Use environment variable for single tenant (development)
    if (process.env.DEFAULT_TENANT_ID) {
      console.log('[WhatsAppWebhook] Falling back to DEFAULT_TENANT_ID from env');
      return parseInt(process.env.DEFAULT_TENANT_ID, 10);
    }

    console.warn('[WhatsAppWebhook] No tenant mapping and no DEFAULT_TENANT_ID configured');
    return null;
  } catch (error) {
    console.error('[WhatsAppWebhook] Error getting tenant from phone number:', {
      phoneNumberId,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      message: error.message
    });
    return null;
  }
}

