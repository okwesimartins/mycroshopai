# AI Sales Agent - Project Summary

## Overview

A complete AI-powered sales assistant that integrates WhatsApp Business API with Google Gemini AI to provide automated customer service, order processing, inventory management, and payment confirmation for the MycroShop platform.

## Key Features

✅ **AI-Powered Conversations**: Uses Google Gemini 2.0 Flash (latest version)  
✅ **WhatsApp Integration**: Full WhatsApp Business API integration  
✅ **Multi-Tenant Support**: Works for both free and enterprise users  
✅ **Inventory Management**: Queries and updates inventory in real-time  
✅ **Order Processing**: Creates orders from customer conversations  
✅ **Payment Confirmation**: Verifies and confirms payments  
✅ **Smart Routing**: Free users see online store only, enterprise see all stores  

## Architecture

```
WhatsApp Customer
    ↓
Meta WhatsApp Business API (Webhook)
    ↓
Google Cloud Function (whatsapp-webhook)
    ↓
Google Cloud Function (process-message)
    ↓
Gemini AI (Processes message)
    ↓
MycroShop API / Database (Query inventory, create orders)
    ↓
WhatsApp API (Send response)
```

## Project Structure

```
ai-sales-agent/
├── functions/
│   ├── whatsapp-webhook/     # Receives webhooks from Meta
│   └── process-message/      # Processes messages with AI
├── lib/
│   ├── gemini.js             # Gemini AI integration
│   ├── whatsapp.js           # WhatsApp API client
│   ├── database.js            # Database connection (free/enterprise)
│   ├── inventory.js           # Inventory management
│   ├── orders.js              # Order processing
│   └── payments.js           # Payment confirmation
├── config/
│   └── config.js              # Configuration management
├── README.md                   # Project overview
├── ARCHITECTURE.md             # Detailed architecture
├── DEPLOYMENT.md               # Deployment guide
└── SETUP.md                    # Setup instructions
```

## Free vs Enterprise Users

### Free Users
- **Inventory Source**: Online store products only
- **Database**: Shared database (`mycroshop_free_shared`)
- **Query**: `online_store_products` table filtered by `tenant_id`
- **Limitations**: No physical stores, online store only

### Enterprise Users
- **Inventory Source**: All physical stores
- **Database**: Separate database per tenant (`mycroshop_tenant_{id}`)
- **Query**: `products`, `product_stores`, `stores` tables
- **Features**: Multiple store locations, full inventory access

## Core Functionality

### 1. Message Processing
- Receives WhatsApp messages via webhook
- Processes with Gemini AI
- Extracts intents (order, query, payment check)
- Generates contextual responses

### 2. Inventory Queries
- Searches products by name/category
- Checks availability and stock levels
- Formats product lists for customers
- Handles both free and enterprise users

### 3. Order Processing
- Extracts order details from conversation
- Validates product availability
- Creates orders via MycroShop API
- Generates payment links
- Sends confirmation messages

### 4. Payment Confirmation
- Verifies payment by reference
- Checks payment status
- Confirms orders after payment
- Updates inventory automatically

### 5. Inventory Updates
- Deducts stock after order confirmation
- Updates both online store and physical store inventory
- Handles multi-store scenarios for enterprise users

## Technology Stack

- **Runtime**: Node.js 20
- **Platform**: Google Cloud Functions (Gen2)
- **AI**: Google Gemini 2.0 Flash
- **Database**: MySQL (via mysql2)
- **API Client**: Axios
- **Messaging**: WhatsApp Business API

## Security

- Webhook signature verification
- Encrypted access token storage
- API key authentication
- Rate limiting (via Cloud Functions)
- Secure database connections

## Deployment

Deployed as serverless Google Cloud Functions:
- Auto-scaling
- Pay-per-invocation
- High availability
- Automatic HTTPS
- Built-in monitoring

## Next Steps

1. **Set up environment variables** (see SETUP.md)
2. **Create database tables** (see SETUP.md)
3. **Deploy to Google Cloud** (see DEPLOYMENT.md)
4. **Configure Meta webhook**
5. **Test with real messages**
6. **Monitor and optimize**

## Support

For issues or questions:
- Check logs: `gcloud functions logs read`
- Review architecture: `ARCHITECTURE.md`
- Deployment guide: `DEPLOYMENT.md`

---

**Status**: ✅ Complete and ready for deployment

