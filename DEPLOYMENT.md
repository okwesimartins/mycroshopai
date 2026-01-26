# Deployment Guide - AI Sales Agent

## Prerequisites

1. Google Cloud Account with billing enabled
2. Google Cloud Project created
3. Gemini API key
4. MycroShop API access
5. Meta WhatsApp Business API access

## Step 1: Set Up Google Cloud Project

```bash
# Install Google Cloud SDK
# https://cloud.google.com/sdk/docs/install

# Login to Google Cloud
gcloud auth login

# Set project
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

## Step 2: Configure Environment Variables

1. Create `.env` file from `.env.example`
2. Fill in all required values
3. For production, use Google Secret Manager:

```bash
# Create secrets
gcloud secrets create gemini-api-key --data-file=- <<< "your-api-key"
gcloud secrets create meta-app-secret --data-file=- <<< "your-secret"
gcloud secrets create db-password --data-file=- <<< "your-password"
```

## Step 3: Deploy Functions

### Deploy Follow-Up Scheduler

First, deploy the follow-up scheduler function:

```bash
gcloud functions deploy followUpScheduler \
  --runtime nodejs18 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point followUpScheduler \
  --region us-central1 \
  --set-env-vars META_APP_SECRET=your-secret,GEMINI_API_KEY=your-key,MYCROSHOP_API_URL=https://backend.mycroshop.com
```

**Create Cloud Scheduler Job** (runs every hour):
```bash
gcloud scheduler jobs create http follow-up-scheduler \
  --location=us-central1 \
  --schedule="0 * * * *" \
  --uri="https://us-central1-PROJECT.cloudfunctions.net/followUpScheduler" \
  --http-method=POST \
  --oidc-service-account-email=PROJECT@appspot.gserviceaccount.com
```

### Deploy WhatsApp Webhook Handler

```bash
gcloud functions deploy whatsappWebhook \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=whatsappWebhook \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars="META_VERIFY_TOKEN=your-token,META_APP_SECRET=your-secret" \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest,MAIN_DB_PASSWORD=db-password:latest"
```

### Deploy Message Processor

```bash
gcloud functions deploy processMessage \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=processMessage \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars="MYCROSHOP_API_URL=https://backend.mycroshop.com" \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest"
```

### Deploy Contact Management

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

**Note:** Firestore is automatically available in Cloud Functions - no additional setup needed.

## Step 4: Configure Meta Webhook

1. Go to Meta App Dashboard
2. Navigate to WhatsApp → Configuration → Webhooks
3. Add webhook URL: `https://us-central1-YOUR_PROJECT.cloudfunctions.net/whatsappWebhook`
4. Set verify token (same as `META_VERIFY_TOKEN`)
5. Subscribe to: `messages`, `message_status`

## Step 5: Test Deployment

```bash
# Test webhook verification
curl "https://us-central1-YOUR_PROJECT.cloudfunctions.net/whatsappWebhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"

# Should return: test
```

## Step 6: Monitor

```bash
# View logs
gcloud functions logs read whatsappWebhook --limit 50

# View logs for message processor
gcloud functions logs read processMessage --limit 50
```

## Production Checklist

- [ ] Environment variables configured
- [ ] Secrets stored in Secret Manager
- [ ] Functions deployed
- [ ] Webhook configured in Meta
- [ ] Database connections tested
- [ ] API keys validated
- [ ] Monitoring set up
- [ ] Error alerts configured
- [ ] Rate limiting configured
- [ ] Backup strategy in place

## Troubleshooting

### Function not receiving webhooks
- Check webhook URL is correct
- Verify webhook token matches
- Check function logs for errors

### AI not responding
- Verify Gemini API key
- Check function logs
- Ensure message processor is triggered

### Database connection errors
- Verify database credentials
- Check network connectivity
- Ensure IP whitelist includes Cloud Functions

## Cost Optimization

- Use Cloud Functions Gen2 (pay per invocation)
- Set appropriate memory limits
- Use connection pooling
- Cache frequently accessed data
- Batch operations when possible

