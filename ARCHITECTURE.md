# AI Sales Agent Architecture

## Overview

The AI Sales Agent is a serverless application running on Google Cloud Functions that integrates WhatsApp Business API with Google Gemini AI to provide automated sales assistance.

## System Architecture

```
┌─────────────┐
│   WhatsApp  │
│   Customer  │
└──────┬──────┘
       │
       │ Message
       ▼
┌─────────────────────────────────────┐
│      Meta WhatsApp Business API      │
│      (Webhook Endpoint)              │
└──────┬──────────────────────────────┘
       │
       │ HTTP POST
       ▼
┌─────────────────────────────────────┐
│   Google Cloud Function              │
│   (whatsapp-webhook)                 │
│   - Receives webhook               │
│   - Verifies signature              │
│   - Routes to message processor     │
└──────┬──────────────────────────────┘
       │
       │ Trigger
       ▼
┌─────────────────────────────────────┐
│   Google Cloud Function              │
│   (process-message)                  │
│   - Gets tenant context              │
│   - Calls Gemini AI                  │
│   - Processes AI response            │
│   - Handles actions (order, payment)  │
└──────┬──────────────────────────────┘
       │
       ├─────────────────┬─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   Gemini    │  │ MycroShop  │  │  WhatsApp   │
│     AI      │  │    API     │  │     API     │
└─────────────┘  └─────────────┘  └─────────────┘
```

## Data Flow

### 1. Incoming Message Flow

```
Customer Message
    ↓
Meta Webhook
    ↓
Google Cloud Function (whatsapp-webhook)
    ↓
Extract: phone_number, message, tenant_id
    ↓
Google Cloud Function (process-message)
    ↓
Get Tenant Info (free/enterprise)
    ↓
Call Gemini AI with context
    ↓
AI processes message
    ↓
AI may query inventory/orders
    ↓
AI generates response
    ↓
Send response via WhatsApp API
```

### 2. Order Processing Flow

```
Customer: "I want to order 2 shirts"
    ↓
Gemini AI identifies intent
    ↓
Query inventory (via MycroShop API)
    ↓
Check availability
    ↓
Create order (via MycroShop API)
    ↓
Generate payment link
    ↓
Send payment link to customer
    ↓
Wait for payment confirmation
    ↓
Update order status
```

### 3. Inventory Query Flow

```
Customer: "Do you have red shirts?"
    ↓
Gemini AI identifies query
    ↓
Determine tenant type (free/enterprise)
    ↓
Free User:
  - Query OnlineStore products
  - Filter by tenant_id
Enterprise User:
  - Query all Store products
  - Filter by tenant_id
    ↓
Return available products
    ↓
AI formats response
    ↓
Send to customer
```

## Component Details

### 1. WhatsApp Webhook Handler

**Function:** `whatsapp-webhook`

**Responsibilities:**
- Receives webhooks from Meta
- Verifies webhook signature
- Extracts message data
- Identifies tenant from phone number
- Triggers message processing

**Input:**
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "2348012345678",
          "text": { "body": "Hello" }
        }],
        "metadata": {
          "phone_number_id": "123456789"
        }
      }
    }]
  }]
}
```

**Output:**
- Triggers `process-message` function
- Returns 200 OK to Meta

### 2. Message Processor

**Function:** `process-message`

**Responsibilities:**
- Gets tenant information
- Determines free vs enterprise
- Calls Gemini AI with context
- Handles AI actions (queries, orders)
- Sends response via WhatsApp

**Context for Gemini:**
```json
{
  "tenant_id": 21,
  "subscription_plan": "free",
  "customer_phone": "+2348012345678",
  "conversation_history": [...],
  "available_actions": [
    "query_inventory",
    "create_order",
    "check_payment",
    "update_inventory"
  ]
}
```

### 3. Gemini AI Integration

**Model:** Gemini 2.0 Flash (latest)

**System Prompt:**
```
You are an AI sales assistant for MycroShop platform. 
You help customers:
- Check product availability
- Place orders
- Confirm payments
- Answer questions about products

For free users: Only online store inventory
For enterprise users: All physical stores inventory

Always be helpful, friendly, and professional.
```

**Function Calling:**
- `query_inventory(product_name, filters)`
- `create_order(items, customer_info)`
- `check_payment(reference)`
- `update_inventory(product_id, quantity)`

### 4. Database Connection

**Free Users:**
- Shared database: `mycroshop_free_shared`
- Filter by `tenant_id` in all queries
- Only `OnlineStore` and `OnlineStoreProduct` tables

**Enterprise Users:**
- Separate database: `mycroshop_tenant_{id}`
- No `tenant_id` filter needed
- All tables: `Store`, `Product`, `ProductStore`, etc.

### 5. Inventory Management

**Free Users:**
```sql
SELECT * FROM online_store_products 
WHERE tenant_id = ? 
AND is_published = true
AND stock > 0
```

**Enterprise Users:**
```sql
SELECT p.*, ps.stock, s.name as store_name
FROM products p
JOIN product_stores ps ON p.id = ps.product_id
JOIN stores s ON ps.store_id = s.id
WHERE p.is_active = true
AND ps.stock > 0
```

### 6. Order Processing

**Flow:**
1. AI identifies order intent
2. Extract items from conversation
3. Validate inventory
4. Create order via MycroShop API
5. Generate payment link
6. Send to customer
7. Monitor payment status
8. Update inventory on payment

**API Call:**
```javascript
POST /api/v1/onlineStoreOrders
{
  "tenant_id": 21,
  "items": [...],
  "customer_info": {...}
}
```

### 7. Payment Confirmation

**Flow:**
1. Customer pays via payment link
2. Payment gateway webhook to MycroShop
3. MycroShop updates order status
4. AI queries payment status
5. Confirms to customer
6. Updates inventory

**API Call:**
```javascript
GET /api/v1/payments/verify?reference={ref}
```

## Security

### 1. Webhook Verification
- Verify Meta webhook signature
- Validate request source
- Prevent replay attacks

### 2. API Authentication
- Use API keys for MycroShop API
- Encrypt sensitive data
- Rate limiting

### 3. Data Privacy
- Encrypt customer data
- Secure token storage
- GDPR compliance

## Scalability

### Horizontal Scaling
- Google Cloud Functions auto-scale
- Stateless design
- Connection pooling for database

### Performance Optimization
- Cache tenant information
- Batch inventory queries
- Async message processing

## Monitoring

### Logging
- Cloud Logging for all functions
- Error tracking
- Performance metrics

### Alerts
- Failed webhook deliveries
- High error rates
- Payment processing issues

## Error Handling

### Retry Logic
- Exponential backoff for API calls
- Dead letter queue for failed messages
- Graceful degradation

### User Communication
- Friendly error messages
- Fallback responses
- Escalation to human support

## Cost Optimization

### Function Optimization
- Cold start minimization
- Efficient memory allocation
- Request batching

### API Calls
- Cache frequently accessed data
- Batch operations
- Rate limiting

## Deployment

### Environment
- Development: Test functions
- Staging: Pre-production testing
- Production: Live system

### CI/CD
- Automated testing
- Deployment pipelines
- Rollback capabilities

