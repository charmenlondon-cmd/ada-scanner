# ADA Scanner - Google Cloud Run Deployment

Self-hosted ADA compliance scanner using Puppeteer + axe-core + Claude AI, deployed on Google Cloud Run.

**Repository:** https://github.com/charmenlondon-cmd/ada-scanner

## Files
- `server.js` - Express server with scan endpoint and AI analysis
- `package.json` - Dependencies (Express, Puppeteer, Anthropic SDK)
- `Dockerfile` - Container config for Cloud Run
- `.github/workflows/deploy.yml` - GitHub Actions for automatic deployment

## Deployment

**Automatic Deployment via GitHub Actions:**

This repository uses GitHub Actions to automatically deploy to Cloud Run on every push to the `main` branch.

1. Push code to the `main` branch
2. GitHub Actions automatically:
   - Builds Docker image
   - Pushes to Google Artifact Registry
   - Deploys to Cloud Run
3. Service is available at: `https://ada-scanner-310807655877.us-central1.run.app`

**Manual Deployment (if needed):**
```bash
gcloud run deploy ada-scanner \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 1 \
  --timeout 900 \
  --set-env-vars ANTHROPIC_API_KEY=your_key_here
```

## API Endpoint

**POST /api/scan**

Required fields:
- `website_url` - The website to scan
- `customer_id` - Customer identifier
- `scan_id` - Unique scan identifier
- `email` - Customer email
- `company_name` - Customer company name
- `plan` - Plan type: free (unpaid), guest ($25 one-time), essentials ($49/mo), professional ($99/mo)
- `max_pages` (optional) - Maximum pages to scan (default: 50)

**Request:**
```json
{
  "website_url": "https://example.com",
  "customer_id": "CUST_1234567890_ABC123",
  "scan_id": "SCAN_1234567890_XYZ789",
  "email": "test@example.com",
  "company_name": "Test Company",
  "plan": "starter",
  "max_pages": 10
}
```

**Response:**
```json
{
  "violations": [...],
  "complianceScore": 85,
  "total_violations": 12,
  "critical_count": 2,
  "serious_count": 3,
  "moderate_count": 5,
  "minor_count": 2,
  "pages_scanned": 8,
  "scanned_page_urls": ["https://example.com", "https://example.com/about", ...],
  "max_pages": 10,
  "scan_id": "SCAN_1234567890_XYZ789",
  "success": true,
  "customer_id": "CUST_1234567890_ABC123",
  "email": "test@example.com",
  "company_name": "Test Company",
  "website_url": "https://example.com",
  "plan": "starter",
  "scan_date": "2026-01-12T10:30:00.000Z",
  "scan_duration_seconds": 45,
  "status": "completed",
  "scanner_version": "axe-core + puppeteer + claude v2.0",
  "scan_method": "Self-hosted Puppeteer + axe-core + Claude AI",
  "ai_analysis": {...},
  "ai_level": "advanced"
}
```

## AI Analysis Levels

- **none** (free plan only): No AI analysis
- **basic** (guest plan - $25 one-time): Summary, priority fixes, plain-English explanations
- **advanced** (essentials $49/mo, professional $99/mo): Screenshot + HTML analysis for visual issues, content issues, reading level, heading structure

## Health Check
**GET /health**

Returns: `{"status": "ok", "service": "ada-scanner-cloud-run"}`

## Recent Updates

- **Jan 10, 2026**: Fixed multi-page scanning by using currentUrl for link extraction (handles www/non-www redirects)
- **Jan 2, 2026**: Migrated from Railway to Google Cloud Run
- **Dec 2025**: Added Claude AI integration for advanced accessibility analysis
