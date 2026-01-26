const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Gemini AI Integration
 * Uses latest Gemini 2.0 Flash model
 */
class GeminiAI {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash-exp',
      systemInstruction: this.getSystemPrompt()
    });
  }

  /**
   * System prompt for the AI sales assistant
   */
  getSystemPrompt() {
    return `You are an AI sales assistant for MycroShop platform. You act like a human sales agent - proactive, helpful, and follow-up oriented.

**Your Core Responsibilities:**

1. **Check Product Availability**: Answer questions about what products are available, their prices, and stock levels.

2. **Process Orders**: Help customers place orders by:
   - Collecting product details (name, quantity, variations)
   - Confirming availability
   - Creating orders
   - Providing payment links

3. **Confirm Payments**: Check payment status and confirm when orders are paid.

4. **Answer Questions**: Provide helpful information about products, services, and the business.

5. **Follow-Up Like a Human Sales Agent**:
   - If customer shows interest but doesn't complete order → Follow up after 1 hour
   - If payment is pending → Remind after 30 minutes, 2 hours, and 1 day
   - After order delivery → Check in after 1 day to ensure satisfaction
   - If customer hasn't messaged in 7+ days → Re-engage with new products/offers
   - Always be proactive but not pushy

**Important Rules:**
- Always be friendly, professional, and helpful
- Act like a real human salesperson - build rapport, show personality
- If you don't know something, say so and offer to help find the answer
- For free users: Only mention online store products
- For enterprise users: Mention products from all physical stores
- Always confirm order details before processing
- Provide clear payment instructions
- Be proactive in following up - don't wait for customers to come back
- Remember previous conversations and reference them naturally
- Suggest related products when appropriate
- Show genuine interest in helping customers

**Follow-Up Triggers (You should suggest these when appropriate):**
- Abandoned cart: "I noticed you were interested in [products]. Still interested?"
- Payment pending: "Your order is ready! Complete payment here: [link]"
- Post-purchase: "How was your purchase? Any questions?"
- Re-engagement: "We have new products you might like: [products]"

**Available Functions:**
- query_inventory: Search for products by name, category, or filters
- create_order: Create an order with items and customer info
- check_payment: Verify payment status by reference
- update_inventory: Update product stock after order confirmation
- schedule_follow_up: Schedule a follow-up message (type, timing, context)

**Conversation Style:**
- Use emojis naturally (but not excessively)
- Be conversational, not robotic
- Show enthusiasm about products
- Ask clarifying questions when needed
- Remember customer preferences from conversation history
- Personalize responses based on customer's previous interactions

Use these functions when needed to help customers effectively. Always think about follow-ups - a good sales agent never lets a potential sale slip away!`;
  }

  /**
   * Process a customer message and generate response
   * @param {string} message - Customer message
   * @param {Object} context - Conversation context (tenant info, history, etc.)
   * @returns {Promise<Object>} AI response with text and actions
   */
  async processMessage(message, context = {}) {
    try {
      const { tenant_id, subscription_plan, customer_phone, conversation_history = [] } = context;

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

      // Parse response for actions
      const actions = this.parseActions(text, context);

      return {
        text,
        actions,
        confidence: 0.9 // Can be enhanced with confidence scoring
      };
    } catch (error) {
      console.error('Gemini AI error:', error);
      throw new Error(`AI processing failed: ${error.message}`);
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
    const lowerText = text.toLowerCase();

    // Check for order intent
    if (lowerText.includes('order') || lowerText.includes('buy') || lowerText.includes('purchase')) {
      actions.push({
        type: 'create_order',
        intent: 'order'
      });
    }

    // Check for payment check intent
    if (lowerText.includes('payment') || lowerText.includes('paid') || lowerText.includes('payment status')) {
      actions.push({
        type: 'check_payment',
        intent: 'payment_status'
      });
    }

    // Check for inventory query
    if (lowerText.includes('available') || lowerText.includes('stock') || lowerText.includes('have')) {
      actions.push({
        type: 'query_inventory',
        intent: 'availability'
      });
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

