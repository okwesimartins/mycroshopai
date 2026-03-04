const functions = require('@google-cloud/functions-framework');
const whatsapp = require('../../lib/whatsapp');
const backendApi = require('../../lib/backend-api');
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

      // Resolve tenant via backend API (no DB from Cloud)
      const tenantContext = await backendApi.resolveTenant(messageData.phoneNumberId);

      if (!tenantContext) {
        console.error('Tenant not found for phone number:', messageData.phoneNumberId);
        return res.status(200).json({ status: 'ok' }); // Return 200 to prevent retries
      }

      const {
        tenant_id,
        access_token,
        store_name,
        subscription_plan,
        default_online_store_id
      } = tenantContext;

      // Process message asynchronously (API + Firestore only; no DB)
      processMessage({
        tenantId: tenant_id,
        accessToken: access_token,
        storeName: store_name,
        subscriptionPlan: subscription_plan || 'enterprise',
        defaultOnlineStoreId: default_online_store_id,
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


