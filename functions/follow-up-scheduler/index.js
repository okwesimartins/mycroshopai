/**
 * Follow-Up Scheduler — Intelligent, analytics-driven
 *
 * Algorithm overview:
 *   1. Load all active tenants (those with WhatsApp connections in MySQL).
 *   2. For each tenant, load every conversation from Firestore.
 *   3. Run the analytics scoring engine on each conversation — produces a
 *      numeric score + category (abandoned_cart, hot_lead, warm_lead, etc.).
 *   4. Sort by priority score descending.
 *   5. For each eligible conversation:
 *        a. Check if a follow-up was already sent recently (cooldown).
 *        b. Call POST /api/v1/whatsapp-plans/agent/use-followup to consume one
 *           credit and verify the tenant hasn't hit their follow-up limit.
 *        c. Generate a personalised, context-aware message.
 *        d. Send via WhatsApp and record in Firestore.
 *
 * Triggered via HTTP (Cloud Scheduler fires this endpoint hourly).
 */

const functions  = require('@google-cloud/functions-framework');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp }            = require('firebase-admin/app');
const admin      = require('firebase-admin');
const whatsapp   = require('../../lib/whatsapp');
const database   = require('../../lib/database');
const backendApi = require('../../lib/backend-api');

if (!admin.apps.length) initializeApp();
const db = getFirestore();

// ─── Constants ───────────────────────────────────────────────────────────────

const FOLLOW_UP_COOLDOWNS = {
  abandoned_cart:   30 * 60 * 1000,        // 30 minutes between attempts
  hot_leads:        60 * 60 * 1000,        // 1 hour
  warm_leads:       3  * 60 * 60 * 1000,   // 3 hours
  price_inquirers:  24 * 60 * 60 * 1000,   // 24 hours
  browsers:         72 * 60 * 60 * 1000,   // 3 days
  completed_sales:  72 * 60 * 60 * 1000,   // 3 days
};

const MAX_FOLLOW_UPS_PER_CUSTOMER = {
  abandoned_cart:  4,
  hot_leads:       3,
  warm_leads:      3,
  price_inquirers: 2,
  browsers:        1,
  completed_sales: 1,
};

// ─── Main Handler ─────────────────────────────────────────────────────────────

functions.http('followUpScheduler', async (_req, res) => {
  const log = (...a) => console.log('[follow-up]', ...a);

  try {
    log('Scheduler started');

    const tenants = await getActiveTenants();
    log(`Processing ${tenants.length} tenants`);

    const summary = { tenants: tenants.length, analyzed: 0, sent: 0, skipped: 0, errors: 0 };

    for (const tenant of tenants) {
      try {
        const result = await processTenantFollowUps(tenant);
        summary.analyzed += result.analyzed;
        summary.sent     += result.sent;
        summary.skipped  += result.skipped;
        summary.errors   += result.errors;
      } catch (err) {
        console.error(`[follow-up] Tenant ${tenant.tenant_id} error:`, err.message);
        summary.errors++;
      }
    }

    log('Scheduler complete:', summary);
    return res.json({ success: true, summary });

  } catch (err) {
    console.error('[follow-up] Fatal error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tenant Processing ────────────────────────────────────────────────────────

async function processTenantFollowUps(tenant) {
  const { tenant_id, phone_number_id, access_token, store_name } = tenant;
  const log = (...a) => console.log(`[follow-up:${tenant_id}]`, ...a);
  const result = { analyzed: 0, sent: 0, skipped: 0, errors: 0 };

  // Load all conversations for this tenant
  const conversations = await loadTenantConversations(tenant_id);
  log(`${conversations.length} conversations loaded`);

  // Run analytics and sort by priority
  const analyzed = conversations
    .map(conv => ({ ...conv, analytics: analyzeConversation(conv) }))
    .filter(c => c.analytics.followUpEligible)
    .sort((a, b) => b.analytics.score - a.analytics.score);

  result.analyzed = conversations.length;
  log(`${analyzed.length} follow-up eligible after analytics`);

  for (const conv of analyzed) {
    try {
      const { customer_phone, analytics } = conv;

      // Check cooldown — don't bombard customers
      const lastFollowUp = await getLastFollowUpTime(tenant_id, customer_phone);
      const cooldown = FOLLOW_UP_COOLDOWNS[analytics.category] || 24 * 60 * 60 * 1000;
      if (lastFollowUp && (Date.now() - lastFollowUp) < cooldown) {
        log(`Skipping ${customer_phone} — cooldown active (${analytics.category})`);
        result.skipped++;
        continue;
      }

      // Check max follow-ups per customer
      const followUpCount = await getFollowUpCount(tenant_id, customer_phone);
      const maxFollowUps = MAX_FOLLOW_UPS_PER_CUSTOMER[analytics.category] || 2;
      if (followUpCount >= maxFollowUps) {
        log(`Skipping ${customer_phone} — max follow-ups reached (${followUpCount}/${maxFollowUps})`);
        result.skipped++;
        continue;
      }

      // ── Check follow-up limit with the billing API ────────────────────
      const limitCheck = await backendApi.checkFollowUpLimit(tenant_id);
      if (!limitCheck.allowed) {
        log(`Tenant ${tenant_id} follow-up limit reached: ${limitCheck.reason || limitCheck.message}`);
        // Stop processing this tenant entirely — limit is global per tenant
        break;
      }

      // Generate the follow-up message
      const message = generateFollowUpMessage(analytics, conv, store_name);
      if (!message) { result.skipped++; continue; }

      // Send via WhatsApp
      await whatsapp.sendMessage(phone_number_id, access_token, customer_phone, message);

      // Record in Firestore
      await recordFollowUp(tenant_id, customer_phone, analytics.category, message, analytics);

      log(`Sent ${analytics.category} follow-up to ${customer_phone} (score: ${analytics.score})`);
      result.sent++;

    } catch (err) {
      console.error(`[follow-up:${tenant_id}] Error for ${conv.customer_phone}:`, err.message);
      result.errors++;
    }
  }

  return result;
}

// ─── Analytics Engine ─────────────────────────────────────────────────────────

/**
 * analyzeConversation — scores a conversation and assigns a category.
 *
 * Score = sum of signals × time decay factor
 * Higher score = higher follow-up priority.
 */
function analyzeConversation(conv) {
  const { messages = [], order_state = 'idle', pending_order = null } = conv;

  let rawScore = 0;
  const signals = [];

  // ── Order state signals (highest weight) ────────────────────────────
  if (order_state === 'awaiting_payment' && pending_order?.order_id) {
    rawScore += 35; signals.push('awaiting_payment');
  } else if (order_state === 'awaiting_payment') {
    rawScore += 25; signals.push('awaiting_payment_no_order');
  } else if (order_state === 'collecting_details') {
    rawScore += 25; signals.push('collecting_details');
  } else if (order_state === 'pending_approval') {
    rawScore += 15; signals.push('receipt_submitted');
  } else if (order_state === 'complete' || order_state === 'booking_complete') {
    rawScore += 5;  signals.push('completed_sale');
  }

  if (!messages.length) {
    return { score: 0, rawScore: 0, signals, category: 'browsers', followUpEligible: false,
             productOfInterest: null, hoursSinceLast: 999 };
  }

  // Build search text from user messages only
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => (m.text || '').toLowerCase())
    .join(' ');

  // ── Intent signals ────────────────────────────────────────────────────
  if (/\bi want\b|\bi need\b|\border\b|\bbuy\b|\bpurchase\b|\bpay\b/.test(userText)) {
    rawScore += 20; signals.push('buy_intent');
  }
  if (/how much|price|cost|₦|naira/.test(userText)) {
    rawScore += 20; signals.push('price_inquiry');
  }
  if (/picture|photo|image|show me|let me see/.test(userText)) {
    rawScore += 15; signals.push('product_image_request');
  }
  if (/last price|discount|abeg|too expensive|cheaper|budget/.test(userText)) {
    rawScore += 10; signals.push('price_negotiation');
  }
  if (/size|color|colour|variant|option/.test(userText)) {
    rawScore += 8;  signals.push('variant_inquiry');
  }

  // ── Engagement depth ──────────────────────────────────────────────────
  const turnCount = messages.length;
  if (turnCount >= 10) { rawScore += 8;  signals.push('high_engagement'); }
  else if (turnCount >= 5) { rawScore += 4; }

  // ── Opt-out / negative signals (eliminates follow-up entirely) ────────
  if (/not interested|wrong number|\bstop\b|remove me|unsubscribe|don't contact/.test(userText)) {
    return { score: 0, rawScore: 0, signals: ['opted_out'], category: 'opted_out',
             followUpEligible: false, productOfInterest: null, hoursSinceLast: 0 };
  }

  // ── Time since last user message ──────────────────────────────────────
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const lastAt = lastUserMsg?.timestamp ? new Date(lastUserMsg.timestamp) : null;
  const hoursSinceLast = lastAt ? (Date.now() - lastAt.getTime()) / (1000 * 60 * 60) : 999;

  // Time decay factor — older conversations get lower priority
  let timeFactor;
  if      (hoursSinceLast > 168) timeFactor = 0;     // > 7 days
  else if (hoursSinceLast > 72)  timeFactor = 0.20;  // 3–7 days
  else if (hoursSinceLast > 24)  timeFactor = 0.50;  // 1–3 days
  else if (hoursSinceLast > 6)   timeFactor = 0.75;  // 6–24 hrs
  else if (hoursSinceLast > 1)   timeFactor = 0.90;  // 1–6 hrs
  else                           timeFactor = 1.0;   // < 1 hr

  const score = Math.round(rawScore * timeFactor);

  // ── Category assignment ───────────────────────────────────────────────
  let category;
  let followUpEligible = timeFactor > 0;

  if (signals.includes('completed_sale')) {
    category = 'completed_sales';
    followUpEligible = hoursSinceLast >= 48 && hoursSinceLast <= 120; // post-purchase window
  } else if (signals.includes('receipt_submitted')) {
    category = 'pending_approval';
    followUpEligible = false; // system handles this, not follow-up scheduler
  } else if (signals.includes('awaiting_payment') && pending_order?.order_id) {
    category = 'abandoned_cart';
  } else if (score >= 60 || (signals.includes('buy_intent') && signals.includes('price_inquiry'))) {
    category = 'hot_leads';
  } else if (score >= 30 || signals.includes('buy_intent') || signals.includes('collecting_details')) {
    category = 'warm_leads';
  } else if (signals.includes('price_inquiry') && !signals.includes('buy_intent')) {
    category = 'price_inquirers';
  } else if (hoursSinceLast > 72) {
    category = 'cold_leads';
    followUpEligible = false; // cold leads don't get automated follow-ups
  } else {
    category = 'browsers';
  }

  const productOfInterest = extractProductOfInterest(messages);
  const customerName      = extractCustomerName(messages, pending_order);

  return {
    score, rawScore, timeFactor, signals, category,
    followUpEligible,
    hoursSinceLast: Math.round(hoursSinceLast * 10) / 10,
    productOfInterest,
    customerName,
  };
}

// ─── Message Generation ───────────────────────────────────────────────────────

function generateFollowUpMessage(analytics, conv, storeName) {
  const { category, productOfInterest, customerName } = analytics;
  const { pending_order } = conv;
  const store  = storeName || 'the store';
  const name   = customerName ? customerName.split(' ')[0] : null; // first name only
  const product = productOfInterest;
  const greeting = name ? `Hey ${name}` : 'Hey';

  switch (category) {

    case 'abandoned_cart': {
      const followUpNum = conv._followUpCount || 0;
      const amount      = pending_order?.total_amount
        ? `₦${parseFloat(pending_order.total_amount).toLocaleString()}` : null;

      if (followUpNum === 0) {
        // First nudge — soft and helpful
        return `${greeting} 👋 just checking in — your ${product ? `order for the ${product}` : 'order'} is still waiting for payment.`
          + (amount ? ` Total is ${amount}.` : '')
          + ` Let me know if you need help sorting it out.`;
      }
      if (followUpNum === 1) {
        // Second nudge — add mild urgency
        return `${greeting}, the ${product || 'item'} you ordered is still reserved for you.`
          + (amount ? ` Just send in your payment of ${amount} to confirm.` : ` Send your payment to confirm.`)
          + ` We hold for 24hrs max after that it goes back to stock.`;
      }
      if (followUpNum === 2) {
        // Third nudge — final push
        return `Last reminder ${name ? name : ''} — your ${product || 'order'} is about to be released back into stock.`
          + ` Tap here to sort the payment and lock it in.`;
      }
      return null; // max attempts reached
    }

    case 'hot_leads': {
      const followUpNum = conv._followUpCount || 0;
      if (followUpNum === 0) {
        return product
          ? `${greeting} 👋 you were looking at the ${product} earlier — it's still available. Want me to lock one in for you?`
          : `${greeting} 👋 you were close to placing an order earlier. Still interested? I can sort it out for you right now.`;
      }
      if (followUpNum === 1) {
        return product
          ? `Still thinking about the ${product}? ${name ? name : 'We'} can have it sorted and on its way quickly.`
          : `Still here if you need me. Just say the word and I'll get your order going.`;
      }
      return null;
    }

    case 'warm_leads': {
      const followUpNum = conv._followUpCount || 0;
      if (followUpNum === 0) {
        return product
          ? `${greeting} 👋 the ${product} you checked out earlier is still available at ${store}. Want more details or ready to order?`
          : `${greeting} 👋 just checking in — anything from ${store} catch your eye? Happy to help you find the right thing.`;
      }
      if (followUpNum === 1) {
        return product
          ? `The ${product} is still here${name ? `, ${name}` : ''}. Want me to put one aside for you?`
          : `Still here if you're looking for something specific — just say the word.`;
      }
      return null;
    }

    case 'price_inquirers': {
      const followUpNum = conv._followUpCount || 0;
      if (followUpNum === 0) {
        return product
          ? `${greeting} 👋 you asked about the ${product} earlier. Still interested? Prices are the same — happy to set one aside for you.`
          : `${greeting} 👋 you were checking our prices earlier. If budget was a concern, let me know — I can see what options fit.`;
      }
      return null;
    }

    case 'browsers': {
      return product
        ? `${greeting} 👋 you were browsing earlier. The ${product} is still in stock if you're still interested.`
        : `${greeting} 👋 just checking in — anything from ${store} take your eye? Happy to help you find something.`;
    }

    case 'completed_sales': {
      const orderNum = pending_order?.order_number;
      return `${greeting} 🙌 hope your ${product || 'order'}${orderNum ? ` (#${orderNum})` : ''} arrived well.`
        + ` Let us know if everything is good or if there's anything we can sort out for you.`;
    }

    default:
      return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractProductOfInterest(messages) {
  // Walk messages in reverse — most recent product mention wins
  const pricePattern = /([A-Za-z][A-Za-z0-9 ]{2,30})\s*[-–]\s*(?:from\s+)?₦/g;

  for (const msg of [...messages].reverse()) {
    const text = msg.text || '';
    let m;
    if ((m = pricePattern.exec(text))) return m[1].trim();
    if (msg.role === 'user') {
      const lower = text.toLowerCase();
      const knownPatterns = [
        /(?:the|a|an)\s+([a-z][a-z0-9 ]{2,30})(?:\s+in|\s+size|\s+color|\s*\?|$)/i,
        /(?:want|need|order|buy)\s+(?:the\s+)?([a-z][a-z0-9 ]{2,30})/i,
        /(?:jordan|air max|air force|nike|adidas|puma|vans|converse|loafer|boot|sandal|sneaker|clack|clog)[a-z0-9 ]*/i,
      ];
      for (const p of knownPatterns) {
        if ((m = lower.match(p))) return m[0].replace(/^(want|need|order|buy|the|a|an)\s+/i, '').trim();
      }
    }
  }
  return null;
}

function extractCustomerName(messages, pendingOrder) {
  if (pendingOrder?.customer_name) return pendingOrder.customer_name;
  // Look for name in conversation (when AI asked "what's your name?")
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = (msg.text || '').trim();
    // If it's a short message (1-3 words) that comes after the AI asked for name, it might be the name
    const words = text.split(/\s+/);
    if (words.length <= 3 && /^[A-Z]/.test(text) && !/^\d/.test(text)) {
      // Check if previous AI message asked for name
      const prevAI = messages[i - 1];
      if (prevAI?.role !== 'user' && /name|who am i/i.test(prevAI?.text || '')) {
        return text;
      }
    }
  }
  return null;
}

// ─── Firestore Helpers ────────────────────────────────────────────────────────

async function loadTenantConversations(tenantId) {
  try {
    const convsSnap = await db
      .collection('tenants').doc(tenantId.toString())
      .collection('conversations')
      .get();

    const conversations = [];

    await Promise.all(convsSnap.docs.map(async convDoc => {
      const customerPhone = convDoc.id;
      try {
        const [messagesSnap, orderStateDoc] = await Promise.all([
          db.collection('tenants').doc(tenantId.toString())
            .collection('conversations').doc(customerPhone)
            .collection('messages')
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get(),
          db.collection('tenants').doc(tenantId.toString())
            .collection('order_states').doc(customerPhone)
            .get(),
        ]);

        const messages = [];
        messagesSnap.forEach(doc => {
          const d = doc.data();
          messages.push({ role: d.role, text: d.message, timestamp: d.timestamp?.toDate?.() || d.createdAt });
        });
        messages.reverse(); // oldest first

        const orderState = orderStateDoc.exists ? orderStateDoc.data() : null;

        conversations.push({
          customer_phone: customerPhone,
          messages,
          order_state:   orderState?.state || 'idle',
          pending_order: orderState?.pending_order || null,
        });
      } catch (err) {
        console.error(`[follow-up] loadConversation error for ${customerPhone}:`, err.message);
      }
    }));

    return conversations;
  } catch (err) {
    console.error('[follow-up] loadTenantConversations error:', err.message);
    return [];
  }
}

async function getLastFollowUpTime(tenantId, customerPhone) {
  try {
    const snap = await db
      .collection('tenants').doc(tenantId.toString())
      .collection('conversations').doc(customerPhone)
      .collection('follow_ups')
      .where('status', '==', 'sent')
      .orderBy('sent_at', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return null;
    const data = snap.docs[0].data();
    return data.sent_at?.toDate?.()?.getTime() || null;
  } catch (err) {
    return null;
  }
}

async function getFollowUpCount(tenantId, customerPhone) {
  try {
    const snap = await db
      .collection('tenants').doc(tenantId.toString())
      .collection('conversations').doc(customerPhone)
      .collection('follow_ups')
      .where('status', '==', 'sent')
      .get();
    return snap.size;
  } catch (err) {
    return 0;
  }
}

async function recordFollowUp(tenantId, customerPhone, category, message, analytics) {
  const convRef = db
    .collection('tenants').doc(tenantId.toString())
    .collection('conversations').doc(customerPhone);

  const batch = db.batch();

  // Record the follow-up entry
  const followUpRef = convRef.collection('follow_ups').doc();
  batch.set(followUpRef, {
    status:    'sent',
    category,
    message,
    score:     analytics.score,
    signals:   analytics.signals,
    sent_at:   FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
  });

  // Save to conversation history so it appears in chat view
  const msgRef = convRef.collection('messages').doc();
  batch.set(msgRef, {
    role:        'assistant',
    message,
    messageType: 'follow_up',
    followUpCategory: category,
    timestamp:   FieldValue.serverTimestamp(),
    createdAt:   new Date(),
  });

  // Update conversation metadata
  batch.set(convRef, {
    lastMessage:     message,
    lastMessageRole: 'assistant',
    lastMessageAt:   FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
  }, { merge: true });

  await batch.commit();
}

// ─── Tenant Loader ────────────────────────────────────────────────────────────

async function getActiveTenants() {
  try {
    const pool = await database.initializeMainDb();
    const [rows] = await pool.execute(`
      SELECT
        wc.tenant_id,
        wc.phone_number_id,
        wc.access_token,
        t.name AS store_name
      FROM whatsapp_connections wc
      JOIN tenants t ON t.id = wc.tenant_id
      WHERE wc.access_token IS NOT NULL
        AND wc.phone_number_id IS NOT NULL
    `);

    return rows.map(r => ({
      tenant_id:       r.tenant_id,
      phone_number_id: r.phone_number_id,
      access_token:    r.access_token,
      store_name:      r.store_name || 'the store',
    }));
  } catch (err) {
    console.error('[follow-up] getActiveTenants error:', err.message);
    return [];
  }
}
