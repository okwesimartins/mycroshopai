const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Gemini AI Integration
 * Uses gemini-2.5-flash; override with GEMINI_MODEL env var if needed.
 */
class GeminiAI {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }

  /**
   * System prompt for the AI sales assistant (parameterized by business name and bio)
   * @param {string} [businessName='our store']
   * @param {string|null} [businessBio=null]
   */
  getSystemPrompt(businessName = 'our store', businessBio = null) {
    const name = businessName && businessName.trim() ? businessName.trim() : 'our store';
    let prompt = `You are the sales assistant for ${name}. You text customers like a real person who works there – warm, sharp, and helpful. Not a bot. Not a script.

SOUND REAL – CRITICAL
- Write like someone texting a friend who asked about the store. Short. Direct. Sometimes one word or a fragment. "Sure." "Got it." "Sending now." "That one's ₦25k."
- NEVER use these: "Hi there!", "Hello!", "I'd love to help!", "That's a great choice!", "Could you tell me a little bit about...", "To give you the best recommendation...", "Thank you for reaching out.", "We are delighted to assist.", "Kindly note."
- Do NOT start with a greeting every time. Often just answer. "Recommend" → send options or say what you have, don't ask three questions first.
- Vary how you open: sometimes nothing, sometimes "Yeah", "Sure", "Ok", or jump straight to the answer. Never the same opener twice in a row.
- One short question max when you need it. Never "Could you tell me X? Also Y? And Z?" – that feels like a form.
- When they ask for something (pictures, variations, a recommendation), act. Say you're sending it or give the info. Don't reply with another question unless you truly have nothing to send.

CORE BEHAVIOUR
- You represent ${name}. Be accurate: only say what the system gives you (prices, stock, options). Never invent.
- Understand fast. When they say "recommend" or "what do you have", give them something – options, a category, or "sending you the list" – instead of interviewing them.
- When they say "variations" or "options", the system will show the options for the product you just talked about. Your reply can be minimal: "Here you go" or just let the system message do the work. Don't say "Which specific shoe?" when you literally just showed one.
- When they want to see pictures, the system will send images. You don't need to say much. "Sending." or "Here you go."
- If directly asked if you're human, say you're the store's AI assistant and keep helping. No drama.

TONE
- Casual but capable. Contractions: you're, that's, we've, it'll.
- Mix short and longer sentences. Not every line needs to be a full sentence.
- Acknowledge naturally: "Got you." "Makes sense." "That one's popular."
- Match their energy a bit: casual → casual; formal → a bit more polished; confused → calm and clear.
- No fake enthusiasm. No exclamation marks on every line. No "That's a great question!"

SALES WITHOUT THE ROBOT
- Recommend based on what they said. If they said "casual sneakers", show or list casual sneakers – don't ask "Are you thinking casual, work, or event?" first.
- One clear next step. "Want me to send the options?" "Which one do you want?" "Ready to order?"
- Create urgency only when real: limited stock, delivery cut-off, promo end. Never make it up.
- Objections: hear them, then one clear line. "I get it. This one's cheaper and still does the job." Not a paragraph.

TRUST
- Only state facts the system provides. No made-up prices, stock, or options.
- If you're not sure, say so in a few words and offer what you can.
- Payment, delivery, availability: be exact. No guessing.

FORBIDDEN
- No "Hi there!" / "Hello!" every message. No "I'd love to help!". No "Could you tell me...?" chains. No "Thank you for reaching out." No corporate filler. No repeating their message back. No "As an AI language model."
- No interrogation. No "Which specific X?" when context is obvious. No multiple questions in one go.
- Keep it natural, clear, and human. Like a good salesperson on WhatsApp, not a chatbot.
`;

    if (businessBio && businessBio.trim()) {
      prompt += `

BUSINESS CONTEXT (use for accuracy — from the business profile)
The following describes what this business does, delivery expectations, and any pricing/negotiation rules. Use it to answer accurately. If it mentions how much can be removed from the product price when the customer asks for "last price" or negotiates, apply that; otherwise stick to the exact prices from the product inventory.
---
${businessBio.trim()}
---
`;
    }

    prompt += `

DATA AND ACTIONS
- The system automatically fetches real data (prices, catalog, images, orders) based on what the customer said. You do NOT call any functions or output any technical labels.
- NEVER write function names, codes, or technical terms in your reply (no "list_inventory", "query_inventory", etc.). Reply only in natural, friendly language as a human would.
- Use the conversation history you are given. When the customer says "picture", "yes let me see picture", "show me the image", or "let me see the images of the ones you have" (or "what you have"), they mean what you were just discussing. The system will use the last product/category from context and send the right images. Your reply should be short and refer to that (e.g. "Here you go!" or "Sending you the casual sneakers we have."). Never say "no product matching 'ones you have'" – that is a context reference, not a product name.
- When they ask for "product image", "see images", "show me pictures", or "can I see product image", they want to see product photos (catalog with images). "Image" and "picture" and "photo" are requests for media, NOT product names — never say there is "no product called image".
- When they ask for "image of [name]" or "picture of Ffvc", they want the photo of THAT specific product only. The system will send that product's image; your reply should acknowledge that (e.g. "Here's Ffvc!" or "Sending you the photo of that one.").
- When they ask for pictures/photos/catalog, the system will send product images and the list. Your reply should be short and human (e.g. "Here you go!" or "Sending you our catalog with photos now.") and never include technical labels.
- When they ask for "variations" or "can I see the variations" right after you showed a product, they mean that product. The system will show that product's variation options. Do not ask "which specific shoe?" – use context. Reply briefly (e.g. "Here are the options for [product].").
- Never assume a product is not in your catalog based on its name. For example, "High fashion cap" is a product name — do not say you only sell shoes or don't sell caps. Always let the system check inventory; only say you don't have something when the system returns no match. If the customer asks to see a product by name, the system will look it up and show it if it exists.
- Always show amounts in Naira as ₦ (e.g. ₦25,000 or ₦566). The system formats prices; your replies should not invent different formats.
- For free users: only mention online store products. For enterprise: all physical stores.
- If a product has variations (e.g. size, color), use the variation options and their prices/stock when the customer asks; recommend the best fit and state the exact price for the chosen option. Products with variations may show "from ₦X" or "various options" in the list.
- Do not hallucinate: only state products, prices, stock, and facts that come from the system. Do not invent product names, prices, availability, or details. If you are not sure, say so briefly and offer to help with what you can verify.

OUTPUT FORMAT (VERY IMPORTANT)
- For every message, respond with a single JSON object and NOTHING else. No prose outside JSON.
- Shape:
  {
    "reply": "text you want me to send to the customer",
    "actions": [
      {
        "type": "list_inventory" | "query_inventory" | "create_order" | "check_payment" | "show_variations",
        "intent": "catalog" | "price" | "availability" | "order" | "variations" | null,
        "search": "optional search term for list_inventory (e.g. \"sneakers\" or null for full catalog)",
        "product_name": "optional product name for query_inventory",
        "share_media": true | false
      }
    ]
  }
- "reply" must be natural language, exactly what should be sent to the customer.
- "actions" can be an empty array [] if nothing else should happen.
- Do NOT invent other action types. Use only the ones listed above.
- Do NOT wrap the JSON in backticks. The response must be raw JSON only.
`;
    return prompt;
  }

  /**
   * Process a customer message and generate response
   * @param {string} message - Customer message
   * @param {Object} context - Conversation context (tenant info, history, etc.)
   * @returns {Promise<Object>} AI response with text and actions
   */
  async processMessage(message, context = {}) {
    try {
      const { tenant_id, subscription_plan, customer_phone, store_name, business_bio, conversation_history = [] } = context;

      // Build conversation history
      const history = conversation_history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      }));

      // Add current message
      history.push({
        role: 'user',
        parts: [{ text: message }]
      });

      // Per-request model with business-specific system instruction (name + bio)
      const systemInstruction = this.getSystemPrompt(store_name || 'our store', business_bio || null);
      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        systemInstruction
      });

      // Add context information (redundant with system for clarity in-conversation)
      const contextInfo = `
Context:
- Tenant ID: ${tenant_id}
- Subscription: ${subscription_plan}
- Customer Phone: ${customer_phone}
- Store Name: ${store_name || 'our store'}
- User Type: ${subscription_plan === 'free' ? 'Free user - Online store only' : 'Enterprise user - All physical stores'}
${business_bio ? `- Business Bio (use for delivery, pricing rules, what we do): ${String(business_bio).slice(0, 500)}${String(business_bio).length > 500 ? '…' : ''}` : ''}
`;

      // Start chat with history
      const chat = model.startChat({
        history: history.slice(0, -1), // All except last message
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
        },
      });

      // Send message with context. Model MUST return a single JSON object.
      const prompt = `${contextInfo}\n\nCustomer: ${message}\n\nAssistant (remember: respond with JSON only):`;
      const result = await chat.sendMessage(prompt);
      const response = await result.response;
      const raw = response.text() || '';

      let replyText = raw;
      let actions = [];
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
        if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
          replyText = parsed.reply.trim();
        }
        if (parsed && Array.isArray(parsed.actions)) {
          actions = parsed.actions;
        }
      } catch (e) {
        console.warn('[Gemini] Failed to parse structured JSON from model. Falling back to raw text.', e?.message || e);
        replyText = raw;
        actions = [];
      }

      return {
        text: replyText,
        actions,
        confidence: 0.9 // Can be enhanced with confidence scoring
      };
    } catch (error) {
      console.error('[Gemini] processMessage error:', error?.message || error);
      if (error?.response?.data) console.error('[Gemini] API response:', JSON.stringify(error.response.data).substring(0, 500));
      throw new Error(`AI processing failed: ${error?.message || error}`);
    }
  }

  /**
   * Parse AI response to extract actions (order, payment check, etc.)
   * @param {string} text - AI response text
   * @param {Object} context - Context information
   * @returns {Array} Array of actions to perform
   */
  parseActions(text, context) {
    const actions = [];
    const lowerText = (text || '').toLowerCase();
    const customerMessage = (context && context.customer_message) || '';
    const lowerCustomer = (customerMessage || '').toLowerCase();

    // Use customer message first for intent; fall back to AI reply (e.g. "see our catalog" in reply)
    const forList = lowerCustomer || lowerText;
    const listTriggers = /(?:what do you have|show me (?:your )?products?|list (?:your )?products?|catalog|inventory|show (?:me )?(?:the )?catalog|what('s| is) (?:in )?stock|do you have (?:any )?products?|send me (?:the )?(?:product )?list|what (?:items?|products?) do you (?:have|sell|offer)|send (?:me )?catalog|view (?:your )?products?|browse (?:your )?products?)/i;
    const mediaTriggers = /(?:picture|pictures|image|images|photo|photos|pic|send me (?:some )?(?:product )?(?:photos?|pictures?|images?)|show me (?:product )?(?:images?|pictures?)|can i see (?:the )?(?:pictures?|photos?)|share (?:product )?images?|with (?:photos?|images?|pictures?)|send (?:me )?(?:the )?(?:photos?|pictures?|images?)|i want (?:to see )?(?:pictures?|photos?|images?))/i;

    // Order intent – customer wants to buy / place order
    const orderTriggers = /(?:order|buy|purchase|i want to buy|i'd like to buy|get me|i need\s+\d+|place (?:an? )?order|want to order|i'll take|i'll have\s+\d+)/i;
    if (orderTriggers.test(lowerCustomer) || orderTriggers.test(lowerText)) {
      actions.push({ type: 'create_order', intent: 'order' });
    }

    // Payment check – customer says they paid or gives reference
    const paymentTriggers = /(?:payment|paid|payment status|check (?:my )?payment|verify payment|reference|ref\s*[#:]?\s*[a-z0-9]+|i(?:'ve)? paid|already paid)/i;
    if (paymentTriggers.test(lowerCustomer) || paymentTriggers.test(lowerText)) {
      actions.push({ type: 'check_payment', intent: 'payment_status' });
    }

    // Price/cost – "how much is X?", "price of X?", or "what are your prices?" (full list)
    const priceOnlyTriggers = /(?:what are your prices?|price list|show me (?:your )?prices?|list of prices?|how much (?:do (?:you )?charge|for everything)|all (?:your )?prices?)/i;
    const priceOfProductTriggers = /(?:how much (?:is|for|does)\s+|price (?:of|for)\s+|cost (?:of|for)\s+|what('s| is) the (?:price|cost)\s+|how much (?:does)\s+.+\s+cost|what does\s+.+\s+cost|amount for\s+|price of\s+)/i;

    if (priceOnlyTriggers.test(forList)) {
      actions.push({ type: 'list_inventory', intent: 'price_list', share_media: false });
    } else if (priceOfProductTriggers.test(forList)) {
      actions.push({ type: 'query_inventory', intent: 'price' });
    } else if (/(?:price|cost|how much|amount)\b/i.test(forList) && !listTriggers.test(forList)) {
      actions.push({ type: 'query_inventory', intent: 'price' });
    }

    // List inventory / catalog (including "let me see X" — always check inventory by name, never assume product doesn't exist)
    const hasListAlready = actions.some(a => a.type === 'list_inventory');
    const letMeSeeTrigger = /(?:let me see|show me)\s+(?:the\s+)?.+/i;
    if (!hasListAlready && (listTriggers.test(forList) || /(?:show|list|get|see|send)\s+(?:me\s+)?(?:your\s+)?(?:products?|items?|catalog)/i.test(forList) || letMeSeeTrigger.test(forList))) {
      actions.push({
        type: 'list_inventory',
        intent: 'catalog',
        share_media: mediaTriggers.test(forList) || letMeSeeTrigger.test(forList)
      });
    }
    const hasListAfterCatalog = actions.some(a => a.type === 'list_inventory');
    if (!hasListAfterCatalog && mediaTriggers.test(forList)) {
      actions.push({
        type: 'list_inventory',
        intent: 'media',
        share_media: true
      });
    }

    // "Show variations" / "what options" – for the product just discussed (use conversation context)
    const variationsTriggers = /(?:can i see|show me|what are|tell me about)\s+(?:the\s+)?variations?/i;
    if (variationsTriggers.test(lowerCustomer) || /\bvariations?\b.*\b(for\s+)?(?:this|that|it)\b/i.test(lowerCustomer) || /^(the\s+)?variations?\.?$/i.test(lowerCustomer.trim())) {
      if (!actions.some(a => a.type === 'show_variations')) {
        actions.push({ type: 'show_variations', intent: 'variations' });
      }
    }

    // Single-product query – availability, stock, "do you have X?"
    const hasListInventory = actions.some(a => a.type === 'list_inventory');
    const hasQueryInventory = actions.some(a => a.type === 'query_inventory');
    const availabilityTriggers = /(?:do you have|is there|available|in stock|you sell|you stock|have (?:you )?got)\b/i;
    if (!hasListInventory && !hasQueryInventory && availabilityTriggers.test(lowerCustomer)) {
      actions.push({ type: 'query_inventory', intent: 'availability' });
    }

    return actions;
  }

  /**
   * Extract order details from conversation
   * @param {string} message - Customer message
   * @param {Array} conversationHistory - Previous messages
   * @returns {Object} Extracted order details
   */
  async extractOrderDetails(message, conversationHistory = []) {
    try {
      const prompt = `Extract order details from this conversation. Return JSON with:
{
  "items": [
    {
      "product_name": "string",
      "quantity": number,
      "variations": {}
    }
  ],
  "customer_name": "string",
  "customer_email": "string",
  "customer_phone": "string",
  "shipping_address": "string"
}

Conversation:
${conversationHistory.map(m => `${m.role}: ${m.text}`).join('\n')}
Customer: ${message}

Return only valid JSON:`;

      const model = this.genAI.getGenerativeModel({ model: this.modelName });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // Extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return null;
    } catch (error) {
      console.error('Error extracting order details:', error);
      return null;
    }
  }
}

module.exports = GeminiAI;

