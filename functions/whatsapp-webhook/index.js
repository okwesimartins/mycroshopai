const functions = require('@google-cloud/functions-framework');
const whatsapp = require('../../lib/whatsapp');
const backendApi = require('../../lib/backend-api');
const { processMessage } = require('../process-message');

/**
 * WhatsApp Webhook Handler
 * Receives webhooks from Meta WhatsApp Business API.
 *
 * For Meta to reach this URL:
 * 1. Cloud Run / Cloud Functions must allow unauthenticated invocations (so Meta can call without IAM).
 * 2. If Meta never hits the URL: check firewall, URL in Meta dashboard, and HTTPS.
 * 3. If you get 401: signature verification failed. Set META_SKIP_SIGNATURE_CHECK=true to test, or ensure raw body is available for verification.
 */

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Hub-Signature-256');
}

functions.http('whatsappWebhook', async (req, res) => {
  setCors(res);

  try {
    // OPTIONS (CORS preflight) – so no policy blocks Meta or proxies
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

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
      const bodyPreview = req.body != null
        ? JSON.stringify(req.body).substring(0, 1500)
        : '(no body)';
      console.log('Incoming WhatsApp webhook', {
        method: req.method,
        path: req.path,
        hasBody: !!req.body,
        hasRawBody: !!(req.rawBody != null),
        'x-hub-signature-256': req.headers['x-hub-signature-256'] ? 'present' : 'missing',
        bodyPreview
      });

      const skipSignatureCheck = process.env.META_SKIP_SIGNATURE_CHECK === 'true';

      if (!skipSignatureCheck) {
        const rawPayload = req.rawBody != null
          ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
          : null;

        if (rawPayload == null) {
          console.warn(
            'Webhook signature verification: raw body not available (req.rawBody missing). ' +
            'Verification may fail. Set META_SKIP_SIGNATURE_CHECK=true to test delivery, or configure your runtime to preserve raw body.'
          );
        }

        const payloadForVerify = rawPayload != null ? rawPayload : JSON.stringify(req.body || {});
        const signature = req.headers['x-hub-signature-256'];
        const isValid = signature && process.env.META_APP_SECRET &&
          whatsapp.verifyWebhookSignature(signature, payloadForVerify, process.env.META_APP_SECRET);

        if (!isValid) {
          console.error('Invalid webhook signature (check META_APP_SECRET and raw body)');
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } else {
        console.warn('Skipping WhatsApp webhook signature verification (META_SKIP_SIGNATURE_CHECK=true)');
      }

      // Ensure we have a parsed body (some runtimes leave req.body empty and only set rawBody)
      let payload = req.body;
      if ((!payload || Object.keys(payload).length === 0) && req.rawBody != null) {
        try {
          const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
          payload = raw ? JSON.parse(raw) : payload;
        } catch (e) {
          console.error('Failed to parse rawBody as JSON:', e.message);
        }
      }

      // Parse webhook payload
      const messageData = whatsapp.parseWebhook(payload);

      if (!messageData) {
        const payloadPreview = payload != null ? JSON.stringify(payload).substring(0, 1500) : '(no payload)';
        console.log('No message data in webhook (see parseWebhook logs above for reason). Payload used:', payloadPreview);
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


