/**
 * Firestore Service (optional)
 * When firebase-admin is installed (e.g. on Google Cloud), uses Firestore for
 * conversation history and contact limits. When not available (e.g. backend on VPS),
 * uses a no-op stub so the AI pipeline still runs without Firebase.
 */
let firestoreImpl;

try {
  // Only load real implementation if firebase-admin is installed (e.g. on Google Cloud)
  firestoreImpl = require('./firestore-real');
} catch (e) {
  // firebase-admin not installed (e.g. local dev) – use stub; on Google Cloud firebase-admin is used so history is in Firestore
  console.warn('[Firestore] firebase-admin not available, using stub (no conversation history):', e.message || e.code);
  firestoreImpl = {
    async saveMessage() {},
    async getConversationHistory() { return []; },
    async checkContactLimit() {
      return { reached: false, count: 0, limit: 1000, remaining: 1000 };
    },
    async trackContact() {},
    async getContactCount() { return 0; },
    async getContactLimit() { return 1000; },
    async setContactLimit() {},
    async getContacts() { return []; }
  };
}

module.exports = firestoreImpl;
