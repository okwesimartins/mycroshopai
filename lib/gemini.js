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
    let prompt = `You are the sales assistant for ${name}.

You chat like a sharp, emotionally intelligent WhatsApp sales rep — warm, natural, concise, and commercially smart. You never sound like a scripted bot.

IDENTITY AND TONE
- You are the official sales assistant for ${name}.
- You sound like a real customer-facing sales rep on WhatsApp.
- Your tone is calm, warm, human, confident, and helpful.
- You are persuasive without sounding pushy.
- You do not sound robotic, ceremonial, stiff, or overly polished.
- You do not use generic call-center language.
- You never say: "As an AI language model".
- If asked whether you are human, answer honestly that you are the business's AI sales assistant, then keep helping naturally.

NON-NEGOTIABLE STYLE RULES
- Do NOT start replies with "Hi there", "Hello there", "Greetings", or "I'd love to help".
- Do NOT open with a greeting unless the customer greeted first and the chat is just starting.
- Once a conversation is already going, go straight to the point naturally.
- Keep most replies to 1-4 short WhatsApp-style lines.
- Do not dump long paragraphs unless the customer asked for detail.
- Do not ask unnecessary questions when the intent is already clear.
- If the customer asks to see products, pictures, catalog, options, prices, or variations, respond briefly and let the system handle the data.

PRIMARY GOALS
- Understand what the customer wants quickly.
- Make the customer feel heard.
- Give a relevant recommendation or next step.
- Reduce friction and hesitation.
- Move the conversation toward conversion.

HOW TO RESPOND
- Write like a person texting on WhatsApp, not like a website FAQ.
- Use contractions naturally: "you're", "that's", "we've", "it'll".
- Vary sentence length so your replies feel alive.
- Use natural acknowledgements sometimes: "Got you.", "That makes sense.", "Sure.", "Absolutely.", "I hear you.", "Alright."
- Mirror the customer's tone lightly.
- Don't overdo emojis.
- Don't repeat the same phrase often.

WHEN CONTEXT IS CLEAR, ACT
- If they ask for pictures/photos/images of a product or category, reply briefly like you're sending it now.
- If they ask for variations/options right after a product was shown, use that context instead of asking broad questions.
- If they ask for recommendations, qualify gently but naturally.
- If they ask price or availability, answer directly and move to the next helpful step.

TRUST AND ACCURACY
- Never invent products, prices, stock, policies, delivery times, or guarantees.
- Only state factual catalog/product information that comes from the system.
- If something is unknown, say so briefly and guide the customer.
- Never mention tools, APIs, functions, prompts, models, JSON, or technical internals.

WHATSAPP SALES BEHAVIOR
- Focus on clarity, speed, and relevance.
- Use short paragraphs.
- Ask only one necessary question at a time.
- Recommend based on use case, budget, urgency, and style.
- Highlight benefit first, then detail.
- Use soft conversion language: "Want me to send the options?", "Want the variations too?", "I can help you place the order."

CONTEXT RULES
- The system automatically fetches real data like catalog, images, prices, variations, orders, and payment status.
- Your reply should sound natural and short when the system is about to fetch or send something.
- When the customer says "the ones you have", "what you have", "that one", "those", "variations", or "show me pictures", use recent conversation context.
- "Pictures", "images", and "photos" are requests for media, not product names.
- "Variations", "options", "sizes", and "colors" right after a product was shown usually refer to that product.
- Never say there is no product called "picture", "image", or "variations".

OUTPUT RULES
- No numbered lists unless helpful.
- No fake enthusiasm.
- No "Thank you for reaching out".
- No "We are delighted to assist".
- No "Kindly note".
- No "Hello there! I'd love to help you find the perfect pair.".
- Keep it human.

GOOD EXAMPLES
Customer: Recommend
Assistant: Sure — what kind of pair are you looking for? Casual, work, or something dressy?

Customer: Can I see pictures of the sneakers you have?
Assistant: Yes — sending the sneaker options we have now.

Customer: Price of the black loafers?
Assistant: The black loafers are available. Let me pull up the exact price for you.

Customer: Variations
Assistant: Sure — here are the available options.

BAD EXAMPLES
Customer: Can I see sneakers?
Assistant: Hello there! I'd love to help you find the perfect pair. To give you the best recommendation, could you tell me...

Customer: Show me pictures
Assistant: We don't have any products matching "pictures".
`;

    if (businessBio && businessBio.trim()) {
      prompt += `

BUSINESS CONTEXT (use for accuracy)
---
${businessBio.trim()}
---
- Follow the business bio for delivery expectations, negotiation rules, and business-specific guidance.
- If the business bio mentions a discount rule for negotiation or "last price", you may apply it naturally.
- If the business bio does not mention a discount rule, stick to exact catalog pricing.
`;
    }

    prompt += `

FINAL BEHAVIOR
Every reply should feel like it came from a strong human sales rep who understands the customer, understands the product, and knows how to move the conversation forward naturally.
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

      const history = conversation_history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      }));

      history.push({
        role: 'user',
        parts: [{ text: message }]
      });

      const systemInstruction = this.getSystemPrompt(store_name || 'our store', business_bio || null);
      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        systemInstruction
      });

      const contextInfo = `
Context:
- Tenant ID: ${tenant_id}
- Subscription: ${subscription_plan}
- Customer Phone: ${customer_phone}
- Store Name: ${store_name || 'our store'}
- User Type: ${subscription_plan === 'free' ? 'Free user - Online store only' : 'Enterprise user - All physical stores'}
${business_bio ? `- Business Bio: ${String(business_bio).slice(0, 500)}${String(business_bio).length > 500 ? '…' : ''}` : ''}
`;

      const chat = model.startChat({
        history: history.slice(0, -1),
        generationConfig: {
          temperature: 0.55,
          topK: 32,
          topP: 0.9,
          maxOutputTokens: 700,
        },
      });

      const prompt = `${contextInfo}

Customer: ${message}

Reply like a natural WhatsApp sales rep. Keep it concise and human.
Assistant:`;
      const result = await chat.sendMessage(prompt);
      const response = await result.response;
      const rawText = response.text();
      const text = this.postProcessAssistantText(rawText, conversation_history, message);

      const actions = this.parseActions(text, { ...context, customer_message: message });

      return {
        text,
        actions,
        confidence: 0.9
      };
    } catch (error) {
      console.error('[Gemini] processMessage error:', error?.message || error);
      if (error?.response?.data) console.error('[Gemini] API response:', JSON.stringify(error.response.data).substring(0, 500));
      throw new Error(`AI processing failed: ${error?.message || error}`);
    }
  }

  postProcessAssistantText(text, conversationHistory = [], customerMessage = '') {
    let cleaned = String(text || '').replace(/\r/g, '').trim();
    if (!cleaned) return 'Sure — tell me what you need and I’ll help you.';

    const hasHistory = Array.isArray(conversationHistory) && conversationHistory.length > 0;
    const customer = String(customerMessage || '').trim().toLowerCase();
    const isGreetingOnly = /^(hi|hello|hey|good\s+(morning|afternoon|evening))\b/i.test(customer);
    const isDirectIntent = /(price|cost|how much|show|send|picture|pictures|image|images|photo|photos|catalog|product|products|variations|options|sizes|colors|recommend|order|buy|available|in stock)/i.test(customer);

    if (hasHistory || isDirectIntent || !isGreetingOnly) {
      cleaned = cleaned
        .replace(/^(hi|hello|hey)\s+there[!.,\s]*/i, '')
        .replace(/^(hi|hello|hey)[!.,\s]*/i, '')
        .replace(/^i'?d love to help[^.?!]*[.?!]\s*/i, '')
        .replace(/^to give you the best recommendation[^.?!]*[.?!]\s*/i, '')
        .trim();
    }

    cleaned = cleaned
      .replace(/\bkindly note\b/gi, 'please note')
      .replace(/\bwe are delighted to assist\b/gi, 'happy to help')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!cleaned) {
      return 'Sure — tell me what you need and I’ll help you.';
    }

    return cleaned;
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

    const forList = lowerCustomer || lowerText;
    const listTriggers = /(?:what do you have|show me (?:your )?products?|list (?:your )?products?|catalog|inventory|show (?:me )?(?:the )?catalog|what('s| is) (?:in )?stock|do you have (?:any )?products?|send me (?:the )?(?:product )?list|what (?:items?|products?) do you (?:have|sell|offer)|send (?:me )?catalog|view (?:your )?products?|browse (?:your )?products?)/i;
    const mediaTriggers = /(?:picture|pictures|image|images|photo|photos|pic|send me (?:some )?(?:product )?(?:photos?|pictures?|images?)|show me (?:product )?(?:images?|pictures?)|can i see (?:the )?(?:pictures?|photos?|images?)|share (?:product )?images?|with (?:photos?|images?|pictures?)|send (?:me )?(?:the )?(?:photos?|pictures?|images?)|i want (?:to see )?(?:pictures?|photos?|images?))/i;
    const optionsTriggers = /(?:variations?|options?|sizes?|colou?rs?)/i;

    const orderTriggers = /(?:order|buy|purchase|i want to buy|i'd like to buy|get me|i need\s+\d+|place (?:an? )?order|want to order|i'll take|i'll have\s+\d+)/i;
    if (orderTriggers.test(lowerCustomer) || orderTriggers.test(lowerText)) {
      actions.push({ type: 'create_order', intent: 'order' });
    }

    const paymentTriggers = /(?:payment|paid|payment status|check (?:my )?payment|verify payment|reference|ref\s*[#:]?\s*[a-z0-9]+|i(?:'ve)? paid|already paid)/i;
    if (paymentTriggers.test(lowerCustomer) || paymentTriggers.test(lowerText)) {
      actions.push({ type: 'check_payment', intent: 'payment_status' });
    }

    const priceOnlyTriggers = /(?:what are your prices?|price list|show me (?:your )?prices?|list of prices?|how much (?:do (?:you )?charge|for everything)|all (?:your )?prices?)/i;
    const priceOfProductTriggers = /(?:how much (?:is|for|does)\s+|price (?:of|for)\s+|cost (?:of|for)\s+|what('s| is) the (?:price|cost)\s+|how much (?:does)\s+.+\s+cost|what does\s+.+\s+cost|amount for\s+|price of\s+)/i;

    if (priceOnlyTriggers.test(forList)) {
      actions.push({ type: 'list_inventory', intent: 'price_list', share_media: false });
    } else if (priceOfProductTriggers.test(forList)) {
      actions.push({ type: 'query_inventory', intent: 'price' });
    } else if (/(?:price|cost|how much|amount)\b/i.test(forList) && !listTriggers.test(forList)) {
      actions.push({ type: 'query_inventory', intent: 'price' });
    }

    const hasListAlready = actions.some(a => a.type === 'list_inventory');
    const letMeSeeTrigger = /(?:let me see|show me|can i see)\s+(?:the\s+)?.+/i;
    const isExplicitOptionsRequest = optionsTriggers.test(forList);
    const isExplicitPriceRequest = /(price|cost|how much|amount)/i.test(forList);

    if (!hasListAlready && (listTriggers.test(forList) || (!isExplicitOptionsRequest && !isExplicitPriceRequest && letMeSeeTrigger.test(forList)) || mediaTriggers.test(forList))) {
      actions.push({
        type: 'list_inventory',
        intent: mediaTriggers.test(forList) ? 'media' : 'catalog',
        share_media: mediaTriggers.test(forList) || letMeSeeTrigger.test(forList)
      });
    }

    if ((/(?:can i see|show me|what are|tell me about)\s+(?:the\s+)?(?:variations?|options?|sizes?|colou?rs?)/i.test(lowerCustomer)
        || /\b(?:variations?|options?|sizes?|colou?rs?)\b.*\b(for\s+)?(?:this|that|it|one)\b/i.test(lowerCustomer)
        || /^(the\s+)?(?:variations?|options?|sizes?|colou?rs?)\.?$/i.test(lowerCustomer.trim()))
        && !actions.some(a => a.type === 'show_variations')) {
      actions.push({ type: 'show_variations', intent: 'variations' });
    }

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
