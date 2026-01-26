const axios = require('axios');

/**
 * Order Processing
 * Creates orders and manages order status
 */
class OrderManager {
  constructor() {
    this.apiUrl = process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com';
    this.apiKey = process.env.MYCROSHOP_API_KEY;
  }

  /**
   * Create order from customer conversation
   * @param {number} tenantId - Tenant ID
   * @param {Object} orderData - Order data
   * @returns {Promise<Object>} Created order
   */
  async createOrder(tenantId, orderData) {
    try {
      const { items, customer_info } = orderData;

      // Validate items
      if (!items || items.length === 0) {
        throw new Error('Order must have at least one item');
      }

      // Prepare order payload
      const payload = {
        tenant_id: tenantId,
        items: items.map(item => ({
          product_id: item.product_id,
          product_name: item.product_name,
          quantity: item.quantity,
          price: item.price,
          variations: item.variations || {}
        })),
        customer_name: customer_info?.name || 'WhatsApp Customer',
        customer_email: customer_info?.email || '',
        customer_phone: customer_info?.phone || '',
        shipping_address: customer_info?.shipping_address || '',
        notes: `Order created via WhatsApp AI Assistant`
      };

      const response = await axios.post(
        `${this.apiUrl}/api/v1/onlineStoreOrders`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.success) {
        return {
          success: true,
          order: response.data.data.order,
          paymentLink: response.data.data.payment_link
        };
      }

      throw new Error(response.data.message || 'Failed to create order');
    } catch (error) {
      console.error('Error creating order:', error.response?.data || error.message);
      throw new Error(`Failed to create order: ${error.message}`);
    }
  }

  /**
   * Get order by ID
   * @param {number} tenantId - Tenant ID
   * @param {number} orderId - Order ID
   * @returns {Promise<Object|null>} Order
   */
  async getOrderById(tenantId, orderId) {
    try {
      const response = await axios.get(
        `${this.apiUrl}/api/v1/onlineStoreOrders/${orderId}?tenant_id=${tenantId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.success) {
        return response.data.data.order;
      }

      return null;
    } catch (error) {
      console.error('Error getting order:', error);
      return null;
    }
  }

  /**
   * Format order confirmation message
   * @param {Object} order - Order object
   * @param {string} paymentLink - Payment link
   * @returns {string} Formatted message
   */
  formatOrderConfirmation(order, paymentLink) {
    const items = order.items || [];
    const total = order.total_amount || order.total || 0;

    let message = `✅ Order Created Successfully!\n\n`;
    message += `Order ID: #${order.id}\n\n`;
    message += `Items:\n`;

    items.forEach((item, index) => {
      const name = item.product_name || item.name;
      const qty = item.quantity;
      const price = item.price ? `₦${parseFloat(item.price).toLocaleString()}` : '';
      message += `${index + 1}. ${name} x ${qty} ${price ? `(${price} each)` : ''}\n`;
    });

    message += `\nTotal: ₦${parseFloat(total).toLocaleString()}\n\n`;
    message += `To complete your order, please pay using this link:\n`;
    message += `${paymentLink}\n\n`;
    message += `Once payment is confirmed, we'll process your order immediately!`;

    return message;
  }
}

module.exports = new OrderManager();

