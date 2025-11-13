import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

app.post('/api/scan', async (req, res) => {
  try {
    const { website_url, customer_id, email, company_name, plan } = req.body;

    if (!website_url) {
      return res.status(400).json({ success: false, error: 'website_url is required' });
    }

    const visited = new Set();
    const toVisit = new Set([website_url]);
    const violations = [];
    const startTime = Date.now();

    // Launch browser with Railway-optimized settings
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });

    async function getInternalLinks(page, baseUrl) {
      const anchors = await page.$$eval('a[href]', links =>
        links.map(link => link.href).filter(href => href.startsWith(baseUrl))
      );
      return anchors.map(url => url.split('#')[0]); // remove fragments
    }

    while (toVisit.size > 0 && visited.size < 50) {
      const currentUrl = Array.from(toVisit)[0];
      toVisit.delete(currentUrl);

      if (visited.has(currentUrl)) continue;

      try {
        const page = await browser.newPage();
        await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

        // Load axe-core from CDN
        await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.0/axe.min.js' });

        // Run axe-core scan
        const result = await page.evaluate(async () => {
          return await axe.run();
        });

        const scanDate = new Date().toISOString();

        // Extract violations
        result.violations.forEach((v, i) => {
          violations.push({
            violation_id: `VIO_${Date.now()}_${i}`,
            scan_id: `SCAN_${Date.now()}`,
            customer_id,
            page_url: currentUrl,
            rule_id: v.id,
            impact: v.impact || "unknown",
            description: v.description,
            element_selector: v.nodes[0]?.target?.[0] || "N/A",
            help_url: v.helpUrl,
            fixed_status: "open",
            detected_date: scanDate,
            fixed_date: null
          });
        });

        // Get internal links for crawling
        const internalLinks = await getInternalLinks(page, website_url);
        internalLinks.forEach(link => {
          if (!visited.has(link)) toVisit.add(link);
        });

        visited.add(currentUrl);
        await page.close();

      } catch (error) {
        console.error(`Error scanning ${currentUrl}:`, error.message);
      }
    }

    await browser.close();

    const scanDuration = Math.round((Date.now() - startTime) / 1000);
    const complianceScore = Math.max(0, 100 - violations.length * 5);

    return res.status(200).json({
      violations,
      complianceScore,
      total_violations: violations.length,
      critical_count: violations.filter(v => v.impact === "critical").length,
      serious_count: violations.filter(v => v.impact === "serious").length,
      moderate_count: violations.filter(v => v.impact === "moderate").length,
      minor_count: violations.filter(v => v.impact === "minor").length,
      scan_id: `SCAN_${Date.now()}`,
      success: true,
      customer_id,
      email,
      company_name,
      website_url,
      plan,
      scan_date: new Date().toISOString(),
      scan_duration_seconds: scanDuration,
      status: "completed",
      scanner_version: "axe-core + puppeteer v1.0 (Railway)",
      scan_method: "Self-hosted Puppeteer + axe-core"
    });

  } catch (error) {
    console.error('Scan error:', error);
    return res.status(500).json({
      violations: [],
      complianceScore: 0,
      total_violations: 0,
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'ada-scanner-railway' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ADA Scanner running on port ${PORT}`);
});
