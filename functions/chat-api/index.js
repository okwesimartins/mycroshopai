/**
 * Chat API — REST endpoints for the tenant dashboard
 *
 * Allows business owners to:
 *   • View all customer conversations, categorised by analytics
 *   • Read full chat history with any customer
 *   • Reply to customers directly from the dashboard
 *   • See aggregate analytics (conversion stats, hot leads, etc.)
 *
 * Authentication: every request must include header  x-api-key: <AI_AGENT_API_KEY>
 *                 and query param                    tenant_id: <number>
 *
 * Routing (all under the single Cloud Function URL):
 *   GET  /chats                     → all conversations + analytics categories
 *   GET  /chats/:phone              → full history for one customer
 *   POST /chats/:phone/reply        → send a message as the store owner
 *   GET  /analytics                 → aggregate stats summary
 */

const functions  = require('@google-cloud/functions-framework');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp }            = require('firebase-admin/app');
const admin      = require('firebase-admin');
const whatsapp   = require('../../lib/whatsapp');
const database   = require('../../lib/database');

if (!admin.apps.length) initializeApp();
const db = getFirestore();

const API_KEY = process.env.AI_AGENT_API_KEY || process.env.MYCROSHOP_API_KEY;

// ─── Router ───────────────────────────────────────────────────────────────────

functions.http('chatApi', async (req, res) => {
  // CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  // Auth
  const providedKey = req.headers['x-api-key'];
  if (!API_KEY || providedKey !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // tenant_id required for every request
  const tenantId = req.query.tenant_id || req.body?.tenant_id;
  if (!tenantId) {
    return res.status(400).json({ success: false, error: 'tenant_id is required' });
  }

  // Parse path — strip leading slash and Cloud Function prefix
  const rawPath  = (req.path || '/').replace(/^\/chatApi/, '');
  const segments = rawPath.split('/').filter(Boolean);
  // segments examples:
  //   []                  → /chats  (root = all conversations)
  //   ['chats']           → /chats
  //   ['chats', '+234...']→ /chats/:phone
  //   ['chats', '+234...', 'reply'] → /chats/:phone/reply
  //   ['analytics']       → /analytics

  const route = segments[0] || 'chats';

  try {
    if (route === 'analytics' && req.method === 'GET') {
      return await handleAnalytics(req, res, tenantId);
    }

    if (route === 'chats') {
      const phone  = segments[1] ? decodeURIComponent(segments[1]) : null;
      const action = segments[2];

      if (!phone) {
        // GET /chats — all conversations
        return await handleListChats(req, res, tenantId);
      }

      if (action === 'reply' && req.method === 'POST') {
        // POST /chats/:phone/reply
        return await handleReply(req, res, tenantId, phone);
      }

      if (!action && req.method === 'GET') {
        // GET /chats/:phone
        return await handleGetChat(req, res, tenantId, phone);
      }
    }

    return res.status(404).json({ success: false, error: 'Route not found' });
  } catch (err) {
    console.error('[chat-api] Unhandled error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /chats ───────────────────────────────────────────────────────────────

async function handleListChats(req, res, tenantId) {
  const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
  const filterCategory = req.query.category || null; // optional filter

  // Load all conversation docs (metadata only — not full message history)
  const convsSnap = await db
    .collection('tenants').doc(tenantId.toString())
    .collection('conversations')
    .orderBy('lastMessageAt', 'desc')
    .get();

  if (convsSnap.empty) {
    return res.json({ success: true, total: 0, categories: buildEmptyCategories(), conversations: [] });
  }

  // Load messages + order states in parallel (batched)
  const rawConvs = await loadConversationsBatch(tenantId, convsSnap.docs);

  // Run analytics on each conversation
  const analyzed = rawConvs.map(conv => {
    const analytics = scoreConversation(conv);
    const convMeta  = convsSnap.docs.find(d => d.id === conv.customer_phone)?.data() || {};
    return {
      customer_phone:  conv.customer_phone,
      last_message:    convMeta.lastMessage || '',
      last_message_at: convMeta.lastMessageAt?.toDate?.()?.toISOString() || null,
      last_message_role: convMeta.lastMessageRole || 'user',
      message_count:   conv.messages.length,
      category:        analytics.category,
      score:           analytics.score,
      signals:         analytics.signals,
      hours_since_last: analytics.hoursSinceLast,
      product_of_interest: analytics.productOfInterest,
      customer_name:   analytics.customerName,
      order_state:     conv.order_state,
      pending_order:   conv.pending_order ? sanitizePendingOrder(conv.pending_order) : null,
      follow_up_eligible: analytics.followUpEligible,
    };
  });

  // Apply category filter
  const filtered = filterCategory
    ? analyzed.filter(c => c.category === filterCategory)
    : analyzed;

  // Sort: by score desc, then last_message_at desc
  filtered.sort((a, b) => b.score - a.score || new Date(b.last_message_at) - new Date(a.last_message_at));

  // Paginate
  const total  = filtered.length;
  const offset = (page - 1) * limit;
  const paged  = filtered.slice(offset, offset + limit);

  // Build category summary counts
  const categories = buildCategoryCounts(analyzed);

  return res.json({
    success: true,
    total,
    page,
    limit,
    has_more: offset + limit < total,
    categories,
    conversations: paged,
  });
}

// ─── GET /chats/:phone ────────────────────────────────────────────────────────

async function handleGetChat(req, res, tenantId, customerPhone) {
  const msgLimit = Math.min(200, parseInt(req.query.limit || '100', 10));

  const [messagesSnap, orderStateDoc, followUpsSnap] = await Promise.all([
    db.collection('tenants').doc(tenantId.toString())
      .collection('conversations').doc(customerPhone)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .limitToLast(msgLimit)
      .get(),
    db.collection('tenants').doc(tenantId.toString())
      .collection('order_states').doc(customerPhone)
      .get(),
    db.collection('tenants').doc(tenantId.toString())
      .collection('conversations').doc(customerPhone)
      .collection('follow_ups')
      .orderBy('sent_at', 'desc')
      .limit(10)
      .get(),
  ]);

  if (messagesSnap.empty) {
    return res.status(404).json({ success: false, error: 'Conversation not found' });
  }

  const messages = [];
  messagesSnap.forEach(doc => {
    const d = doc.data();
    messages.push({
      id:          doc.id,
      role:        d.role,
      text:        d.message,
      message_type: d.messageType || 'chat',
      timestamp:   d.timestamp?.toDate?.()?.toISOString() || d.createdAt?.toISOString?.() || null,
    });
  });

  const orderState = orderStateDoc.exists ? {
    state:         orderStateDoc.data().state,
    pending_order: sanitizePendingOrder(orderStateDoc.data().pending_order),
  } : null;

  const followUps = [];
  followUpsSnap.forEach(doc => {
    const d = doc.data();
    followUps.push({
      id:       doc.id,
      category: d.category,
      message:  d.message,
      score:    d.score,
      sent_at:  d.sent_at?.toDate?.()?.toISOString() || null,
    });
  });

  // Run analytics on this specific conversation
  const analytics = scoreConversation({
    customer_phone: customerPhone,
    messages: messages.map(m => ({ role: m.role, text: m.text, timestamp: m.timestamp })),
    order_state:   orderState?.state || 'idle',
    pending_order: orderState?.pending_order || null,
  });

  return res.json({
    success: true,
    customer_phone: customerPhone,
    order_state:    orderState,
    analytics: {
      score:              analytics.score,
      category:           analytics.category,
      signals:            analytics.signals,
      product_of_interest: analytics.productOfInterest,
      customer_name:      analytics.customerName,
      follow_up_eligible: analytics.followUpEligible,
    },
    follow_ups_sent: followUps,
    messages,
  });
}

// ─── POST /chats/:phone/reply ─────────────────────────────────────────────────

async function handleReply(req, res, tenantId, customerPhone) {
  const { message } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }

  // Get WhatsApp credentials for this tenant
  const creds = await getTenantWhatsAppCreds(tenantId);
  if (!creds) {
    return res.status(400).json({ success: false, error: 'No WhatsApp connection found for this tenant' });
  }

  const { phone_number_id, access_token } = creds;

  // Send via WhatsApp
  await whatsapp.sendMessage(phone_number_id, access_token, customerPhone, message.trim());

  // Save to conversation history (role = 'assistant' so it appears as agent message in chat)
  const convRef = db
    .collection('tenants').doc(tenantId.toString())
    .collection('conversations').doc(customerPhone);

  const msgRef = await convRef.collection('messages').add({
    role:        'assistant',
    message:     message.trim(),
    messageType: 'manual_reply',
    timestamp:   FieldValue.serverTimestamp(),
    createdAt:   new Date(),
  });

  await convRef.set({
    lastMessage:     message.trim(),
    lastMessageRole: 'assistant',
    lastMessageAt:   FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
  }, { merge: true });

  return res.json({
    success: true,
    message_id: msgRef.id,
    sent_to:    customerPhone,
    text:       message.trim(),
  });
}

// ─── GET /analytics ───────────────────────────────────────────────────────────

async function handleAnalytics(req, res, tenantId) {
  const convsSnap = await db
    .collection('tenants').doc(tenantId.toString())
    .collection('conversations')
    .get();

  if (convsSnap.empty) {
    return res.json({ success: true, total_conversations: 0, categories: buildEmptyCategories(), top_leads: [] });
  }

  const rawConvs = await loadConversationsBatch(tenantId, convsSnap.docs);

  const analyzed = rawConvs.map(conv => {
    const a = scoreConversation(conv);
    const meta = convsSnap.docs.find(d => d.id === conv.customer_phone)?.data() || {};
    return { ...a, customer_phone: conv.customer_phone, last_message_at: meta.lastMessageAt?.toDate?.() };
  });

  const categoryCounts = buildCategoryCounts(analyzed);

  // Top leads sorted by score
  const topLeads = analyzed
    .filter(c => c.followUpEligible && c.score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(c => ({
      customer_phone:    c.customer_phone,
      category:          c.category,
      score:             c.score,
      signals:           c.signals,
      product_of_interest: c.productOfInterest,
      customer_name:     c.customerName,
      last_message_at:   c.last_message_at?.toISOString?.() || null,
    }));

  // Revenue metrics — count completed orders and those awaiting payment
  const completedSales = analyzed.filter(c => c.category === 'completed_sales').length;
  const abandonedCarts = analyzed.filter(c => c.category === 'abandoned_cart').length;
  const hotLeads       = analyzed.filter(c => c.category === 'hot_leads').length;
  const warmLeads      = analyzed.filter(c => c.category === 'warm_leads').length;
  const conversionRate = convsSnap.size > 0
    ? Math.round((completedSales / convsSnap.size) * 100 * 10) / 10
    : 0;

  return res.json({
    success: true,
    total_conversations: convsSnap.size,
    completed_sales:     completedSales,
    abandoned_carts:     abandonedCarts,
    hot_leads:           hotLeads,
    warm_leads:          warmLeads,
    conversion_rate_pct: conversionRate,
    categories:          categoryCounts,
    top_leads:           topLeads,
  });
}

// ─── Analytics Scoring (mirrors follow-up-scheduler logic) ───────────────────

function scoreConversation(conv) {
  const { messages = [], order_state = 'idle', pending_order = null } = conv;

  let rawScore = 0;
  const signals = [];

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
             productOfInterest: null, customerName: null, hoursSinceLast: 999 };
  }

  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => (m.text || '').toLowerCase())
    .join(' ');

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
  if (messages.length >= 10) { rawScore += 8;  signals.push('high_engagement'); }
  else if (messages.length >= 5) { rawScore += 4; }

  if (/not interested|wrong number|\bstop\b|remove me|unsubscribe/.test(userText)) {
    return { score: 0, rawScore: 0, signals: ['opted_out'], category: 'opted_out',
             followUpEligible: false, productOfInterest: null, customerName: null, hoursSinceLast: 0 };
  }

  // Time since last user message
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const lastAt = lastUserMsg?.timestamp ? new Date(lastUserMsg.timestamp) : null;
  const hoursSinceLast = lastAt ? (Date.now() - lastAt.getTime()) / (1000 * 60 * 60) : 999;

  let timeFactor;
  if      (hoursSinceLast > 168) timeFactor = 0;
  else if (hoursSinceLast > 72)  timeFactor = 0.20;
  else if (hoursSinceLast > 24)  timeFactor = 0.50;
  else if (hoursSinceLast > 6)   timeFactor = 0.75;
  else if (hoursSinceLast > 1)   timeFactor = 0.90;
  else                           timeFactor = 1.0;

  const score = Math.round(rawScore * timeFactor);

  let category;
  let followUpEligible = timeFactor > 0;

  if (signals.includes('completed_sale'))                                       { category = 'completed_sales'; }
  else if (signals.includes('receipt_submitted'))                               { category = 'pending_approval'; followUpEligible = false; }
  else if (signals.includes('awaiting_payment') && pending_order?.order_id)    { category = 'abandoned_cart'; }
  else if (score >= 60 || (signals.includes('buy_intent') && signals.includes('price_inquiry'))) { category = 'hot_leads'; }
  else if (score >= 30 || signals.includes('buy_intent') || signals.includes('collecting_details')) { category = 'warm_leads'; }
  else if (signals.includes('price_inquiry'))                                   { category = 'price_inquirers'; }
  else if (hoursSinceLast > 72)                                                 { category = 'cold_leads'; followUpEligible = false; }
  else                                                                           { category = 'browsers'; }

  return {
    score, rawScore, timeFactor, signals, category,
    followUpEligible,
    hoursSinceLast: Math.round(hoursSinceLast * 10) / 10,
    productOfInterest: extractProductOfInterest(messages),
    customerName:      extractCustomerName(messages, pending_order),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractProductOfInterest(messages) {
  const pricePattern = /([A-Za-z][A-Za-z0-9 ]{2,30})\s*[-–]\s*(?:from\s+)?₦/g;
  for (const msg of [...messages].reverse()) {
    const text = msg.text || '';
    let m;
    if ((m = pricePattern.exec(text))) return m[1].trim();
    if (msg.role === 'user') {
      const lower = text.toLowerCase();
      const patterns = [
        /(?:the|a|an)\s+([a-z][a-z0-9 ]{2,30})(?:\s+in|\s+size|\s+color|\s*\?|$)/i,
        /(?:want|need|order|buy)\s+(?:the\s+)?([a-z][a-z0-9 ]{2,30})/i,
        /(?:jordan|air max|air force|nike|adidas|loafer|boot|sandal|sneaker|clack|clog)[a-z0-9 ]*/i,
      ];
      for (const p of patterns) {
        if ((m = lower.match(p))) return m[0].replace(/^(want|need|order|buy|the|a|an)\s+/i, '').trim();
      }
    }
  }
  return null;
}

function extractCustomerName(messages, pendingOrder) {
  if (pendingOrder?.customer_name) return pendingOrder.customer_name;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = (msg.text || '').trim();
    const words = text.split(/\s+/);
    if (words.length <= 3 && /^[A-Z]/.test(text) && !/^\d/.test(text)) {
      const prevAI = messages[i - 1];
      if (prevAI?.role !== 'user' && /name|who am i/i.test(prevAI?.text || '')) return text;
    }
  }
  return null;
}

function sanitizePendingOrder(pending) {
  if (!pending) return null;
  // Strip internal fields, keep what's useful to the dashboard
  const { order_id, order_number, product_name, quantity, customer_name,
          customer_phone, customer_address, total_amount, selected_options } = pending;
  return { order_id, order_number, product_name, quantity, customer_name,
           customer_phone, customer_address, total_amount, selected_options };
}

function buildCategoryCounts(analyzed) {
  const counts = buildEmptyCategories();
  for (const c of analyzed) {
    if (counts[c.category] !== undefined) counts[c.category]++;
    else counts.browsers++;
  }
  return counts;
}

function buildEmptyCategories() {
  return {
    hot_leads:       0,
    abandoned_cart:  0,
    warm_leads:      0,
    price_inquirers: 0,
    completed_sales: 0,
    pending_approval:0,
    browsers:        0,
    cold_leads:      0,
    opted_out:       0,
  };
}

async function loadConversationsBatch(tenantId, convDocs) {
  return Promise.all(convDocs.map(async convDoc => {
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
        messages.push({ role: d.role, text: d.message,
                        timestamp: d.timestamp?.toDate?.() || d.createdAt });
      });
      messages.reverse();

      const orderData = orderStateDoc.exists ? orderStateDoc.data() : null;
      return {
        customer_phone: customerPhone,
        messages,
        order_state:   orderData?.state || 'idle',
        pending_order: orderData?.pending_order || null,
      };
    } catch (err) {
      console.error(`[chat-api] loadConversation error for ${customerPhone}:`, err.message);
      return { customer_phone: customerPhone, messages: [], order_state: 'idle', pending_order: null };
    }
  }));
}

async function getTenantWhatsAppCreds(tenantId) {
  try {
    const pool = await database.initializeMainDb();
    const [rows] = await pool.execute(
      'SELECT phone_number_id, access_token FROM whatsapp_connections WHERE tenant_id = ? LIMIT 1',
      [tenantId]
    );
    return rows.length ? { phone_number_id: rows[0].phone_number_id, access_token: rows[0].access_token } : null;
  } catch (err) {
    console.error('[chat-api] getTenantWhatsAppCreds error:', err.message);
    return null;
  }
}
