# Contact Count & Pricing Tiers

## Overview

The AI Sales Agent includes a contact counting system with pricing tiers based on the number of unique WhatsApp contacts a tenant can interact with.

## Pricing Tiers

| Tier | Contact Limit | Monthly Price |
|------|--------------|---------------|
| 1K   | 1,000        | Free          |
| 2K   | 2,000        | ₦29           |
| 3K   | 3,000        | ₦39           |
| 4K   | 4,000        | ₦49           |
| 5K   | 5,000        | ₦59           |
| 6K   | 6,000        | ₦69           |
| 7K   | 7,000        | ₦79           |
| 8K   | 8,000        | ₦89           |
| 9K   | 9,000        | ₦99           |
| 10K  | 10,000       | ₦109          |

## How It Works

### Contact Tracking

- **New Contact**: When a customer sends their first message, they're counted as a new contact
- **Existing Contact**: Subsequent messages from the same phone number don't increase the count
- **Automatic Tracking**: Contacts are tracked automatically in Firestore

### Limit Enforcement

- **New Contacts**: If limit is reached, new contacts cannot send messages
- **Existing Contacts**: Existing contacts can continue messaging even if limit is reached
- **Warning Thresholds**: 
  - 75% usage: Warning message
  - 90% usage: Strong upgrade recommendation
  - 100% usage: New contacts blocked

## Firestore Structure

### Collections

```
tenants/
  {tenantId}/
    conversations/
      {customerPhone}/
        messages/
          {messageId}/
            - role: 'user' | 'assistant'
            - message: string
            - messageId: string
            - timestamp: timestamp
    contacts/
      {customerPhone}/
        - tenantId: number
        - customerPhone: string
        - firstContactAt: timestamp
        - lastContactAt: timestamp
        - messageCount: number
    - tenantId: number
    - contactCount: number
    - contactLimit: number
    - updatedAt: timestamp
```

## API Endpoints

### Get Contact Count

```http
GET /contactManagement?tenant_id={id}&action=get_count
```

**Response:**
```json
{
  "success": true,
  "data": {
    "count": 850,
    "limit": 1000,
    "remaining": 150,
    "reached": false,
    "usagePercent": "85.00"
  }
}
```

### Get Contact Limit

```http
GET /contactManagement?tenant_id={id}&action=get_limit
```

**Response:**
```json
{
  "success": true,
  "data": {
    "limit": 1000,
    "tier": {
      "id": "1k",
      "name": "1K Contacts",
      "price": 0,
      "formattedPrice": "Free"
    }
  }
}
```

### Set Contact Limit (Upgrade/Downgrade)

```http
POST /contactManagement?tenant_id={id}
Content-Type: application/json

{
  "action": "set_limit",
  "tierId": "2k"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Contact limit updated successfully",
  "data": {
    "limit": 2000,
    "tier": {
      "id": "2k",
      "name": "2K Contacts",
      "price": 29,
      "formattedPrice": "₦29/month"
    }
  }
}
```

### Get All Tiers

```http
GET /contactManagement?action=get_tiers
```

**Response:**
```json
{
  "success": true,
  "data": {
    "tiers": [
      {
        "id": "1k",
        "name": "1K Contacts",
        "limit": 1000,
        "price": 0,
        "formattedPrice": "Free"
      },
      ...
    ]
  }
}
```

### Get Recommended Tier

```http
GET /contactManagement?tenant_id={id}&action=get_recommended_tier
```

**Response:**
```json
{
  "success": true,
  "data": {
    "currentCount": 850,
    "currentLimit": 1000,
    "recommendedTier": {
      "id": "1k",
      "name": "1K Contacts",
      "limit": 1000,
      "price": 0,
      "formattedPrice": "Free"
    },
    "nextTier": {
      "id": "2k",
      "name": "2K Contacts",
      "limit": 2000,
      "price": 29,
      "formattedPrice": "₦29/month"
    },
    "upgradeMessage": "📊 You've used 85% of your contact limit..."
  }
}
```

### Get Contacts List

```http
GET /contactManagement?tenant_id={id}&action=get_contacts&limit=100
```

**Response:**
```json
{
  "success": true,
  "data": {
    "contacts": [
      {
        "id": "+2348012345678",
        "customerPhone": "+2348012345678",
        "firstContactAt": "2026-01-15T10:00:00Z",
        "lastContactAt": "2026-01-20T15:30:00Z",
        "messageCount": 12
      },
      ...
    ],
    "count": 50
  }
}
```

## Integration with Message Processing

The contact limit is automatically checked when processing messages:

1. **New Contact Check**: If message is from a new contact and limit is reached, message is blocked
2. **Existing Contact**: Messages from existing contacts are always processed
3. **Automatic Tracking**: Contacts are tracked automatically when they send their first message

## Upgrade Flow

1. Tenant reaches 75% of contact limit → Warning message
2. Tenant reaches 90% of contact limit → Strong upgrade recommendation
3. Tenant reaches 100% → New contacts blocked
4. Tenant upgrades tier → Contact limit increased
5. New contacts can now send messages

## Deployment

The contact management function is deployed separately:

```bash
gcloud functions deploy contactManagement \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=contactManagement \
  --trigger-http \
  --allow-unauthenticated
```

## Monitoring

Monitor contact usage:
- Check Firestore for contact counts
- Set up alerts for 75%, 90%, and 100% usage
- Track upgrade conversions
- Monitor blocked messages

## Best Practices

1. **Proactive Communication**: Notify tenants before they reach limits
2. **Flexible Limits**: Allow temporary overages during peak periods
3. **Clear Pricing**: Display pricing tiers clearly in dashboard
4. **Easy Upgrades**: Make upgrade process seamless
5. **Usage Analytics**: Provide detailed usage reports

