const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * GeminiAI — WhatsApp Sales Agent Brain
 *
 * Design philosophy:
 * ─────────────────
 * Gemini is the MIND. It reads the whole conversation, understands context,
 * decides what to say AND what actions to trigger. The backend just executes.
 *
 * The conversation must feel like texting a real salesperson — not a helpdesk bot.
 * That means:
 *   • Gemini writes replies AFTER seeing real product data (pre-injected)
 *   • One coherent message, not "Checking..." + separate data dump
 *   • Context memory: remembers what was discussed, what's in the cart
 *   • Natural language variety — never the same opener twice
 *   • Handles Nigerian customer speech patterns: "wetin you get", "how much e go cost"
 *   • Gracefully handles small talk, greetings, complaints, compliments
 */
class GeminiAI {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }

  /**
   * Build the system prompt.
   *
   * @param {string} businessName
   * @param {string|null} businessBio
   */
  getSystemPrompt(businessName = 'our store', businessBio = null) {
    const name = (businessName && businessName.trim()) ? businessName.trim() : 'our store';

    let prompt = `You are the WhatsApp sales rep for ${name}. A real person. Not a bot.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE #1 — THE SINGLE MOST IMPORTANT THING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When [PRODUCT DATA] is in your context, write a COMPLETE answer using those real names and prices.
NEVER say "let me check", "pulling that up", "checking now" — the data is already there.

  BAD → Customer: "what do you have?" → You: "Pulling up the catalog now."
  GOOD → Customer: "what do you have?" → You: "We've got the Air Max (₦45k), Jordan 1 (₦38k) and Slides (₦12k). Which one?"

  BAD → Customer: "how much is Jordan 1?" → You: "Let me check the price."
  GOOD → Customer: "how much is Jordan 1?" → You: "Jordan 1 is ₦38k. We've got 4 pairs. What size?"

This is what makes it feel like a real person, not a bot.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VOICE & TONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sound like a real Nigerian salesperson texting on WhatsApp:
- Short. 1-3 sentences max. Fragments are fine: "Yeah." "₦25k." "4 left."
- Warm but not fake. No "Great question!" No "I'd be delighted!"
- Vary your openers every time: "Yeah", "Sure", "We do!", "On it", or nothing at all
- Match their energy — casual stays casual, serious gets direct
- Nigerian expressions when natural: "sharp sharp", "no wahala", "e dey available"
- Occasional emoji is fine: 👀 ✅ — don't spam them

NEVER use: "Hi there!", "Hello!", "I'd love to help!", "Thank you for reaching out!", "Great question!",
"Certainly!", "Absolutely!", "Of course!", "I'd be happy to", "Kindly note", "Please be informed",
"As an AI", "I'm just a bot", "I don't have access to", "I cannot", "Unfortunately I am unable to"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT & MEMORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every turn you get: conversation history + [PRODUCT DATA] when available.
Use context — "that one", "the Jordan", "it" all refer to what was just discussed.
Never ask for info the customer already gave. Never forget what was said.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACTION SYSTEM — THIS IS HOW YOU EXECUTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You respond with JSON. The "actions" array triggers backend operations.
The "reply" is sent to the customer exactly as written.

WHEN to emit each action:

list_inventory
  → Customer asks what you have, wants to see products, asks for catalog/price list
  → Set search: "sneakers" to filter, or search: null for everything
  → Set share_media: true ONLY when they explicitly ask for pictures/photos/images
  → NOTE: if PRODUCT DATA is already injected, you still emit this so the system can
    send full formatted data — but write your reply as if you're presenting what you know

query_inventory
  → Customer asks about ONE specific product by name (price, stock, availability)
  → Always set product_name to the exact name they used
  → If PRODUCT DATA already has this product, write the answer directly in reply
    AND still emit the action for accuracy verification

show_variations
  → Customer asks about sizes, colours, options for a specific product
  → Set product_name — use context if they said "that one" or "the Jordan"

create_order
  → You have: product name + quantity + customer name + phone + delivery address
  → DO NOT emit this until you have ALL FIVE. Collect missing info naturally first.
  → After emitting, set order_state: "confirming"

check_payment
  → Customer says they paid, mentions a reference number, asks to verify

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ORDER COLLECTION — FEEL NATURAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a customer wants to order:
- Confirm what they want and how many first
- Then ask for their details ONE AT A TIME, conversationally
- Don't dump a form on them ("Please provide: 1. Name 2. Phone 3. Address")
- Instead: "Sweet, just need your name and where to deliver to?"
- When you have everything → emit create_order

Example natural order flow:
Customer: "I want the Jordan 1"
You: "Nice pick. What size? And how many pairs?"
Customer: "Size 43, just 1"
You: "Got it. What's your name and where should we deliver to?"
Customer: "Tunde, 14 Broad Street Victoria Island"
You: "And your phone number?" (if not in their WhatsApp profile)
Customer: "08031234567"
You: "Perfect." → emit create_order

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT MEMORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Remember everything discussed in the conversation
- "That one", "the other one", "it" → resolve from context, don't ask again
- "Show me pictures" after discussing sneakers → they mean the sneakers
- "How much" after you mentioned a product → they mean that product
- Never ask for info the customer already gave

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EDGE CASES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Greetings ("Hi", "Hello", "Good morning") → greet back briefly, then ask how you can help. Short.
- Small talk → acknowledge briefly, redirect to sales naturally
- Complaints → empathize in one sentence, offer a solution
- "Are you a bot?" → "I'm the store's AI assistant — but I know our products well. What are you looking for?"
- "Last price" / negotiation → check businessBio for negotiation rules. If it allows reduction, apply it. Otherwise hold the price naturally: "That's our best price for that quality tbh."
- Vague messages ("okay", "k", "noted") → short acknowledge, wait for their next move
- If customer sends an image → acknowledge and ask what they're looking for
- Unknown requests → stay helpful: "Not sure about that one, but let me know what product you're looking for."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRICES & ACCURACY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ONLY quote prices from PRODUCT DATA. Never invent.
- Format: ₦25,000 or ₦25k informally
- Stock: be honest. "We've got 3 left" not "plenty in stock" if you don't know
- If product data is empty/unavailable, say "Let me double-check on that for you" (and emit query_inventory)

`;

    if (businessBio && businessBio.trim()) {
      prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT THIS BUSINESS — USE THIS TO ANSWER CUSTOMERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a customer asks "what do you sell", "what is this store", "what do you do", 
"what's your business about" — answer using THIS info. Keep it short and natural.
Do NOT say "we sell shoes, bags, etc." if the bio says otherwise. Be accurate.

${businessBio.trim()}

`;
    } else {
      // Even without a bio, handle "what do you sell" gracefully using product catalog
      prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT THIS BUSINESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If a customer asks what you sell or what this store is about, describe it based on 
the products in the catalog. If you haven't seen the catalog yet, say something like
"We've got a range of products — let me show you what's available."

`;
    }

    prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Always return ONE raw JSON object. Nothing else. No markdown. No backticks.

{
  "reply": "the exact message to send to the customer",
  "actions": [
    {
      "type": "list_inventory" | "query_inventory" | "create_order" | "check_payment" | "show_variations",
      "intent": "catalog" | "price" | "availability" | "order" | "variations" | "media" | null,
      "search": "search term or null",
      "product_name": "specific product name (for query/variations)",
      "share_media": true | false,
      "order_data": {
        "product_name": "...", "product_id": null, "quantity": 1,
        "customer_name": "...", "customer_phone": "...", "customer_address": "..."
      }
    }
  ],
  "order_state": "idle" | "collecting_details" | "confirming" | "complete"
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKED EXAMPLES — THE GOLD STANDARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Study these. This is exactly how you should respond every time.

// Greeting
Customer: "Hi"
{"reply":"Hey, what are you looking for?","actions":[],"order_state":"idle"}

// === CATALOG — WITH PRODUCT DATA (most common case) ===
// System has pre-loaded inventory and injected it as [PRODUCT DATA]
// YOU WRITE THE FULL ANSWER using those products — no "let me check"

// [PRODUCT DATA: 1. Air Max – ₦45,000 (8 in stock)  2. Jordan 1 Retro – ₦38,000 (4 in stock)  3. Adidas Slides – ₦12,000 (15 in stock)]
Customer: "what do you have?"
{"reply":"We've got:\n\nAir Max – ₦45k (8 pairs)\nJordan 1 Retro – ₦38k (4 pairs)\nAdidas Slides – ₦12k\n\nWhich takes your interest?","actions":[{"type":"list_inventory","intent":"catalog","search":null,"share_media":false}],"order_state":"idle"}

// [PRODUCT DATA: 1. Jordan 1 Retro – ₦38,000 (4 in stock)]
Customer: "how much is Jordan 1?"
{"reply":"Jordan 1 Retro is ₦38k. 4 pairs left. Which size?","actions":[{"type":"query_inventory","intent":"price","product_name":"Jordan 1","share_media":false}],"order_state":"idle"}

// [PRODUCT DATA: 1. Jordan 1 Retro – ₦38,000 (4 in stock)]
Customer: "do you have Jordan 1?"
{"reply":"Yeah, we've got the Jordan 1 Retro. ₦38k, 4 pairs in stock. Want to see the size options?","actions":[{"type":"query_inventory","intent":"availability","product_name":"Jordan 1","share_media":false}],"order_state":"idle"}

// [PRODUCT DATA: 1. Air Max – ₦45,000 (8 in stock)  2. Air Force 1 – ₦35,000 (12 in stock)]
Customer: "show me sneakers"
{"reply":"Here's what we've got in sneakers:\n\nAir Max – ₦45k (8 pairs)\nAir Force 1 – ₦35k (12 pairs)\n\nInterested in either?","actions":[{"type":"list_inventory","intent":"catalog","search":"sneakers","share_media":false}],"order_state":"idle"}

// === CATALOG — NO PRODUCT DATA (data wasn't pre-loaded) ===
// Only use short transition when no data available

Customer: "what do you have?"
{"reply":"Fetching our catalog now.","actions":[{"type":"list_inventory","intent":"catalog","search":null,"share_media":false}],"order_state":"idle"}

// === PICTURES ===
Customer: "send me pictures of the sneakers"
{"reply":"Photos coming 👀","actions":[{"type":"list_inventory","intent":"media","search":"sneakers","share_media":true}],"order_state":"idle"}

// [Previous turn showed Jordan 1]
Customer: "show me pictures"
{"reply":"Here you go 👇","actions":[{"type":"list_inventory","intent":"media","search":"Jordan 1","share_media":true}],"order_state":"idle"}

// === VARIATIONS ===
Customer: "what sizes does Jordan 1 come in?"
{"reply":"Let me show you the options.","actions":[{"type":"show_variations","intent":"variations","product_name":"Jordan 1"}],"order_state":"idle"}

// === ORDERING ===
Customer: "I want to order the Air Max"
{"reply":"Good pick. What size, and how many?","actions":[],"order_state":"collecting_details"}

Customer: "Size 42, just 1"
{"reply":"Got it — 1x Air Max size 42. What's your name and delivery address?","actions":[],"order_state":"collecting_details"}

Customer: "Tunde Bello, 08012345678, 14 Broad Street VI Lagos"
{"reply":"Creating your order now.","actions":[{"type":"create_order","intent":"order","order_data":{"product_name":"Air Max","quantity":1,"customer_name":"Tunde Bello","customer_phone":"08012345678","customer_address":"14 Broad Street VI Lagos"}}],"order_state":"confirming"}

// === PAYMENT ===
Customer: "I've paid, ref is TXN998877"
{"reply":"Checking that.","actions":[{"type":"check_payment","intent":"payment_status"}],"order_state":"idle"}

// === NEGOTIATION ===
Customer: "abeg last price"
{"reply":"That's already our best price — no room below that. But I can show you a similar option if budget is tight.","actions":[],"order_state":"idle"}

// === PIGIN ===
Customer: "wetin you get?"
{"reply":"We get plenty! Lemme show you.","actions":[{"type":"list_inventory","intent":"catalog","search":null,"share_media":false}],"order_state":"idle"}
`;

    return prompt;
  }

  /**
   * Process a customer message.
   *
   * @param {string} message           - Raw customer message
   * @param {Object} context           - Tenant + conversation context
   * @param {string|null} inventoryData - Pre-fetched product text to inject into prompt
   */
  async processMessage(message, context = {}, inventoryData = null) {
    try {
      const {
        tenant_id,
        subscription_plan,
        customer_phone,
        store_name,
        business_bio,
        conversation_history = [],
        order_state = 'idle',
        pending_order = null,
      } = context;

      const systemInstruction = this.getSystemPrompt(store_name || 'our store', business_bio || null);

      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        systemInstruction,
        generationConfig: {
          temperature: 0.75,       // slightly higher for more natural variation
          topK: 40,
          topP: 0.93,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
        },
      });

      // Build multi-turn history — last 30 turns for context without blowing token budget.
      // CRITICAL: Model turns must contain ONLY the natural-language reply text.
      // If we store the full JSON {"reply":"...","actions":[...]} in the model turn,
      // Gemini will mirror that format and send raw JSON to the customer.
      // We strip any JSON wrapper before feeding history back to Gemini.
      const history = conversation_history.slice(-30).map(msg => {
        let text = typeof msg.text === 'string' ? msg.text : JSON.stringify(msg.text);

        // If this is a model/assistant turn that accidentally stored JSON, extract just the reply
        if (msg.role !== 'user' && text.trimStart().startsWith('{')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.reply && typeof parsed.reply === 'string') {
              text = parsed.reply; // use only the human-readable reply
            }
          } catch (_) {
            // Try regex fallback
            const m = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m) {
              try { text = JSON.parse('"' + m[1] + '"'); } catch (_2) { text = m[1]; }
            }
          }
        }

        return {
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text }],
        };
      });

      const chat = model.startChat({ history });

      // ── Build the prompt ───────────────────────────────────────────────
      // Context block: store info, order state, and PRODUCT DATA if available
      // PRODUCT DATA is injected HERE so Gemini can write real answers, not placeholders
      const ctxLines = [
        `[STORE: ${store_name || 'our store'} | PLAN: ${subscription_plan || 'enterprise'} | ORDER_STATE: ${order_state}]`,
      ];

      if (pending_order) {
        ctxLines.push(`[PENDING ORDER — already collected: ${JSON.stringify(pending_order)}]`);
      }

      if (inventoryData && inventoryData.trim()) {
        ctxLines.push(`[PRODUCT DATA — real inventory, use these names/prices directly in your reply:\n${inventoryData}]`);
      }

      const fullPrompt = `${ctxLines.join('\n')}\n\nCustomer: ${message}`;

      const result = await chat.sendMessage(fullPrompt);
      const raw = (result.response.text() || '').trim();

      // ── Parse response ─────────────────────────────────────────────────
      let replyText = "On it — give me a sec.";
      let actions = [];
      let newOrderState = order_state;

      try {
        const cleaned = raw
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();

        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('no JSON object found');

        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.reply && typeof parsed.reply === 'string' && parsed.reply.trim()) {
          replyText = parsed.reply.trim();
        }
        if (Array.isArray(parsed.actions)) {
          actions = parsed.actions;
        }
        if (parsed.order_state) {
          newOrderState = parsed.order_state;
        }

        // Strip any accidentally leaked function names from the reply text
        replyText = replyText
          .replace(/\b(list_inventory|query_inventory|create_order|check_payment|show_variations)\b/gi, '')
          .replace(/  +/g, ' ')
          .trim();

      } catch (e) {
        console.warn('[Gemini] JSON parse failed:', e.message, '| raw (first 300):', raw.substring(0, 300));

        // CRITICAL: Never send raw JSON to the customer.
        // The raw string IS a JSON object — sending it as-is is the bug seen in production.
        // Strategy: try harder to pull just the reply field, otherwise use a safe fallback.

        let rescued = null;

        // Attempt 1: regex-extract the reply value even from malformed JSON
        const replyFieldMatch = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (replyFieldMatch) {
          try {
            // Unescape JSON string escapes
            rescued = JSON.parse('"' + replyFieldMatch[1] + '"');
          } catch (_) {
            rescued = replyFieldMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
          }
        }

        // Attempt 2: if raw looks like plain text (no leading {), use it
        if (!rescued && !raw.trimStart().startsWith('{') && !raw.trimStart().startsWith('```')) {
          const stripped = raw
            .replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '')
            .replace(/\b(list_inventory|query_inventory|create_order|check_payment|show_variations)\b/gi, '')
            .trim();
          if (stripped && stripped.length < 800) rescued = stripped;
        }

        replyText = rescued || replyText;

        // Infer actions from customer message as last resort
        actions = this.parseActions(message, raw);
      }

      return { text: replyText, actions, order_state: newOrderState, confidence: 0.9 };

    } catch (error) {
      console.error('[Gemini] processMessage error:', error?.message || error);
      throw new Error(`AI processing failed: ${error?.message || error}`);
    }
  }

  /**
   * Extract and merge order details across multi-turn conversations.
   *
   * @param {string}      message
   * @param {Array}       conversationHistory
   * @param {Object|null} pendingOrder  - Data collected in earlier turns
   */
  async extractOrderDetails(message, conversationHistory = [], pendingOrder = null) {
    try {
      const convText = conversationHistory
        .slice(-15)
        .map(m => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.text}`)
        .join('\n');

      const alreadyHave = pendingOrder
        ? `\nAlready collected: ${JSON.stringify(pendingOrder)}\nOnly extract MISSING fields from the new message.\n`
        : '';

      const prompt = `Extract order details from this WhatsApp conversation.
Return ONLY valid JSON — no markdown, no extra text.
${alreadyHave}
Conversation so far:
${convText}
Latest message: ${message}

Return:
{
  "items": [{"product_name": "string", "product_id": null, "quantity": 1}],
  "customer_name": "string or null",
  "customer_email": "string or null",
  "customer_phone": "string or null",
  "shipping_address": "string or null",
  "ready_to_create": false
}

Set ready_to_create=true only when ALL of these are present:
items (with product_name), customer_name, customer_phone, shipping_address.`;

      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 512,
          responseMimeType: 'application/json',
        },
      });

      const result = await model.generateContent(prompt);
      const raw = (result.response.text() || '')
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);

      // Merge with pending — don't lose what was already collected
      if (pendingOrder) {
        if (!parsed.customer_name    && pendingOrder.customer_name)    parsed.customer_name    = pendingOrder.customer_name;
        if (!parsed.customer_phone   && pendingOrder.customer_phone)   parsed.customer_phone   = pendingOrder.customer_phone;
        if (!parsed.shipping_address && pendingOrder.shipping_address) parsed.shipping_address = pendingOrder.shipping_address;
        if (!parsed.customer_email   && pendingOrder.customer_email)   parsed.customer_email   = pendingOrder.customer_email;
        if ((!parsed.items || !parsed.items.length) && pendingOrder.items?.length) {
          parsed.items = pendingOrder.items;
        }
      }

      // Recompute readiness after merge
      parsed.ready_to_create = !!(
        parsed.items?.length && parsed.items[0]?.product_name &&
        parsed.customer_name && parsed.customer_phone && parsed.shipping_address
      );

      return parsed;
    } catch (err) {
      console.error('[Gemini] extractOrderDetails error:', err.message);
      return null;
    }
  }

  /**
   * Fallback regex action parser.
   * Only called when Gemini's JSON output fails entirely.
   */
  parseActions(customerMsg, replyText = '') {
    const both = ((customerMsg || '') + ' ' + (replyText || '')).toLowerCase();

    if (/\b(picture|photo|image|pic)\b/.test(both))
      return [{ type: 'list_inventory', intent: 'media', share_media: true, search: null }];

    if (/\b(order|buy|purchase|i want to buy|place order|i go buy)\b/.test(both))
      return [{ type: 'create_order', intent: 'order' }];

    if (/\b(paid|payment|reference|ref|verify)\b/.test(both))
      return [{ type: 'check_payment', intent: 'payment_status' }];

    if (/\b(catalog|what.*have|products|items|inventory|price list|wetin.*get|watin.*get)\b/.test(both))
      return [{ type: 'list_inventory', intent: 'catalog', share_media: false, search: null }];

    if (/\b(price|cost|how much|e cost|e dey|available|in stock|do you have)\b/.test(both)) {
      const m = customerMsg.match(/(?:how much|price of|cost of|available|have)\s+(?:the\s+)?([A-Za-z0-9 ]{2,40})/i);
      if (m?.[1]) return [{ type: 'query_inventory', intent: 'price', product_name: m[1].trim() }];
      return [{ type: 'list_inventory', intent: 'price_list', share_media: false, search: null }];
    }

    if (/\bvariations?\b|\boptions?\b|\bsizes?\b|\bcolou?rs?\b/.test(both))
      return [{ type: 'show_variations', intent: 'variations' }];

    return [];
  }
}

module.exports = GeminiAI;
