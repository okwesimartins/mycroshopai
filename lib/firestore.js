/**
 * Firestore router — uses real Firestore when firebase-admin is available,
 * falls back to a no-op stub so the pipeline still runs without Firebase.
 *
 * The stub returns safe defaults (empty history, no limits hit).
 * Without the real implementation, the AI has NO memory between messages.
 */

const stub = {
  async saveMessage()              {},
  async getConversationHistory()   { return []; },
  async checkContactLimit()        { return { reached: false, count: 0, limit: 1000, remaining: 1000 }; },
  async trackContact()             {},
  async getContactCount()          { return 0; },
  async getContactLimit()          { return 1000; },
  async setContactLimit()          {},
  async getContacts()              { return []; },
  async getOrderState()            { return null; },
  async saveOrderState()           {},
  async hasProcessedMessage()      { return false; },
  async markMessageProcessed()     {},
};

const REQUIRED_METHODS = [
  'saveMessage',
  'getConversationHistory',
  'checkContactLimit',
  'trackContact',
  'getOrderState',
  'saveOrderState',
  'hasProcessedMessage',
  'markMessageProcessed',
];

let firestoreImpl;

try {
  const real = require('./firestore-real');
  const missing = REQUIRED_METHODS.filter(m => typeof real[m] !== 'function');

  if (missing.length > 0) {
    console.warn('[Firestore] firestore-real is missing methods:', missing.join(', '));
    console.warn('[Firestore] Falling back to stub — conversation history will NOT be saved.');
    firestoreImpl = stub;
  } else {
    console.log('[Firestore] Using real Firestore implementation ✅');
    firestoreImpl = real;
  }
} catch (e) {
  console.warn('[Firestore] firebase-admin not available, using stub:', e.message || e.code);
  console.warn('[Firestore] Conversation history will NOT persist between messages.');
  firestoreImpl = stub;
}

module.exports = firestoreImpl;
