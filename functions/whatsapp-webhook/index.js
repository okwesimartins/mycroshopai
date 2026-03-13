const functions = require('@google-cloud/functions-framework');
const whatsapp = require('../../lib/whatsapp');
const backendApi = require('../../lib/backend-api');
const { processMessage } = require('../process-message');

/**
 * WhatsApp Webhook Handler
 *
 * IMPORTANT — Cloud Functions architecture note:
 * setTimeout/setInterval are NOT reliable here. The Cloud Function process
 * exits as soon as res.status(200) is sent — any timers scheduled after that
 * are killed immediately. Do NOT use debounce timers in this file.
 *
 * Rapid successive messages (customer sends "Hi" then "I want shoes" quickly):
 * These arrive as separate webhooks and are handled correctly by the dedup
 * system in process-message — each message is processed independently.
 * The conversation history in Firestore gives Gemini full context on each call.
 * This is the correct architecture for serverless functions.
 */

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Hub-Signature-256');
}

functions.http('whatsappWebhook', async (req, res) => {
  setCors(res);

  try {
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    // Webhook verification (GET)
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

    // Incoming messages (POST)
    if (req.method === 'POST') {
      let payload = req.body;
      if ((!payload || Object.keys(payload).length === 0) && req.rawBody != null) {
        try {
          const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
          payload = raw ? JSON.parse(raw) : payload;
        } catch (e) {
          console.error('[webhook] Failed to parse rawBody as JSON:', e.message);
        }
      }

      console.log('[webhook] POST received', {
        hasBody: !!(payload && Object.keys(payload).length > 0),
        hasRawBody: !!(req.rawBody != null),
        'x-hub-signature-256': req.headers['x-hub-signature-256'] ? 'present' : 'missing'
      });

      // Signature verification
      const skipSignatureCheck = process.env.META_SKIP_SIGNATURE_CHECK === 'true';
      if (!skipSignatureCheck) {
        const rawPayload = req.rawBody != null
          ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
          : null;

        if (rawPayload == null) {
          console.warn('[webhook] raw body not available — signature check may fail. Set META_SKIP_SIGNATURE_CHECK=true to bypass.');
        }

        const payloadForVerify = rawPayload != null ? rawPayload : JSON.stringify(payload || {});
        const signature = req.headers['x-hub-signature-256'];
        const isValid = signature && process.env.META_APP_SECRET &&
          whatsapp.verifyWebhookSignature(signature, payloadForVerify, process.env.META_APP_SECRET);

        if (!isValid) {
          console.error('[webhook] Invalid signature');
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } else {
        console.warn('[webhook] Skipping signature verification (META_SKIP_SIGNATURE_CHECK=true)');
      }

      // Filter — only process incoming user messages
      const entry   = payload?.entry?.[0];
      const change  = entry?.changes?.[0];
      const value   = change?.value;
      const hasMessages = !!(value?.messages?.length);

      if (!hasMessages) {
        if (value?.statuses?.length) {
          console.log('[webhook] Ignoring status event:', value.statuses[0]?.status);
        } else if (value?.message_echoes?.length) {
          console.log('[webhook] Ignoring echo event');
        } else {
          console.log('[webhook] No messages in payload');
        }
        return res.status(200).json({ status: 'ok' });
      }

      const messageData = whatsapp.parseWebhook(payload);
      if (!messageData) {
        console.error('[webhook] parseWebhook returned null');
        return res.status(200).json({ status: 'ok' });
      }

      console.log('[webhook] Message:', {
        from: messageData.from,
        text: messageData.text?.substring(0, 100),
        quoted: messageData.quotedMessageId || null,
      });

      // Resolve tenant
      const tenantContext = await backendApi.resolveTenant(messageData.phoneNumberId);
      if (!tenantContext) {
        console.error('[webhook] Tenant not found for phoneNumberId:', messageData.phoneNumberId);
        return res.status(200).json({ status: 'ok' });
      }

      const { tenant_id, access_token, store_name, business_bio, subscription_plan, default_online_store_id } = tenantContext;

      // ── Dispatch — fire and forget ────────────────────────────────────────
      // Return 200 to Meta FIRST, then process. Meta requires acknowledgement
      // within 20 seconds or it will retry. processMessage can take 2-4 seconds.
      //
      // We must call processMessage BEFORE sending the response in Cloud Functions,
      // because the process exits when res is sent and any pending async work dies.
      // Solution: await processMessage, THEN send 200.
      // Meta is fine with responses up to 20s — our processing is well under that.
      await processMessage({
        tenantId:            tenant_id,
        accessToken:         access_token,
        storeName:           store_name,
        businessBio:         business_bio,
        subscriptionPlan:    subscription_plan || 'enterprise',
        defaultOnlineStoreId: default_online_store_id,
        customerPhone:       messageData.from,
        message:             messageData.text,
        messageId:           messageData.messageId,
        phoneNumberId:       messageData.phoneNumberId,
        quotedMessageId:     messageData.quotedMessageId || null,
      }).catch(error => {
        console.error('[webhook] processMessage failed:', error?.message || error);
        if (error?.stack) console.error(error.stack.split('\n').slice(0, 4).join('\n'));
      });

      return res.status(200).json({ status: 'ok' });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('[webhook] Handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
