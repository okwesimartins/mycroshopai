const functions = require('@google-cloud/functions-framework');
const whatsapp = require('../../lib/whatsapp');
const backendApi = require('../../lib/backend-api');
const { processMessage } = require('../process-message');

// ── Message debounce buffer ───────────────────────────────────────────────────
// When a customer sends two messages rapidly (e.g. "Hi" then "I want shoes size 42"),
// WhatsApp delivers them as separate webhooks milliseconds apart.
// Without debouncing, we respond to each separately — double reply, split context.
// With debouncing: wait 1.5s, collect all messages from same customer, process as one.
//
// Key: `${tenantId}:${customerPhone}`
// Value: { timer, messages: [{text, messageId, quotedMessageId}], context }
const pendingMessages = new Map();
const DEBOUNCE_MS = 1500; // 1.5 seconds — enough for rapid successive messages

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
      // Ensure we have a parsed body first (needed for signature + event detection)
      let payload = req.body;
      if ((!payload || Object.keys(payload).length === 0) && req.rawBody != null) {
        try {
          const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
          payload = raw ? JSON.parse(raw) : payload;
        } catch (e) {
          console.error('[webhook] Failed to parse rawBody as JSON:', e.message);
        }
      }
      const hasBody = !!(payload && Object.keys(payload).length > 0);
      console.log('[webhook] POST received', {
        hasBody,
        hasRawBody: !!(req.rawBody != null),
        'x-hub-signature-256': req.headers['x-hub-signature-256'] ? 'present' : 'missing'
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

        const payloadForVerify = rawPayload != null ? rawPayload : JSON.stringify(payload || {});
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

      // Detect event type: only process incoming user messages; ignore status (read/delivered/sent) and echoes
      const entry = payload?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const hasMessages = !!(value?.messages?.length);
      const hasStatuses = !!(value?.statuses?.length);
      const hasEchoes = !!(value?.message_echoes?.length);

      if (!hasMessages) {
        if (hasStatuses) {
          const status = value.statuses[0]?.status || 'unknown';
          console.log('[webhook] Ignoring status event:', status, '(not an incoming message)');
        } else if (hasEchoes) {
          console.log('[webhook] Ignoring message_echo event (outgoing message echo)');
        } else {
          console.log('[webhook] No message data (no messages in payload). entry:', !!entry, 'change.field:', change?.field);
        }
        return res.status(200).json({ status: 'ok' });
      }

      const messageData = whatsapp.parseWebhook(payload);
      if (!messageData) {
        console.error('[webhook] parseWebhook returned null despite hasMessages=true. Payload keys:', payload ? Object.keys(payload) : []);
        return res.status(200).json({ status: 'ok' });
      }

      console.log('[webhook] Incoming message:', { from: messageData.from, text: messageData.text?.substring(0, 100), phoneNumberId: messageData.phoneNumberId });

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
        business_bio,
        subscription_plan,
        default_online_store_id
      } = tenantContext;

      // ── Debounced dispatch ────────────────────────────────────────────────
      // Buffer rapid messages from the same customer and process them together.
      // This prevents double-replies when customer sends "Hi" + "I want shoes" in quick succession.
      const bufferKey = `${tenant_id}:${messageData.from}`;
      const tenantCtx = {
        tenantId: tenant_id,
        accessToken: access_token,
        storeName: store_name,
        businessBio: business_bio,
        subscriptionPlan: subscription_plan || 'enterprise',
        defaultOnlineStoreId: default_online_store_id,
        customerPhone: messageData.from,
        phoneNumberId: messageData.phoneNumberId,
      };

      if (pendingMessages.has(bufferKey)) {
        // Another message from this customer is already buffered — merge it
        const pending = pendingMessages.get(bufferKey);
        clearTimeout(pending.timer);
        pending.messages.push({
          text: messageData.text,
          messageId: messageData.messageId,
          quotedMessageId: messageData.quotedMessageId || null,
        });
        console.log(`[webhook] Buffered message for ${messageData.from} (${pending.messages.length} total)`);

        // Reset the debounce timer
        pending.timer = setTimeout(() => flushMessages(bufferKey), DEBOUNCE_MS);
      } else {
        // First message in this window — start the buffer
        const entry = {
          messages: [{
            text: messageData.text,
            messageId: messageData.messageId,
            quotedMessageId: messageData.quotedMessageId || null,
          }],
          ctx: tenantCtx,
          timer: null,
        };
        entry.timer = setTimeout(() => flushMessages(bufferKey), DEBOUNCE_MS);
        pendingMessages.set(bufferKey, entry);
      }

      // Return 200 immediately — Meta requires fast acknowledgement
      return res.status(200).json({ status: 'ok' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Flush buffered messages ───────────────────────────────────────────────────
// Called after the debounce window closes. Merges all buffered messages from
// one customer into a single combined message and processes it once.
function flushMessages(bufferKey) {
  const pending = pendingMessages.get(bufferKey);
  pendingMessages.delete(bufferKey);
  if (!pending) return;

  const { messages, ctx } = pending;

  // Combine all texts into one message, preserving order
  const combinedText = messages.map(m => m.text).filter(Boolean).join('\n');
  // Use the last messageId for dedup tracking
  const lastMessage  = messages[messages.length - 1];
  // Use the first quoted message context found (if any)
  const quotedMessageId = messages.find(m => m.quotedMessageId)?.quotedMessageId || null;

  if (!combinedText.trim()) return;

  console.log(`[webhook] Flushing ${messages.length} message(s) for ${ctx.customerPhone}: "${combinedText.substring(0, 100)}"`);

  processMessage({
    ...ctx,
    message: combinedText,
    messageId: lastMessage.messageId,
    quotedMessageId,
  }).catch(error => {
    console.error('[webhook] processMessage failed:', error?.message || error);
    if (error?.stack) console.error('[webhook] processMessage stack:', error.stack);
  });
}


