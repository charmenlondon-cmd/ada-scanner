# ADA Scanner - Railway Deployment

Self-hosted ADA compliance scanner using Puppeteer + axe-core on Railway.

## Files
- `server.js` - Express server with scan endpoint
- `package.json` - Dependencies (Express + Puppeteer)
- `Dockerfile` - Container config for Railway

## Deployment to Railway

1. Push this folder to GitHub repository
2. Create new project in Railway
3. Connect GitHub repository
4. Railway will auto-detect Dockerfile and deploy
5. Get the Railway URL (e.g., https://your-app.railway.app)
6. Update n8n workflow to use: `https://your-app.railway.app/api/scan`

## API Endpoint

**POST /api/scan**
```json
{
  "website_url": "https://example.com",
  "customer_id": "CUST001",
  "email": "test@example.com",
  "company_name": "Test Company",
  "plan": "starter"
}
```

**Response:**
```json
{
  "violations": [...],
  "complianceScore": 85,
  "total_violations": 12,
  "success": true
}
```

## Health Check
**GET /health**
Returns: `{"status": "ok"}`
