import express from 'express';
import puppeteer from 'puppeteer';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// AI Analysis prompts
const BASIC_AI_PROMPT = `Analyze these accessibility violations and provide a JSON response with:
1. "summary": A 2-3 sentence summary of the main accessibility issues found
2. "priority_fixes": Array of top 3 priority fixes, each with:
   - "issue": Brief description
   - "impact": "critical", "serious", "moderate", or "minor"
   - "explanation": Plain-English explanation (no jargon) of why this matters
   - "fix": Simple explanation of how to fix it
3. "estimated_fix_time": Total estimated time to fix critical and serious issues

Keep explanations simple and actionable. Focus on the most impactful issues first.`;

const ADVANCED_AI_PROMPT = `Analyze this webpage for accessibility issues that automated testing cannot detect.

You have:
1. A screenshot of the page
2. The page's HTML content
3. Violations already found by axe-core automated testing

Analyze for these WCAG requirements that axe-core CANNOT detect:

VISUAL ANALYSIS (from screenshot):
- Touch target sizes (must be minimum 44x44 pixels for mobile)
- Text readability over backgrounds (beyond just contrast ratio)
- Visual hierarchy and focus indicator visibility
- Images containing text that should be real text
- Content spacing and layout issues

CONTENT ANALYSIS (from HTML):
- Reading level (target Grade 8 for general audiences)
- Link text clarity (flag "click here", "read more", "learn more" without context)
- Heading structure logic (H1→H2→H3 should be hierarchical, not skip levels)
- Form label clarity and helpfulness
- Error message quality
- Instructions that rely on sensory characteristics ("click the red button")

VIOLATION REVIEW:
- Prioritize the axe-core violations by real-world impact
- Provide specific code fixes where possible

Return a JSON object with:
{
  "summary": "2-3 sentence overview of accessibility state",
  "visual_issues": [
    {
      "type": "touch_target|text_in_image|focus_indicator|readability|layout",
      "description": "What the issue is",
      "location": "Where on the page (be specific)",
      "wcag_criterion": "e.g., 2.5.5 Target Size",
      "recommendation": "How to fix it"
    }
  ],
  "content_issues": [
    {
      "type": "reading_level|link_text|heading_structure|form_labels|error_messages|sensory_instructions",
      "description": "What the issue is",
      "examples": ["specific examples from the page"],
      "wcag_criterion": "e.g., 3.1.5 Reading Level",
      "recommendation": "How to fix it"
    }
  ],
  "priority_fixes": [
    {
      "rank": 1,
      "issue": "Brief description",
      "impact": "critical|serious|moderate|minor",
      "explanation": "Why this matters for users",
      "fix": "Specific fix with code example if applicable",
      "estimated_time": "e.g., 30 minutes"
    }
  ],
  "reading_level": {
    "current": "e.g., Grade 12",
    "target": "Grade 8",
    "recommendation": "Specific suggestions to simplify"
  },
  "estimated_fix_time": "Total time for all critical and serious issues"
}

Be specific, actionable, and focus on real accessibility impact. Don't flag issues that aren't actually problems.`;

// Function to run Basic AI analysis
async function runBasicAIAnalysis(violations) {
  try {
    const violationSummary = violations.map(v => ({
      rule: v.rule_id,
      impact: v.impact,
      description: v.description,
      page: v.page_url
    }));

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${BASIC_AI_PROMPT}\n\nViolations found:\n${JSON.stringify(violationSummary, null, 2)}`
        }
      ]
    });

    const responseText = message.content[0].text;
    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { summary: responseText, priority_fixes: [], estimated_fix_time: "Unable to estimate" };
  } catch (error) {
    console.error('Basic AI analysis error:', error.message);
    return null;
  }
}

// Function to run Advanced AI analysis
async function runAdvancedAIAnalysis(screenshot, htmlContent, violations) {
  try {
    const violationSummary = violations.map(v => ({
      rule: v.rule_id,
      impact: v.impact,
      description: v.description,
      element: v.element_selector,
      page: v.page_url
    }));

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshot
              }
            },
            {
              type: "text",
              text: `${ADVANCED_AI_PROMPT}\n\nHTML Content (truncated to key elements):\n${htmlContent.substring(0, 8000)}\n\nAxe-core violations found:\n${JSON.stringify(violationSummary, null, 2)}`
            }
          ]
        }
      ]
    });

    const responseText = message.content[0].text;
    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { summary: responseText, visual_issues: [], content_issues: [], priority_fixes: [] };
  } catch (error) {
    console.error('Advanced AI analysis error:', error.message);
    return null;
  }
}

app.post('/api/scan', async (req, res) => {
  try {
    const { website_url, customer_id, scan_id, email, company_name, plan, max_pages } = req.body;

    if (!website_url) {
      return res.status(400).json({ success: false, error: 'website_url is required' });
    }

    if (!scan_id) {
      return res.status(400).json({ success: false, error: 'scan_id is required' });
    }

    // Set page limit - default to 50, but allow override (e.g., 3 for free tier)
    const pageLimit = max_pages && max_pages > 0 ? Math.min(max_pages, 50) : 50;

    // Determine AI analysis level based on plan
    const aiLevel = plan === 'free' ? 'none' :
                    plan === 'guest' ? 'basic' : 'advanced'; // starter and professional get advanced

    const visited = new Set();
    const toVisit = new Set([website_url]);
    const violations = [];
    const startTime = Date.now();

    // For advanced AI: capture screenshot and HTML of homepage
    let homepageScreenshot = null;
    let homepageHtml = null;

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
      const anchors = await page.$$eval('a[href]', (links, base) =>
        links.map(link => link.href).filter(href => href.startsWith(base))
      , baseUrl);
      return anchors.map(url => url.split('#')[0]); // remove fragments
    }

    while (toVisit.size > 0 && visited.size < pageLimit) {
      const currentUrl = Array.from(toVisit)[0];
      toVisit.delete(currentUrl);

      if (visited.has(currentUrl)) continue;

      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

        // Capture screenshot and HTML for homepage (first page) if advanced AI
        if (visited.size === 0 && aiLevel === 'advanced') {
          homepageScreenshot = await page.screenshot({
            encoding: 'base64',
            fullPage: false // Just viewport for faster processing
          });
          homepageHtml = await page.content();
        }

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
            violation_id: `VIO_${scan_id.replace('SCAN_', '')}_${violations.length}`,
            scan_id: scan_id,
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

    // Run AI analysis based on plan
    let ai_analysis = null;

    if (aiLevel === 'basic' && violations.length > 0) {
      console.log('Running basic AI analysis...');
      ai_analysis = await runBasicAIAnalysis(violations);
    } else if (aiLevel === 'advanced') {
      console.log('Running advanced AI analysis...');
      if (homepageScreenshot && homepageHtml) {
        ai_analysis = await runAdvancedAIAnalysis(homepageScreenshot, homepageHtml, violations);
      } else if (violations.length > 0) {
        // Fallback to basic if screenshot capture failed
        ai_analysis = await runBasicAIAnalysis(violations);
      }
    }

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
      pages_scanned: visited.size,
      max_pages: pageLimit,
      scan_id: scan_id,
      success: true,
      customer_id,
      email,
      company_name,
      website_url,
      plan,
      scan_date: new Date().toISOString(),
      scan_duration_seconds: scanDuration,
      status: "completed",
      scanner_version: "axe-core + puppeteer + claude v2.0 (Railway)",
      scan_method: "Self-hosted Puppeteer + axe-core + Claude AI",
      ai_analysis,
      ai_level: aiLevel
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
