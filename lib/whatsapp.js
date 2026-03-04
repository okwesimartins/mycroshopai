const axios = require('axios');
const crypto = require('crypto');

/**
 * WhatsApp Business API Client
 */
class WhatsAppClient {
  constructor() {
    this.baseUrl = 'https://graph.facebook.com/v18.0';
  }

  /**
   * Verify webhook signature from Meta
   * @param {string} signature - X-Hub-Signature-256 header
   * @param {string} payload - Request body
   * @param {string} secret - App secret
   * @returns {boolean} Is valid
   */
  verifyWebhookSignature(signature, payload, secret) {
    if (!signature || !secret) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    const providedSignature = signature.replace('sha256=', '');

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(providedSignature)
    );
  }

  /**
   * Send text message via WhatsApp API
   * @param {string} phoneNumberId - WhatsApp Phone Number ID
   * @param {string} accessToken - Access token
   * @param {string} to - Recipient phone number (with country code, no +)
   * @param {string} message - Message text
   * @returns {Promise<Object>} API response
   */
  async sendMessage(phoneNumberId, accessToken, to, message) {
    try {
      const formattedTo = to.replace(/[+\s]/g, '');

      const response = await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: formattedTo,
          type: 'text',
          text: {
            body: message
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data
      };
    } catch (error) {
      console.error('WhatsApp send message error:', error.response?.data || error.message);
      throw new Error(`Failed to send WhatsApp message: ${error.message}`);
    }
  }

  /**
   * Send image via WhatsApp (by URL) – for product photos, catalog, etc.
   * @param {string} phoneNumberId - WhatsApp Phone Number ID
   * @param {string} accessToken - Access token
   * @param {string} to - Recipient phone number (with country code, no +)
   * @param {string} imageUrl - Public URL of the image (HTTPS)
   * @param {string} [caption] - Optional caption (max ~1024 chars)
   * @returns {Promise<Object>} API response
   */
  async sendImage(phoneNumberId, accessToken, to, imageUrl, caption = '') {
    try {
      const formattedTo = to.replace(/[+\s]/g, '');
      const body = {
        messaging_product: 'whatsapp',
        to: formattedTo,
        type: 'image',
        image: {
          link: imageUrl
        }
      };
      if (caption && String(caption).trim()) {
        body.image.caption = String(caption).trim().slice(0, 1024);
      }

      const response = await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        body,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data
      };
    } catch (error) {
      console.error('WhatsApp send image error:', error.response?.data || error.message);
      throw new Error(`Failed to send WhatsApp image: ${error.message}`);
    }
  }

  /**
   * Send template message (for notifications)
   * @param {string} phoneNumberId - WhatsApp Phone Number ID
   * @param {string} accessToken - Access token
   * @param {string} to - Recipient phone number
   * @param {string} templateName - Template name
   * @param {Array} parameters - Template parameters
   * @returns {Promise<Object>} API response
   */
  async sendTemplateMessage(phoneNumberId, accessToken, to, templateName, parameters = []) {
    try {
      const formattedTo = to.replace(/[+\s]/g, '');

      const response = await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: formattedTo,
          type: 'template',
          template: {
            name: templateName,
            language: { code: 'en' },
            components: parameters.length > 0 ? [{
              type: 'body',
              parameters: parameters.map(p => ({
                type: 'text',
                text: p
              }))
            }] : []
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data
      };
    } catch (error) {
      console.error('WhatsApp template message error:', error.response?.data || error.message);
      throw new Error(`Failed to send template message: ${error.message}`);
    }
  }

  /**
   * Parse webhook payload from Meta
   * @param {Object} payload - Webhook payload
   * @returns {Object} Parsed message data
   */
  parseWebhook(payload) {
    try {
      if (payload.object !== 'whatsapp_business_account') {
        return null;
      }

      const entry = payload.entry?.[0];
      if (!entry) {
        return null;
      }

      const change = entry.changes?.[0];
      if (!change || change.field !== 'messages') {
        return null;
      }

      const value = change.value;
      const message = value.messages?.[0];
      
      if (!message) {
        return null;
      }

      return {
        messageId: message.id,
        from: message.from,
        text: message.text?.body || '',
        type: message.type,
        timestamp: message.timestamp,
        phoneNumberId: value.metadata?.phone_number_id,
        profileName: value.contacts?.[0]?.profile?.name
      };
    } catch (error) {
      console.error('Error parsing webhook:', error);
      return null;
    }
  }
}

module.exports = new WhatsAppClient();

