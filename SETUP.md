# Setup Guide - AI Sales Agent

## Environment Variables

Create a `.env` file in the project root with the following variables:

```env
# Google Cloud
GOOGLE_CLOUD_PROJECT_ID=your-project-id
GOOGLE_CLOUD_REGION=us-central1

# Gemini AI
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.0-flash-exp

# MycroShop API
MYCROSHOP_API_URL=https://backend.mycroshop.com
MYCROSHOP_API_KEY=your-api-key

# Database - Main
MAIN_DB_HOST=your-db-host
MAIN_DB_USER=your-db-user
MAIN_DB_PASSWORD=your-db-password
MAIN_DB_NAME=mycroshop_main

# Database - Tenant
TENANT_DB_HOST=your-tenant-db-host
TENANT_DB_USER=your-tenant-db-user
TENANT_DB_PASSWORD=your-tenant-db-password
TENANT_DB_PREFIX=mycroshop_tenant_
SHARED_FREE_DB_NAME=mycroshop_free_shared

# Use direct database access (true) or API (false)
USE_DIRECT_DB=true

# WhatsApp/Meta
META_APP_ID=your-meta-app-id
META_APP_SECRET=your-meta-app-secret
META_VERIFY_TOKEN=your-webhook-verify-token

# Encryption
ENCRYPTION_KEY=your-encryption-key-32-chars

# Development
NODE_ENV=development
DEFAULT_TENANT_ID=1
```

## Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   - Copy environment variables above
   - Fill in your actual values

3. **Test Locally**
   ```bash
   npm run dev
   ```

4. **Deploy to Google Cloud**
   ```bash
   npm run deploy
   ```

## Database Setup

### Create WhatsApp Connections Table

In your main database (`mycroshop_main`), create a table to store WhatsApp connections:

```sql
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  phone_number_id VARCHAR(255) NOT NULL,
  waba_id VARCHAR(255),
  access_token TEXT NOT NULL,
  connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant_id (tenant_id),
  INDEX idx_phone_number_id (phone_number_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Firestore Setup

**Note:** Firestore is automatically available in Google Cloud Functions. No manual setup required!

### Firestore Structure

Firestore will automatically create the following structure:

```
tenants/
  {tenantId}/
    conversations/
      {customerPhone}/
        messages/
          {messageId}/
    contacts/
      {customerPhone}/
    - contactCount: number
    - contactLimit: number
```

### Enable Firestore

1. Go to Google Cloud Console
2. Navigate to Firestore
3. Create database (Native mode)
4. Select region (same as Cloud Functions)
5. Done! Firestore is ready to use

### Set Initial Contact Limits

For each tenant, set their initial contact limit based on their pricing tier:

```javascript
// Example: Set tenant 1 to 2K contacts tier
POST /contactManagement?tenant_id=1
{
  "action": "set_limit",
  "tierId": "2k"
}
```

## Testing

### Test Webhook Locally

Use ngrok to expose local server:

```bash
# Terminal 1: Start local server
npm run dev

# Terminal 2: Start ngrok
ngrok http 8080

# Use ngrok URL in Meta webhook configuration
```

### Test Message Processing

```bash
# Send test webhook
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=..." \
  -d '{
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
  }'
```

## Next Steps

1. Deploy to Google Cloud (see DEPLOYMENT.md)
2. Configure Meta webhook
3. Test with real WhatsApp messages
4. Monitor logs and performance
5. Set up alerts and monitoring

