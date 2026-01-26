# Quick Reference - AI Sales Agent Flow

## 🎯 Quick Answers

### Q: Where do businesses connect their WhatsApp?

**A: In the main MycroShop backend, NOT in the AI agent.**

- **Route:** `POST /api/v1/meta-connection/whatsapp/connect`
- **File:** `controllers/metaConnectionController.js`
- **Process:** OAuth flow → Store credentials in database

### Q: Where are the routes for WhatsApp connection?

**A: Main MycroShop backend routes file.**

- **File:** `routes/metaConnection.js`
- **Routes:**
  - `POST /api/v1/meta-connection/whatsapp/connect` - Start connection
  - `GET /api/v1/meta-connection/whatsapp/callback` - OAuth callback

### Q: Does the AI agent use DB connection or API?

**A: Both! Configurable via environment variable.**

- **Option 1:** Direct DB (`USE_DIRECT_DB=true`)
  - Faster, but less secure
  - Connects directly to MySQL databases
  
- **Option 2:** MycroShop API (`USE_DIRECT_DB=false`) ✅ **Recommended**
  - More secure
  - Uses REST API endpoints
  - Better for production

---

## 📊 Flow Diagram (Simple)

```
┌─────────────────┐
│ Business User  │
│ (Dashboard)    │
└────────┬───────┘
         │
         │ 1. Clicks "Connect WhatsApp"
         ▼
┌─────────────────────────────────────┐
│   MycroShop Backend                 │
│   - OAuth flow                        │
│   - Stores credentials in DB        │
│   Route: /meta-connection/whatsapp  │
└────────┬────────────────────────────┘
         │
         │ 2. WhatsApp connected ✅
         │
         ▼
┌─────────────────────────────────────┐
│   Customer sends WhatsApp message   │
└────────┬────────────────────────────┘
         │
         │ 3. Meta webhook
         ▼
┌─────────────────────────────────────┐
│   AI Agent (Cloud Functions)        │
│   - Receives webhook                │
│   - Processes with Gemini AI        │
│   - Queries inventory (DB or API)   │
│   - Sends response                  │
└─────────────────────────────────────┘
```

---

## 🔧 Configuration

### Environment Variables

```env
# Use direct DB or API?
USE_DIRECT_DB=false  # false = use API (recommended)

# If using API:
MYCROSHOP_API_URL=https://backend.mycroshop.com
MYCROSHOP_API_KEY=your-api-key

# If using direct DB:
MAIN_DB_HOST=your-db-host
TENANT_DB_HOST=your-tenant-db-host
```

---

## 📁 File Locations

### Main Backend (WhatsApp Connection)
- `routes/metaConnection.js` - Routes
- `controllers/metaConnectionController.js` - OAuth logic
- `models/index.js` - Database models

### AI Agent (Message Processing)
- `functions/whatsapp-webhook/index.js` - Webhook receiver
- `functions/process-message/index.js` - Message processor
- `lib/inventory.js` - Inventory queries (DB or API)
- `lib/orders.js` - Order creation (via API)
- `lib/firestore.js` - Message history

---

## 🔄 Data Flow

### Inventory Query
```
AI Agent → Check USE_DIRECT_DB
  ├─ true → Direct DB query
  └─ false → API call to MycroShop backend
```

### Order Creation
```
AI Agent → Always use API
  └─ POST /api/v1/onlineStoreOrders
```

### Payment Verification
```
AI Agent → Always use API
  └─ GET /api/v1/payments/verify
```

---

## ✅ Best Practices

1. **WhatsApp Connection:** Handle in main backend
2. **Message Processing:** Handle in AI agent
3. **Inventory Queries:** Use API for production
4. **Orders/Payments:** Always use API (has validation)
5. **Message History:** Use Firestore (not MySQL)

---

See `FLOW_EXPLANATION.md` for detailed flow diagrams and examples.

