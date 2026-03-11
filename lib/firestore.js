/**
 * Firestore Service (optional)
 * When firebase-admin is installed (e.g. on Google Cloud), uses Firestore for
 * conversation history and contact limits. When not available (e.g. backend on VPS),
 * uses a no-op stub so the AI pipeline still runs without Firebase.
 */

const stub = {
  async saveMessage() {},
  async getConversationHistory() {
    return [];
  },
  async checkContactLimit() {
    return { reached: false, count: 0, limit: 1000, remaining: 1000 };
  },
  async trackContact() {},
  async getContactCount() {
    return 0;
  },
  async getContactLimit() {
    return 1000;
  },
  async setContactLimit() {},
  async getContacts() {
    return [];
  },
  // Order state persistence (for multi-turn order collection)
  async getOrderState() {
    return null;
  },
  async saveOrderState() {},
  // Message deduplication
  async hasProcessedMessage() {
    return false;
  },
  async markMessageProcessed() {}
};

let firestoreImpl;

try {
  const real = require('./firestore-real');
  if (real && typeof real.checkContactLimit === 'function' && typeof real.getConversationHistory === 'function' && typeof real.saveMessage === 'function') {
    firestoreImpl = real;
  } else {
    console.warn('[Firestore] firestore-real loaded but missing methods (checkContactLimit/getConversationHistory/saveMessage), using stub');
    firestoreImpl = stub;
  }
} catch (e) {
  console.warn('[Firestore] firebase-admin not available, using stub:', e.message || e.code);
  firestoreImpl = stub;
}

module.exports = firestoreImpl;
