const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');

class FirestoreService {
  constructor() {
    if (!admin.apps.length) {
      initializeApp();
    }
    this.db = getFirestore();
  }

  // ─── Conversation History ────────────────────────────────────────────────

  async saveMessage(tenantId, customerPhone, role, message, messageId = null) {
    try {
      const conversationRef = this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('conversations').doc(customerPhone);

      await conversationRef.collection('messages').add({
        role, message, messageId,
        timestamp: FieldValue.serverTimestamp(),
        createdAt: new Date()
      });

      await conversationRef.set({
        tenantId, customerPhone,
        lastMessage: message, lastMessageRole: role,
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      if (role === 'user') {
        await this.trackContact(tenantId, customerPhone);
      }
    } catch (error) {
      console.error('Error saving message:', error);
      throw error;
    }
  }

  async getConversationHistory(tenantId, customerPhone, limit = 30) {
    try {
      const snapshot = await this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('conversations').doc(customerPhone)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();

      const messages = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        messages.push({
          role: data.role,
          text: data.message,
          timestamp: data.timestamp?.toDate() || data.createdAt
        });
      });
      return messages.reverse(); // oldest first for Gemini
    } catch (error) {
      console.error('Error getting conversation history:', error);
      return [];
    }
  }

  // ─── Order State ─────────────────────────────────────────────────────────

  async getOrderState(tenantId, customerPhone) {
    try {
      const ref = this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('order_states').doc(customerPhone);

      const doc = await ref.get();
      if (!doc.exists) return null;

      const data = doc.data();
      // Expire after 2 hours of inactivity
      if (data.updatedAt) {
        const updated = data.updatedAt.toDate ? data.updatedAt.toDate() : new Date(data.updatedAt);
        if (Date.now() - updated.getTime() > 2 * 60 * 60 * 1000) {
          await ref.delete().catch(() => {});
          return null;
        }
      }

      return { state: data.state || 'idle', pending_order: data.pending_order || null };
    } catch (error) {
      console.error('Error getting order state:', error);
      return null;
    }
  }

  async saveOrderState(tenantId, customerPhone, { state, pending_order }) {
    try {
      const ref = this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('order_states').doc(customerPhone);

      // Clean up when order flow is done
      if (!state || state === 'idle' || state === 'complete') {
        await ref.delete().catch(() => {});
        return;
      }

      await ref.set({
        tenantId, customerPhone, state,
        pending_order: pending_order || null,
        updatedAt: FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error('Error saving order state:', error);
      // Non-fatal
    }
  }

  // ─── Message Deduplication ───────────────────────────────────────────────

  async hasProcessedMessage(tenantId, messageId) {
    try {
      if (!messageId) return false;
      const doc = await this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('processed_messages').doc(messageId)
        .get();
      return doc.exists;
    } catch (error) {
      console.error('Error checking processed message:', error);
      return false;
    }
  }

  async markMessageProcessed(tenantId, messageId) {
    try {
      if (!messageId) return;
      await this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('processed_messages').doc(messageId)
        .set({ processedAt: FieldValue.serverTimestamp(), tenantId });

      // Cleanup old dedup records 1% of the time
      if (Math.random() < 0.01) this._cleanupOldProcessedMessages(tenantId).catch(() => {});
    } catch (error) {
      console.error('Error marking message processed:', error);
    }
  }

  async _cleanupOldProcessedMessages(tenantId) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snapshot = await this.db
      .collection('tenants').doc(tenantId.toString())
      .collection('processed_messages')
      .where('processedAt', '<', cutoff).limit(100).get();
    const batch = this.db.batch();
    snapshot.forEach(doc => batch.delete(doc.ref));
    if (!snapshot.empty) await batch.commit();
  }

  // ─── Contacts ────────────────────────────────────────────────────────────

  async trackContact(tenantId, customerPhone) {
    try {
      const ref = this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('contacts').doc(customerPhone);

      const doc = await ref.get();
      if (!doc.exists) {
        await ref.set({
          tenantId, customerPhone,
          firstContactAt: FieldValue.serverTimestamp(),
          lastContactAt: FieldValue.serverTimestamp(),
          messageCount: 1
        });
        await this.incrementContactCount(tenantId);
      } else {
        await ref.update({
          lastContactAt: FieldValue.serverTimestamp(),
          messageCount: FieldValue.increment(1)
        });
      }
    } catch (error) {
      console.error('Error tracking contact:', error);
      throw error;
    }
  }

  async incrementContactCount(tenantId) {
    try {
      await this.db.collection('tenants').doc(tenantId.toString()).set({
        tenantId,
        contactCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error('Error incrementing contact count:', error);
      throw error;
    }
  }

  async getContactCount(tenantId) {
    try {
      const doc = await this.db.collection('tenants').doc(tenantId.toString()).get();
      if (doc.exists) return doc.data().contactCount || 0;

      const snapshot = await this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('contacts').count().get();
      const count = snapshot.data().count;

      await this.db.collection('tenants').doc(tenantId.toString()).set({
        tenantId, contactCount: count, updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      return count;
    } catch (error) {
      console.error('Error getting contact count:', error);
      return 0;
    }
  }

  async getContactLimit(tenantId) {
    try {
      const doc = await this.db.collection('tenants').doc(tenantId.toString()).get();
      return doc.exists ? (doc.data().contactLimit || 1000) : 1000;
    } catch (error) {
      console.error('Error getting contact limit:', error);
      return 1000;
    }
  }

  async setContactLimit(tenantId, limit) {
    try {
      await this.db.collection('tenants').doc(tenantId.toString()).set({
        tenantId, contactLimit: limit, updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error('Error setting contact limit:', error);
      throw error;
    }
  }

  async checkContactLimit(tenantId) {
    try {
      const [count, limit] = await Promise.all([
        this.getContactCount(tenantId),
        this.getContactLimit(tenantId)
      ]);
      return { reached: count >= limit, count, limit, remaining: Math.max(0, limit - count) };
    } catch (error) {
      console.error('Error checking contact limit:', error);
      return { reached: false, count: 0, limit: 1000, remaining: 1000 };
    }
  }

  async getContacts(tenantId, limit = 100) {
    try {
      const snapshot = await this.db
        .collection('tenants').doc(tenantId.toString())
        .collection('contacts')
        .orderBy('lastContactAt', 'desc').limit(limit).get();

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
