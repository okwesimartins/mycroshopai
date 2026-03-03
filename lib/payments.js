const axios = require('axios');

/**
 * Payment Confirmation
 * Verifies payment status and confirms orders
 */
class PaymentManager {
  constructor() {
    this.apiUrl = process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com';
    this.apiKey = process.env.MYCROSHOP_API_KEY;
  }

  /**
   * Verify payment by reference
   * @param {string} reference - Payment reference
   * @param {number} tenantId - Tenant ID (optional)
   * @returns {Promise<Object>} Payment status
   */
  async verifyPayment(reference, tenantId = null) {
    try {
      const params = new URLSearchParams({ reference });
      if (tenantId) {
        params.append('tenant_id', tenantId.toString());
      }

      const response = await axios.get(
        `${this.apiUrl}/api/v1/payments/verify?${params}`,
        {
          headers: {
            'x-api-key': this.apiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.success) {
        return {
          success: true,
          paid: response.data.data.transaction?.status === 'success',
          transaction: response.data.data.transaction,
          order: response.data.data.order
        };
      }

      return {
        success: false,
        paid: false,
        message: response.data.message || 'Payment verification failed'
      };
    } catch (error) {
      console.error('Error verifying payment:', error.response?.data || error.message);
      return {
        success: false,
        paid: false,
        message: 'Failed to verify payment'
      };
    }
  }

  /**
   * Format payment confirmation message
   * @param {Object} paymentData - Payment verification result
   * @returns {string} Formatted message
   */
  formatPaymentConfirmation(paymentData) {
    if (!paymentData.paid) {
      return `❌ Payment not confirmed. Please check your payment reference or try again.`;
    }

    const transaction = paymentData.transaction;
    const order = paymentData.order;

    let message = `✅ Payment Confirmed!\n\n`;
    message += `Transaction ID: ${transaction.reference}\n`;
    message += `Amount: ₦${parseFloat(transaction.amount || 0).toLocaleString()}\n`;
    
    if (order) {
      message += `Order ID: #${order.id}\n`;
      message += `\nYour order is being processed. You'll receive updates soon!`;
    } else {
      message += `\nYour payment has been confirmed successfully!`;
    }

    return message;
  }
}

module.exports = new PaymentManager();

