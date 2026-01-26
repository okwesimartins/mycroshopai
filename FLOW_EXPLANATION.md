# Complete Flow Explanation - AI Sales Agent

## Overview

This document explains the complete flow from business WhatsApp connection to customer message processing, including where each component lives and how they interact.

---

## Part 1: Business WhatsApp Connection Flow

### Where It Happens: **MycroShop Main Backend** (NOT in AI Agent)

The AI agent does NOT handle WhatsApp connection. That's done in the main MycroShop backend.

### Flow Diagram

```
Business User (MycroShop Dashboard)
    ↓
1. Clicks "Connect WhatsApp" button
    ↓
2. MycroShop Backend: POST /api/v1/meta-connection/whatsapp/connect
    ↓
3. Backend generates OAuth URL
    ↓
4. Redirects business to Meta OAuth page
    ↓
5. Business authorizes on Meta
    ↓
6. Meta redirects back: /api/v1/meta-connection/whatsapp/callback
    ↓
7. Backend exchanges code for access token
    ↓
8. Backend gets WhatsApp Business Account (WABA) and Phone Number ID
    ↓
9. Backend stores in database:
   - whatsapp_connections table (main DB)
   - Stores: tenant_id, phone_number_id, access_token, waba_id
    ↓
10. Connection complete! ✅
```

### Routes (In Main MycroShop Backend)

**File:** `routes/metaConnection.js`

```javascript
// Initiate WhatsApp connection
POST /api/v1/meta-connection/whatsapp/connect
→ Returns OAuth URL

// Handle OAuth callback
GET /api/v1/meta-connection/whatsapp/callback
→ Exchanges code for token
→ Stores connection in database
→ Redirects to frontend
```

**Controller:** `controllers/metaConnectionController.js`

- `initiateWhatsAppConnection()` - Generates OAuth URL
- `handleWhatsAppCallback()` - Handles OAuth callback, stores credentials

### Database Storage

**Table:** `whatsapp_connections` (in `mycroshop_main` database)

```sql
CREATE TABLE whatsapp_connections (
  id INT PRIMARY KEY,
  tenant_id INT NOT NULL,
  phone_number_id VARCHAR(255) NOT NULL,
  waba_id VARCHAR(255),
  access_token TEXT NOT NULL,  -- Encrypted
  connected_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

---

## Part 2: Customer Message Flow

### Where It Happens: **AI Sales Agent** (Google Cloud Functions)

Once WhatsApp is connected, the AI agent handles all customer messages.

### Flow Diagram

```
Customer sends WhatsApp message
    ↓
Meta WhatsApp Business API
    ↓
1. Meta sends webhook to: 
   https://cloud-function-url/whatsappWebhook
    ↓
2. AI Agent: whatsapp-webhook function
   - Verifies webhook signature
   - Parses message data
   - Gets tenant_id from phone_number_id
    ↓
3. AI Agent: process-message function
   - Gets tenant info (free/enterprise)
   - Checks contact limit
   - Gets conversation history from Firestore
   - Calls Gemini AI
    ↓
4. Gemini AI processes message
   - Identifies intent (query, order, payment)
   - May need to query inventory
    ↓
5. AI Agent queries inventory/orders:
   Option A: Direct DB connection (if USE_DIRECT_DB=true)
   Option B: MycroShop API call
    ↓
6. AI generates response
    ↓
7. AI Agent sends response via WhatsApp API
    ↓
8. Saves conversation to Firestore
    ↓
9. Updates contact count in Firestore
```

### Routes (In AI Agent - Google Cloud Functions)

**Function 1:** `functions/whatsapp-webhook/index.js`
- **URL:** `https://region-project.cloudfunctions.net/whatsappWebhook`
- **Purpose:** Receives webhooks from Meta
- **Method:** GET (verification) / POST (messages)

**Function 2:** `functions/process-message/index.js`
- **Purpose:** Processes messages with AI
- **Triggered by:** whatsapp-webhook function (internal)

**Function 3:** `functions/contact-management/index.js`
- **URL:** `https://region-project.cloudfunctions.net/contactManagement`
- **Purpose:** Manages contact counts and pricing tiers
- **Method:** GET/POST

---

## Part 3: Inventory & Order Processing

### How It Works: **Dual Mode** (DB or API)

The AI agent can use either direct database connection OR MycroShop API.

### Configuration

**Environment Variable:** `USE_DIRECT_DB`

- `USE_DIRECT_DB=true` → Direct database connection (faster)
- `USE_DIRECT_DB=false` → MycroShop API calls (more secure)

### Option A: Direct Database Connection

**When:** `USE_DIRECT_DB=true`

**How it works:**
```javascript
// In lib/inventory.js
async queryProducts(tenantId, subscriptionPlan, filters) {
  if (process.env.USE_DIRECT_DB === 'true') {
    // Direct DB access
    return await database.getProducts(tenantId, subscriptionPlan, filters);
  }
  // ... else use API
}
```

**Database Access:**
- **Free Users:** Queries `mycroshop_free_shared` database
  - Table: `online_store_products` (filtered by `tenant_id`)
- **Enterprise Users:** Queries `mycroshop_tenant_{id}` database
  - Tables: `products`, `product_stores`, `stores`

**Pros:**
- ✅ Faster (no HTTP overhead)
- ✅ Lower latency
- ✅ Can use complex queries

**Cons:**
- ❌ Requires database credentials in Cloud Functions
- ❌ Less secure (direct DB access)
- ❌ Harder to scale

### Option B: MycroShop API

**When:** `USE_DIRECT_DB=false`

**How it works:**
```javascript
// In lib/inventory.js
async queryProducts(tenantId, subscriptionPlan, filters) {
  // API call to MycroShop backend
  const response = await axios.get(
    `${this.apiUrl}/api/v1/store/products?tenant_id=${tenantId}`,
    {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      }
    }
  );
  return response.data.data.products;
}
```

**API Endpoints Used:**
- `GET /api/v1/store/products?tenant_id={id}` - Get products
- `POST /api/v1/onlineStoreOrders` - Create order
- `GET /api/v1/payments/verify?reference={ref}` - Verify payment
- `PUT /api/v1/inventory/products/{id}/stock` - Update inventory

**Pros:**
- ✅ More secure (API authentication)
- ✅ Better separation of concerns
- ✅ Easier to add rate limiting
- ✅ Can add caching layer

**Cons:**
- ❌ Slower (HTTP overhead)
- ❌ Network latency
- ❌ More API calls

### Recommendation

**For Production:**
- Use **MycroShop API** (`USE_DIRECT_DB=false`)
- More secure and maintainable
- Better for scaling

**For Development:**
- Use **Direct DB** (`USE_DIRECT_DB=true`)
- Faster for testing
- Easier debugging

---

## Part 4: Complete System Architecture

### Component Map

```
┌─────────────────────────────────────────────────────────────┐
│                    MycroShop Main Backend                   │
│                    (Express.js Server)                       │
│                                                             │
│  Routes:                                                    │
│  - /api/v1/meta-connection/whatsapp/connect                │
│  - /api/v1/meta-connection/whatsapp/callback               │
│  - /api/v1/store/products                                   │
│  - /api/v1/onlineStoreOrders                                │
│  - /api/v1/payments/verify                                  │
│                                                             │
│  Database:                                                  │
│  - mycroshop_main (whatsapp_connections table)              │
│  - mycroshop_free_shared (free users)                       │
│  - mycroshop_tenant_{id} (enterprise users)                │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ API Calls (if USE_DIRECT_DB=false)
                            │ OR Direct DB (if USE_DIRECT_DB=true)
                            │
┌─────────────────────────────────────────────────────────────┐
│              AI Sales Agent (Google Cloud Functions)        │
│                                                             │
│  Functions:                                                 │
│  1. whatsappWebhook                                         │
│     - Receives webhooks from Meta                           │
│     - URL: /whatsappWebhook                                  │
│                                                             │
│  2. processMessage                                          │
│     - Processes messages with Gemini AI                     │
│     - Queries inventory/orders                              │
│     - Sends responses                                       │
│                                                             │
│  3. contactManagement                                       │
│     - Manages contact counts                                │
│     - URL: /contactManagement                               │
│                                                             │
│  Services:                                                  │
│  - lib/gemini.js (AI processing)                           │
│  - lib/whatsapp.js (WhatsApp API)                           │
│  - lib/inventory.js (Product queries)                      │
│  - lib/orders.js (Order creation)                          │
│  - lib/payments.js (Payment verification)                  │
│  - lib/firestore.js (Message history, contacts)            │
│  - lib/database.js (DB connection if USE_DIRECT_DB=true)   │
│                                                             │
│  Storage:                                                   │
│  - Firestore (conversations, contacts)                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Webhook
                            │
┌─────────────────────────────────────────────────────────────┐
│                    Meta WhatsApp Business API               │
│                                                             │
│  - Receives customer messages                               │
│  - Sends webhooks to AI agent                               │
│  - Receives messages from AI agent                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 5: Data Flow Examples

### Example 1: Customer Asks "Do you have red shirts?"

```
1. Customer → WhatsApp: "Do you have red shirts?"
   ↓
2. Meta → AI Agent Webhook: POST /whatsappWebhook
   {
     "messages": [{
       "from": "+2348012345678",
       "text": { "body": "Do you have red shirts?" }
     }],
     "metadata": {
       "phone_number_id": "123456789"
     }
   }
   ↓
3. AI Agent: Get tenant_id from phone_number_id
   - Query: SELECT tenant_id FROM whatsapp_connections WHERE phone_number_id = '123456789'
   - Result: tenant_id = 21
   ↓
4. AI Agent: Get tenant info
   - Query: SELECT subscription_plan FROM tenants WHERE id = 21
   - Result: subscription_plan = 'free'
   ↓
5. AI Agent: Query inventory
   
   IF USE_DIRECT_DB=true:
     - Connect to: mycroshop_free_shared
     - Query: SELECT * FROM online_store_products 
             WHERE tenant_id = 21 
             AND name LIKE '%red shirt%'
             AND is_published = true
   
   IF USE_DIRECT_DB=false:
     - API Call: GET https://backend.mycroshop.com/api/v1/store/products?tenant_id=21&name=red+shirt
     - Backend queries database and returns products
   ↓
6. AI Agent: Process with Gemini AI
   - Input: "Do you have red shirts?" + product data
   - Output: "Yes! We have red shirts available. Price: ₦5,000. Stock: 10 units."
   ↓
7. AI Agent: Send response via WhatsApp API
   - POST https://graph.facebook.com/v18.0/{phone_number_id}/messages
   - Body: { "to": "+2348012345678", "text": { "body": "Yes! We have..." } }
   ↓
8. AI Agent: Save to Firestore
   - Save user message
   - Save AI response
   - Update contact count (if new contact)
   ↓
9. Customer receives response ✅
```

### Example 2: Customer Places Order

```
1. Customer → WhatsApp: "I want to order 2 red shirts"
   ↓
2. AI Agent processes message
   - Gemini AI identifies order intent
   - Extracts: product="red shirt", quantity=2
   ↓
3. AI Agent: Check availability
   - Query inventory (DB or API)
   - Verify stock >= 2
   ↓
4. AI Agent: Create order
   
   IF USE_DIRECT_DB=false:
     - API Call: POST https://backend.mycroshop.com/api/v1/onlineStoreOrders
     - Body: { tenant_id: 21, items: [...], customer_info: {...} }
     - Backend creates order in database
     - Returns: order_id, payment_link
   
   IF USE_DIRECT_DB=true:
     - Direct DB insert (not recommended for orders)
     - Better to use API for orders (has validation, payment links, etc.)
   ↓
5. AI Agent: Send payment link to customer
   - "✅ Order created! Pay here: {payment_link}"
   ↓
6. Customer pays
   ↓
7. Payment gateway webhook → MycroShop Backend
   ↓
8. Customer asks: "Is my payment confirmed?"
   ↓
9. AI Agent: Verify payment
   - API Call: GET /api/v1/payments/verify?reference={ref}
   - Returns: payment status
   ↓
10. AI Agent: Confirm to customer
    - "✅ Payment confirmed! Your order is being processed."
   ↓
11. AI Agent: Update inventory (after payment confirmed)
    - API Call: PUT /api/v1/inventory/products/{id}/stock
    - Deducts quantity from stock
```

---

## Summary

### Where Things Happen

| Component | Location | Purpose |
|-----------|----------|---------|
| **WhatsApp Connection** | MycroShop Backend | OAuth flow, stores credentials |
| **Webhook Receiver** | AI Agent (Cloud Function) | Receives messages from Meta |
| **Message Processing** | AI Agent (Cloud Function) | AI processing, responses |
| **Inventory Queries** | AI Agent → DB or API | Gets product data |
| **Order Creation** | AI Agent → MycroShop API | Creates orders |
| **Payment Verification** | AI Agent → MycroShop API | Checks payment status |
| **Message History** | Firestore | Stores conversations |
| **Contact Counting** | Firestore | Tracks unique contacts |

### Key Points

1. **WhatsApp Connection:** Handled in main MycroShop backend, NOT in AI agent
2. **Message Processing:** Handled in AI agent (Google Cloud Functions)
3. **Inventory/Orders:** Can use direct DB OR API (configurable)
4. **Recommendation:** Use API for production (more secure)
5. **Firestore:** Used for message history and contact counting (not MySQL)

### Routes Summary

**Main Backend Routes:**
- `POST /api/v1/meta-connection/whatsapp/connect` - Start OAuth
- `GET /api/v1/meta-connection/whatsapp/callback` - OAuth callback
- `GET /api/v1/store/products` - Get products
- `POST /api/v1/onlineStoreOrders` - Create order
- `GET /api/v1/payments/verify` - Verify payment

**AI Agent Functions:**
- `POST /whatsappWebhook` - Receive webhooks
- `GET/POST /contactManagement` - Contact management

---

This should clarify the complete flow! 🚀

