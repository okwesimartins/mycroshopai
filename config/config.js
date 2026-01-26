require('dotenv').config();

/**
 * Configuration Management
 */
module.exports = {
  // Google Cloud
  googleCloud: {
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    region: process.env.GOOGLE_CLOUD_REGION || 'us-central1'
  },

  // Gemini AI
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp'
  },

  // MycroShop API
  mycroshop: {
    apiUrl: process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com',
    apiKey: process.env.MYCROSHOP_API_KEY
  },

  // Database
  database: {
    main: {
      host: process.env.MAIN_DB_HOST,
      user: process.env.MAIN_DB_USER,
      password: process.env.MAIN_DB_PASSWORD,
      database: process.env.MAIN_DB_NAME || 'mycroshop_main'
    },
    tenant: {
      host: process.env.TENANT_DB_HOST,
      user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD,
      prefix: process.env.TENANT_DB_PREFIX || 'mycroshop_tenant_'
    },
    sharedFree: {
      database: process.env.SHARED_FREE_DB_NAME || 'mycroshop_free_shared'
    },
    useDirectDb: process.env.USE_DIRECT_DB === 'true'
  },

  // WhatsApp/Meta
  whatsapp: {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    verifyToken: process.env.META_VERIFY_TOKEN,
    baseUrl: 'https://graph.facebook.com/v18.0'
  },

  // Encryption
  encryption: {
    key: process.env.ENCRYPTION_KEY || 'default-key-change-in-production'
  },

  // Environment
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production'
};

