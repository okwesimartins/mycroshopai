const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');

/**
 * Firestore Service
 * Manages message history and contact counting
 */
class FirestoreService {
  constructor() {
    if (!admin.apps.length) {
      // Initialize Firebase Admin (uses default credentials in Cloud Functions)
      initializeApp();
    }
    this.db = getFirestore();
  }

  /**
   * Save message to conversation history
   * @param {number} tenantId - Tenant ID
   * @param {string} customerPhone - Customer phone number
   * @param {string} role - 'user' or 'assistant'
   * @param {string} message - Message text
   * @param {string} messageId - WhatsApp message ID
   * @returns {Promise<void>}
   */
  async saveMessage(tenantId, customerPhone, role, message, messageId = null) {
    try {
      const conversationRef = this.db
        .collection('tenants')
        .doc(tenantId.toString())
        .collection('conversations')
        .doc(customerPhone);

      await conversationRef.collection('messages').add({
        role,
        message,
        messageId,
        timestamp: FieldValue.serverTimestamp(),
        createdAt: new Date()
      });

      // Update conversation metadata
      await conversationRef.set({
        tenantId,
        customerPhone,
        lastMessage: message,
        lastMessageRole: role,
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      // Track contact (if new contact)
      if (role === 'user') {
        await this.trackContact(tenantId, customerPhone);
      }
    } catch (error) {
      console.error('Error saving message to Firestore:', error);
      throw error;
    }
  }

  /**
   * Get conversation history
   * @param {number} tenantId - Tenant ID
   * @param {string} customerPhone - Customer phone number
   * @param {number} limit - Number of messages to retrieve (default: 20)
   * @returns {Promise<Array>} Conversation history
   */
  async getConversationHistory(tenantId, customerPhone, limit = 20) {
    try {
      const messagesRef = this.db
        .collection('tenants')
        .doc(tenantId.toString())
        .collection('conversations')
        .doc(customerPhone)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(limit);

      const snapshot = await messagesRef.get();

      const messages = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        messages.push({
          role: data.role,
          text: data.message,
          timestamp: data.timestamp?.toDate() || data.createdAt
        });
      });

      // Reverse to get chronological order
      return messages.reverse();
    } catch (error) {
      console.error('Error getting conversation history:', error);
      return [];
    }
  }

  /**
   * Track contact (count unique contacts per tenant)
   * @param {number} tenantId - Tenant ID
   * @param {string} customerPhone - Customer phone number
   * @returns {Promise<void>}
   */
  async trackContact(tenantId, customerPhone) {
    try {
      const contactsRef = this.db
        .collection('tenants')
        .doc(tenantId.toString())
        .collection('contacts')
        .doc(customerPhone);

      const contactDoc = await contactsRef.get();

      if (!contactDoc.exists) {
        // New contact - add to collection
        await contactsRef.set({
          tenantId,
          customerPhone,
          firstContactAt: FieldValue.serverTimestamp(),
          lastContactAt: FieldValue.serverTimestamp(),
          messageCount: 1
        });

        // Increment contact count for tenant
        await this.incrementContactCount(tenantId);
      } else {
        // Existing contact - update last contact time
        await contactsRef.update({
          lastContactAt: FieldValue.serverTimestamp(),
          messageCount: FieldValue.increment(1)
        });
      }
    } catch (error) {
      console.error('Error tracking contact:', error);
      throw error;
    }
  }

  /**
   * Increment contact count for tenant
   * @param {number} tenantId - Tenant ID
   * @returns {Promise<void>}
   */
  async incrementContactCount(tenantId) {
    try {
      const tenantRef = this.db
        .collection('tenants')
        .doc(tenantId.toString());

      await tenantRef.set({
        tenantId,
        contactCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error('Error incrementing contact count:', error);
      throw error;
    }
  }

  /**
   * Get contact count for tenant
   * @param {number} tenantId - Tenant ID
   * @returns {Promise<number>} Contact count
   */
  async getContactCount(tenantId) {
    try {
      const tenantRef = this.db
        .collection('tenants')
        .doc(tenantId.toString());

      const doc = await tenantRef.get();

      if (doc.exists) {
        return doc.data().contactCount || 0;
      }

      // If document doesn't exist, count contacts manually
      const contactsRef = tenantRef.collection('contacts');
      const snapshot = await contactsRef.count().get();
      const count = snapshot.data().count;

      // Update tenant document with count
      await tenantRef.set({
        tenantId,
        contactCount: count,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      return count;
    } catch (error) {
      console.error('Error getting contact count:', error);
      return 0;
    }
  }

  /**
   * Get contact limit for tenant based on pricing tier
   * @param {number} tenantId - Tenant ID
   * @returns {Promise<number>} Contact limit
   */
  async getContactLimit(tenantId) {
    try {
      const tenantRef = this.db
        .collection('tenants')
        .doc(tenantId.toString());

      const doc = await tenantRef.get();

      if (doc.exists) {
        const data = doc.data();
        return data.contactLimit || 1000; // Default to 1k
      }

      // Default limit if not set
      return 1000;
    } catch (error) {
      console.error('Error getting contact limit:', error);
      return 1000;
    }
  }

  /**
   * Set contact limit for tenant (based on pricing tier)
   * @param {number} tenantId - Tenant ID
   * @param {number} limit - Contact limit
   * @returns {Promise<void>}
   */
  async setContactLimit(tenantId, limit) {
    try {
      const tenantRef = this.db
        .collection('tenants')
        .doc(tenantId.toString());

      await tenantRef.set({
        tenantId,
        contactLimit: limit,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error('Error setting contact limit:', error);
      throw error;
    }
  }

  /**
   * Check if tenant has reached contact limit
   * @param {number} tenantId - Tenant ID
   * @returns {Promise<Object>} { reached: boolean, count: number, limit: number }
   */
  async checkContactLimit(tenantId) {
    try {
      const [count, limit] = await Promise.all([
        this.getContactCount(tenantId),
        this.getContactLimit(tenantId)
      ]);

      return {
        reached: count >= limit,
        count,
        limit,
        remaining: Math.max(0, limit - count)
      };
    } catch (error) {
      console.error('Error checking contact limit:', error);
      return {
        reached: false,
        count: 0,
        limit: 1000,
        remaining: 1000
      };
    }
  }

  /**
   * Get all contacts for tenant
   * @param {number} tenantId - Tenant ID
   * @param {number} limit - Number of contacts to retrieve
   * @returns {Promise<Array>} Contacts list
   */
  async getContacts(tenantId, limit = 100) {
    try {
      const contactsRef = this.db
        .collection('tenants')
        .doc(tenantId.toString())
        .collection('contacts')
        .orderBy('lastContactAt', 'desc')
        .limit(limit);

      const snapshot = await contactsRef.get();

      const contacts = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        contacts.push({
          id: doc.id,
          customerPhone: data.customerPhone,
          firstContactAt: data.firstContactAt?.toDate(),
          lastContactAt: data.lastContactAt?.toDate(),
          messageCount: data.messageCount || 0
        });
      });

      return contacts;
    } catch (error) {
      console.error('Error getting contacts:', error);
      return [];
    }
  }
}

module.exports = new FirestoreService();

