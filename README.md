# AI Sales Agent - WhatsApp Integration

A Google Cloud Functions-based AI sales assistant powered by Gemini that connects to WhatsApp, processes orders, manages inventory, and confirms payments for MycroShop platform.

## Features

- 🤖 **AI-Powered Sales Assistant**: Uses Google Gemini (latest version) for natural conversations
- 📱 **WhatsApp Integration**: Receives and sends messages via WhatsApp Business API
- 🛒 **Order Processing**: Creates orders from customer conversations
- 📦 **Inventory Management**: Checks availability and updates stock
- 💳 **Payment Confirmation**: Verifies and confirms payments
- 🏢 **Multi-Tenant Support**: Works for both free and enterprise users
- 🔄 **Real-time Updates**: Updates inventory and order status in real-time
- 💬 **Message History**: Firestore-based conversation history
- 👥 **Contact Counting**: Track unique contacts with pricing tiers (1K-10K)
- 📊 **Usage Analytics**: Monitor contact usage and limits

## Architecture

```
WhatsApp → Meta Webhook → Google Cloud Function → Gemini AI → MycroShop API → Database
```

## Project Structure

```
ai-sales-agent/
├── functions/
│   ├── whatsapp-webhook/          # WhatsApp webhook handler
│   ├── process-message/            # Message processing with Gemini
│   └── contact-management/        # Contact count & pricing API
├── lib/
│   ├── gemini.js                   # Gemini AI integration
│   ├── whatsapp.js                 # WhatsApp API client
│   ├── database.js                 # Database connection (free/enterprise)
│   ├── firestore.js                # Firestore service (message history, contacts)
│   ├── contact-pricing.js          # Contact pricing tiers
│   ├── inventory.js                # Inventory management
│   ├── orders.js                   # Order processing
│   └── payments.js                 # Payment confirmation
├── config/
│   └── config.js                   # Configuration management
└── package.json
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Environment Variables

Create `.env` file:

```env
# Google Cloud
GOOGLE_CLOUD_PROJECT_ID=your-project-id
GEMINI_API_KEY=your-gemini-api-key

# MycroShop API
MYCROSHOP_API_URL=https://backend.mycroshop.com
MYCROSHOP_API_KEY=your-api-key

# Database (for direct access if needed)
MAIN_DB_HOST=your-db-host
MAIN_DB_USER=your-db-user
MAIN_DB_PASSWORD=your-db-password
MAIN_DB_NAME=mycroshop_main

TENANT_DB_HOST=your-tenant-db-host
TENANT_DB_USER=your-tenant-db-user
TENANT_DB_PASSWORD=your-tenant-db-password
TENANT_DB_PREFIX=mycroshop_tenant_

# WhatsApp/Meta
META_APP_ID=your-meta-app-id
META_APP_SECRET=your-meta-app-secret
META_VERIFY_TOKEN=your-webhook-verify-token

# Encryption (for storing tokens)
ENCRYPTION_KEY=your-encryption-key
```

### 3. Deploy to Google Cloud

```bash
# Deploy all functions
gcloud functions deploy whatsappWebhook \
  --runtime nodejs20 \
  --trigger http \
  --allow-unauthenticated \
  --entry-point handleWebhook

gcloud functions deploy processMessage \
  --runtime nodejs20 \
  --trigger http \
  --allow-unauthenticated \
  --entry-point processMessage
```

## Usage

### Webhook Endpoint

Set this URL in Meta's WhatsApp webhook configuration:
```
https://your-region-your-project.cloudfunctions.net/whatsappWebhook
```

### Contact Management API

Manage contact counts and pricing tiers:
```
https://your-region-your-project.cloudfunctions.net/contactManagement
```

See `CONTACT_PRICING.md` for full API documentation.

### Message Flow

1. Customer sends message on WhatsApp
2. Meta sends webhook to Google Cloud Function
3. Function processes message with Gemini AI
4. AI queries inventory/orders/payments via MycroShop API
5. AI generates response
6. Function sends response back via WhatsApp

## Free vs Enterprise Users

### Free Users
- Connected to **online store inventory only**
- Products from `OnlineStore` and `OnlineStoreProduct`
- No physical stores
- Limited to online store products

### Enterprise Users
- Connected to **all physical stores inventory**
- Products from `Store`, `Product`, `ProductStore`
- Multiple store locations
- Full inventory across all stores

## API Integration

The AI agent communicates with MycroShop backend via REST API:

- `GET /api/v1/store/products?tenant_id={id}` - Get products
- `POST /api/v1/onlineStoreOrders` - Create order
- `GET /api/v1/payments/verify?reference={ref}` - Verify payment
- `PUT /api/v1/inventory/products/{id}/stock` - Update inventory

## Development

```bash
# Run locally
npm run dev

# Test webhook locally
npm run test:webhook

# Deploy
npm run deploy
```

## License

Proprietary - MycroShop Platform

