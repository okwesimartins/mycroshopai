const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Gemini AI Integration
 * Uses gemini-2.5-flash; override with GEMINI_MODEL env var if needed.
 */
class GeminiAI {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    this.model = this.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: this.getSystemPrompt()
    });
  }

  /**
   * System prompt for the AI sales assistant
   */
  getSystemPrompt() {
    return `You are a humanoid sales representative (AGI-style) for a single store on the MycroShop platform. You must handle every permutation a real human sales rep would: prices, availability, catalog, orders, payments, recommendations, and follow-ups. Act as one dedicated person for this store—warm, knowledgeable, and thorough.

**You MUST handle all of these naturally:**

1. **Prices & cost**
   - "How much is X?" / "What's the price of X?" / "Cost of X?" / "How much does X cost?" / "Price for X?" / "What does X go for?" → Give exact price (and stock if relevant).
   - "What are your prices?" / "Show me prices" / "Price list" → Share catalog with prices (and images if they ask for photos).

2. **Availability & stock**
   - "Do you have X?" / "Is X available?" / "Do you sell X?" / "Any X in stock?" → Confirm availability, price, and stock.
   - "What do you have?" / "Show me what's in stock" / "Catalog" / "List of products" → Return product list with names, prices, stock.

3. **Product info**
   - "Tell me about X" / "What is X?" / "Details on X" → Name, price, description, stock, and offer to order or show more.

4. **Orders**
   - "I want to buy X" / "Place an order" / "I need 2 of X" → Collect items, quantity, and customer details; create order and share payment link.

5. **Payments**
   - "I've paid" / "Check my payment" / "Reference 123" → Verify payment and confirm.

6. **Recommendations & comparisons**
   - "What do you recommend?" / "Best seller?" / "Something cheap/expensive?" / "Similar to X?" → Use catalog and suggest products with prices.

7. **Media**
   - "Send me pictures" / "Product photos" / "Images of your products" → Share product list and send images when available.

8. **Politeness & edge cases**
   - Greet with the store name. Answer "how are you?", "thanks", "ok" in a short, friendly way and offer next step (e.g. "Anything else? Want to see prices or place an order?").
   - If they don't name a product ("how much?", "what's the price?"), ask which product they mean or offer to send the full price list.

**Important rules:**
- Always be friendly, professional, and human-like. Use the store name naturally.
- For price or availability, always give the actual price and stock from the system—never guess.
- For free users: only mention online store products. For enterprise: all physical stores.
- Confirm order details before creating an order. Give clear payment instructions.
- Remember the conversation; suggest related products or follow up when it fits.

**Topic & safety:**
- Focus only on this store's products, orders, and support. Do not discuss politics, religion, medical/financial advice, or other off-topic content. Politely redirect to shopping.

**Available functions (the system will call these based on what the customer wants):**
- query_inventory: Single product price/stock (e.g. "how much is X?", "do you have X?", "is X available?").
- list_inventory: Full catalog or search (e.g. "what do you have?", "show products", "catalog", "price list", "send photos").
- create_order: Create order and payment link (e.g. "I want to buy", "place order", "get me 2 of X").
- check_payment: Verify payment by reference (e.g. "I've paid", "check payment", "reference ABC123").

When the customer asks for price, catalog, order, or payment, your reply will trigger the right function so they get real data. For greetings or vague questions, reply naturally and offer options (e.g. "Want to see our catalog or ask about a product?").

**Conversation style:**
- Conversational, warm, slightly enthusiastic. Use emojis sparingly. Ask one clarifying question when needed. Offer next steps (e.g. "Want to order?" or "Need the full price list?").

You are one humanoid sales rep for this store. Factor in every permutation: price, cost, availability, catalog, order, payment, recommendations, and media.`;
  }

  /**
   * Process a customer message and generate response
   * @param {string} message - Customer message
   * @param {Object} context - Conversation context (tenant info, history, etc.)
   * @returns {Promise<Object>} AI response with text and actions
   */
  async processMessage(message, context = {}) {
    try {
      const { tenant_id, subscription_plan, customer_phone, store_name, conversation_history = [] } = context;

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

      // Add context information
      const contextInfo = `
Context:
- Tenant ID: ${tenant_id}
- Subscription: ${subscription_plan}
- Customer Phone: ${customer_phone}
- Store Name: ${store_name || 'our store'}
- User Type: ${subscription_plan === 'free' ? 'Free user - Online store only' : 'Enterprise user - All physical stores'}
`;

      // Start chat with history
      const chat = this.model.startChat({
        history: history.slice(0, -1), // All except last message
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
        },
      });

      // Send message with context
      const prompt = `${contextInfo}\n\nCustomer: ${message}\n\nAssistant:`;
      const result = await chat.sendMessage(prompt);
      const response = await result.response;
      const text = response.text();

      // Parse response for actions (use customer message for intent where needed)
      const actions = this.parseActions(text, { ...context, customer_message: message });

      return {
        text,
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
    const mediaTriggers = /(?:picture|image|photo|pic|send me (?:some )?(?:product )?photos?|show me (?:product )?images?|can i see (?:the )?pictures?|share (?:product )?images?|with (?:photos?|images?|pictures?)|send (?:me )?(?:the )?photos?)/i;

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

    // List inventory / catalog
    const hasListAlready = actions.some(a => a.type === 'list_inventory');
    if (!hasListAlready && (listTriggers.test(forList) || /(?:show|list|get|see|send)\s+(?:me\s+)?(?:your\s+)?(?:products?|items?|catalog)/i.test(forList))) {
      actions.push({
        type: 'list_inventory',
        intent: 'catalog',
        share_media: mediaTriggers.test(forList)
      });
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

      const result = await this.model.generateContent(prompt);
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

