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
    const providedSignature = signature.replace('sha256=', '').trim();
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload, typeof payload === 'string' ? 'utf8' : undefined)
      .digest('hex');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const providedBuf = Buffer.from(providedSignature, 'utf8');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * Send text message via WhatsApp API
   * @param {string} phoneNumberId - WhatsApp Phone Number ID
   * @param {string} accessToken - Access token
   * @param {string} to - Recipient phone number (with country code, no +)
   * @param {string} message - Message text
   * @returns {Promise<Object>} API response
   */
  async sendMessage(phoneNumberId, accessToken, to, message, replyToMessageId = null) {
    try {
      const formattedTo = to.replace(/[+\s]/g, '');

      const body = {
        messaging_product: 'whatsapp',
        to: formattedTo,
        type: 'text',
        text: { body: message },
      };

      // Tag the reply to the customer's incoming message — they see it quoted
      if (replyToMessageId) {
        body.context = { message_id: replyToMessageId };
      }

      const response = await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        body,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data,
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
   * Send an interactive button message.
   * Used to send the store owner an Approve / Decline prompt after a receipt is received.
   * Up to 3 buttons supported by WhatsApp Cloud API.
   *
   * @param {string} phoneNumberId
   * @param {string} accessToken
   * @param {string} to            - recipient phone number
   * @param {string} bodyText      - main message body
   * @param {Array}  buttons       - [{ id: 'btn_id', title: 'Button Label' }, ...]
   * @param {string} [headerText]  - optional bold header line
   * @param {string} [footerText]  - optional grey footer line
   */
  async sendInteractiveButtons(phoneNumberId, accessToken, to, bodyText, buttons, headerText = null, footerText = null) {
    if (!phoneNumberId || !accessToken || !to || !buttons?.length) return null;
    try {
      const formattedTo = to.replace(/[+\s]/g, '');
      const interactive = {
        type: 'button',
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) },
          })),
        },
      };
      if (headerText) interactive.header = { type: 'text', text: String(headerText).slice(0, 60) };
      if (footerText) interactive.footer = { text: String(footerText).slice(0, 60) };

      const response = await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', to: formattedTo, type: 'interactive', interactive },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
      return { success: true, messageId: response.data.messages?.[0]?.id };
    } catch (error) {
      console.error('[WhatsApp] sendInteractiveButtons error:', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Download a media file (image) sent by a WhatsApp user.
   * Two-step process required by Meta:
   *   1. GET /{media-id} → returns the temporary download URL
   *   2. GET that URL (with same auth header) → returns the raw bytes
   *
   * @param {string} mediaId     - The media ID from the incoming message
   * @param {string} accessToken - Access token
   * @returns {Promise<{ base64: string, mimeType: string }|null>}
   */
  async downloadMedia(mediaId, accessToken) {
    if (!mediaId || !accessToken) return null;
    try {
      // Step 1: resolve media URL
      const metaRes = await axios.get(
        `${this.baseUrl}/${mediaId}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      const mediaUrl = metaRes.data?.url;
      if (!mediaUrl) { console.warn('[WhatsApp] downloadMedia: no URL returned'); return null; }

      // Step 2: download the actual bytes
      const imageRes = await axios.get(mediaUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        responseType: 'arraybuffer',
        timeout: 10000,
      });

      const mimeType = imageRes.headers['content-type']?.split(';')[0] || 'image/jpeg';
      const base64   = Buffer.from(imageRes.data).toString('base64');
      return { base64, mimeType };

    } catch (error) {
      console.error('[WhatsApp] downloadMedia failed:', error.response?.data?.error?.message || error.message);
      return null;
    }
  }

  /**
   * Mark an incoming message as read.
   * This shows double blue ticks to the customer immediately, signalling
   * that the message was seen and a reply is coming — closest equivalent
   * to a typing indicator available in the WhatsApp Cloud API.
   *
   * Call this as early as possible after receiving a message (fire-and-forget).
   * Never let this block the main processing flow.
   *
   * @param {string} phoneNumberId - WhatsApp Phone Number ID
   * @param {string} accessToken   - Access token
   * @param {string} messageId     - The wamid of the incoming message to mark read
   */
  async markAsRead(phoneNumberId, accessToken, messageId) {
    if (!phoneNumberId || !accessToken || !messageId) return;
    try {
      await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (error) {
      // Non-fatal — don't let read-receipt failures affect message processing
      console.warn('[WhatsApp] markAsRead failed:', error.response?.data?.error?.message || error.message);
    }
  }

  /**
   * Parse webhook payload from Meta
   * @param {Object} payload - Webhook payload
   * @returns {Object} Parsed message data
   */
  parseWebhook(payload) {
    try {
      if (!payload || typeof payload !== 'object') {
        return null;
      }
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
        text: message.text?.body || message.interactive?.button_reply?.title || '',
        type: message.type,
        timestamp: message.timestamp,
        phoneNumberId: value.metadata?.phone_number_id,
        profileName: value.contacts?.[0]?.profile?.name,
        quotedMessageId: message.context?.id || null,
        quotedMessageBody: message.context?.forwarded ? '[forwarded]' : null,
        incomingImage: message.type === 'image' ? {
          mediaId:  message.image?.id   || null,
          mimeType: message.image?.mime_type || 'image/jpeg',
          caption:  message.image?.caption  || '',
        } : null,
        // Interactive button reply — store owner tapped Approve or Decline
        buttonReply: message.type === 'interactive' && message.interactive?.type === 'button_reply'
          ? { id: message.interactive.button_reply.id, title: message.interactive.button_reply.title }
          : null,
      };
    } catch (error) {
      console.error('Error parsing webhook:', error);
      return null;
    }
  }
}

module.exports = new WhatsAppClient();

