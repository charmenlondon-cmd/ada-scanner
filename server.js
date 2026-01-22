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

const OPTIMIZED_ADVANCED_AI_PROMPT = `Analyze this webpage for accessibility issues that AUTOMATED TESTING CANNOT DETECT.

You have:
1. A screenshot of the page
2. Complete structured accessibility data extracted from the HTML

IMPORTANT: This website has already been scanned with axe-core automated testing tool. Axe-core has ALREADY checked and reported on the following issues (DO NOT re-analyze these):

AUTOMATED CHECKS ALREADY COMPLETED BY AXE-CORE:
✓ Link text (links without discernible text, empty links)
✓ Image alt text (missing alt attributes, empty alt text)
✓ Color contrast ratios (text vs background contrast, WCAG AA/AAA compliance)
✓ Form labels (inputs without labels, missing label associations)
✓ Button names (buttons without accessible names)
✓ ARIA attributes (invalid ARIA roles, missing ARIA labels, incorrect ARIA usage)
✓ Page structure (missing <main> landmark, missing h1, duplicate IDs)
✓ Heading hierarchy (skipped heading levels, multiple h1s)
✓ Landmark regions (content not in landmarks, missing navigation landmarks)
✓ HTML lang attribute (missing or invalid lang declarations)
✓ Keyboard accessibility (skip links, focusable elements)
✓ Document title (missing or empty <title> tags)
✓ Table structure (missing table headers, invalid table markup)
✓ List structure (improper list markup)

DO NOT analyze any of the above issues. Axe-core has already detected and reported them.

FOCUS ONLY ON THESE ISSUES (which automated tools CANNOT detect):

1. VISUAL ANALYSIS (from screenshot only):
   - Touch target sizes: Are interactive elements at least 44x44 pixels? Measure visible buttons, links, and icons in the screenshot
   - Focus indicators: Are keyboard focus outlines visible and meet 3:1 contrast? Can you see them in the screenshot?
   - Text in images: Is there text that's part of an image file instead of real HTML text?
   - Visual layout: Is content overlapping, spacing inadequate, or layout confusing?

2. CONTENT QUALITY ANALYSIS (from structured data):
   - Reading level: Analyze textContent field. Calculate Flesch-Kincaid grade level. Target is Grade 8 for general audiences.
   - Placeholder-only labels: Check formElements where hasPlaceholderOnly=true (placeholders disappear on focus, violating WCAG)
   - Generic link text: Check interactiveElements where isGeneric=true ("click here", "read more" without context)
   - Error message quality: Check errorElements - are messages helpful and actionable? Do they explain HOW to fix the error?
   - Sensory instructions: Check sensoryInstructions array for text relying only on color/position (e.g., "click the red button", "item on the right")

CRITICAL RULES:
- If axe-core would detect it, DO NOT mention it
- Be specific to THIS page - use exact locations and examples from the data provided
- Only flag REAL problems that affect users - not theoretical issues
- Provide actionable fixes with code examples

Return ONLY valid JSON (no markdown, no code fences, no text before or after):
{
  "summary": "1-2 sentence overview of issues that automated testing missed (not issues axe-core found)",
  "visual_issues": [
    {
      "type": "touch_target|focus_indicator|text_in_image|layout",
      "description": "Specific issue with exact location from screenshot",
      "location": "Precise location (e.g., 'Top navigation phone number link at coordinates X,Y')",
      "wcag_criterion": "Full criterion (e.g., 2.5.5 Target Size - Level AAA)",
      "recommendation": "Specific fix with CSS example: button { min-width: 44px; min-height: 44px; }"
    }
  ],
  "content_issues": [
    {
      "type": "reading_level|placeholder_labels|generic_links|error_messages|sensory_instructions",
      "description": "Specific issue",
      "examples": ["Exact quotes from textContent or formElements data"],
      "wcag_criterion": "Full criterion (e.g., 3.1.5 Reading Level - Level AAA)",
      "recommendation": "Before/after example showing simplified text"
    }
  ],
  "reading_level": {
    "current": "Grade X (calculated from textContent using Flesch-Kincaid or similar)",
    "target": "Grade 8",
    "recommendation": "Specific examples: 'Change \\"initiated\\" to \\"started\\", \\"utilize\\" to \\"use\\"'"
  }
}

REMEMBER: Do not duplicate what axe-core already found. Focus only on visual inspection and semantic content quality that requires human judgment.`;

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
      model: "claude-sonnet-4-5-20250929",
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
    console.error('Full error details:', {
      type: error.type,
      status: error.status,
      message: error.message,
      error: error.error
    });
    return null;
  }
}

// Function to run Advanced AI analysis
async function runAdvancedAIAnalysis(screenshot, accessibilityData) {
  try {
    const formattedData = `
COMPLETE PAGE TEXT (for reading level analysis):
${accessibilityData.textContent}

STATISTICS:
- Total forms: ${accessibilityData.stats.totalForms}
- Total buttons: ${accessibilityData.stats.totalButtons}
- Total links: ${accessibilityData.stats.totalLinks}
- Inputs with placeholder-only labels: ${accessibilityData.stats.hasPlaceholderOnlyInputs}

FORM ELEMENTS (ALL ${accessibilityData.formElements.length} inputs captured):
${JSON.stringify(accessibilityData.formElements, null, 2)}

INTERACTIVE ELEMENTS (first 50 of ${accessibilityData.interactiveElements.length}):
${JSON.stringify(accessibilityData.interactiveElements.slice(0, 50), null, 2)}

ERROR/VALIDATION ELEMENTS:
${JSON.stringify(accessibilityData.errorElements, null, 2)}

POTENTIAL SENSORY INSTRUCTIONS:
${JSON.stringify(accessibilityData.sensoryInstructions, null, 2)}
`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1536,
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
              text: `${OPTIMIZED_ADVANCED_AI_PROMPT}\n\n${formattedData}`
            }
          ]
        }
      ]
    });

    const responseText = message.content[0].text;

    // Extract JSON from response (handle markdown code fences)
    let jsonText = responseText;

    if (jsonText.includes('```json')) {
      const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonText = jsonMatch[1];
      }
    } else if (jsonText.includes('```')) {
      const codeMatch = jsonText.match(/```\s*([\s\S]*?)\s*```/);
      if (codeMatch) {
        jsonText = codeMatch[1];
      }
    }

    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error('JSON parse error:', parseError.message);
        console.error('Attempted to parse:', jsonMatch[0].substring(0, 500));
        return {
          summary: 'AI analysis generated but could not be parsed. Please contact support.',
          visual_issues: [],
          content_issues: [],
          _parseError: parseError.message
        };
      }
    }
    return { summary: responseText, visual_issues: [], content_issues: [] };
  } catch (error) {
    console.error('Advanced AI analysis error:', error.message);
    console.error('Full error details:', {
      type: error.type,
      status: error.status,
      message: error.message,
      error: error.error
    });
    return null;
  }
}

// Extract structured accessibility data from page for AI analysis
async function extractAccessibilityData(page) {
  const data = await page.evaluate(() => {
    // 1. Extract ALL text content for reading level analysis
    const allText = document.body.innerText || document.body.textContent;

    // 2. Extract ALL form elements (inputs, textareas, selects)
    const formElements = Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
      type: el.type || el.tagName.toLowerCase(),
      placeholder: el.placeholder || null,
      label: el.labels?.[0]?.textContent || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      ariaLabelledby: el.getAttribute('aria-labelledby') || null,
      name: el.name || null,
      required: el.required || false,
      hasPlaceholderOnly: !!(el.placeholder && !el.labels?.length && !el.getAttribute('aria-label'))
    }));

    // 3. Extract ALL buttons and links (for context analysis)
    const interactiveElements = Array.from(document.querySelectorAll('button, a[href]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      text: el.textContent?.trim() || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      href: el.href || null,
      isGeneric: ['click here', 'read more', 'learn more', 'click', 'here'].includes(
        el.textContent?.trim().toLowerCase()
      )
    }));

    // 4. Extract ALL error/validation messages
    const errorElements = Array.from(document.querySelectorAll(
      '[role="alert"], [aria-invalid="true"], .error, .error-message, [aria-live="polite"], [aria-live="assertive"]'
    )).map(el => ({
      role: el.getAttribute('role'),
      text: el.textContent?.trim(),
      ariaLive: el.getAttribute('aria-live')
    }));

    // 5. Extract heading structure (for semantic analysis)
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(el => ({
      level: parseInt(el.tagName[1]),
      text: el.textContent?.trim()
    }));

    // 6. Check for sensory-dependent instructions in visible text
    const textNodes = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (text && /\b(red|green|blue|left|right|above|below|top|bottom)\s+(button|link|icon|item)/i.test(text)) {
        textNodes.push(text);
      }
    }

    return {
      textContent: allText.substring(0, 10000),
      formElements: formElements,
      interactiveElements: interactiveElements.slice(0, 100),
      errorElements: errorElements,
      headings: headings,
      sensoryInstructions: textNodes,
      stats: {
        totalForms: formElements.length,
        totalButtons: interactiveElements.filter(el => el.tag === 'button').length,
        totalLinks: interactiveElements.filter(el => el.tag === 'a').length,
        totalHeadings: headings.length,
        hasPlaceholderOnlyInputs: formElements.filter(el => el.hasPlaceholderOnly).length
      }
    };
  });

  return data;
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

    // For advanced AI: capture screenshot and structured data of homepage
    let homepageScreenshot = null;
    let homepageData = null;

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
      // Extract base domain and normalize (remove www for comparison)
      const url = new URL(baseUrl);
      const baseHostname = url.hostname.replace(/^www\./, ''); // Remove www for comparison

      const anchors = await page.$$eval('a[href]', (links, baseHost) => {
        return links
          .map(link => link.href)
          .filter(href => {
            try {
              const linkUrl = new URL(href);
              // Compare hostnames without www (handles www.site.com vs site.com)
              const linkHostname = linkUrl.hostname.replace(/^www\./, '');
              return linkHostname === baseHost;
            } catch {
              return false; // Invalid URL
            }
          });
      }, baseHostname);

      return anchors.map(url => url.split('#')[0]); // remove fragments
    }

    while (toVisit.size > 0 && visited.size < pageLimit) {
      const currentUrl = Array.from(toVisit)[0];
      toVisit.delete(currentUrl);

      if (visited.has(currentUrl)) continue;

      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(currentUrl, { waitUntil: "networkidle2", timeout: 30000 });

        // Capture screenshot and extract structured data for homepage (first page) if advanced AI
        if (visited.size === 0 && aiLevel === 'advanced') {
          homepageScreenshot = await page.screenshot({
            encoding: 'base64',
            fullPage: false
          });
          homepageData = await extractAccessibilityData(page);
          console.log('[EXTRACTION] Stats:', homepageData.stats);
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

        // Get internal links for crawling (use currentUrl to handle redirects properly)
        const internalLinks = await getInternalLinks(page, currentUrl);

        // Debug logging for troubleshooting
        console.log(`[SCAN] Visited: ${currentUrl}`);
        console.log(`[SCAN] Found ${internalLinks.length} internal links`);
        console.log(`[SCAN] Sample links:`, internalLinks.slice(0, 3));
        console.log(`[SCAN] Progress: ${visited.size}/${pageLimit} pages, ${toVisit.size} queued`);

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

    console.log(`[AI] aiLevel: ${aiLevel}, violations: ${violations.length}, screenshot: ${!!homepageScreenshot}, data: ${!!homepageData}`);

    if (aiLevel === 'basic' && violations.length > 0) {
      console.log('[AI] Running basic AI analysis...');
      ai_analysis = await runBasicAIAnalysis(violations);
      console.log('[AI] Basic AI result:', ai_analysis ? 'success' : 'null');
    } else if (aiLevel === 'advanced') {
      console.log('[AI] Running advanced AI analysis...');
      if (homepageScreenshot && homepageData) {
        console.log('[AI] Using advanced AI with screenshot and structured data');
        ai_analysis = await runAdvancedAIAnalysis(homepageScreenshot, homepageData);
        console.log('[AI] Advanced AI result:', ai_analysis ? 'success' : 'null');
      } else if (violations.length > 0) {
        // Fallback to basic if screenshot capture failed
        console.log('[AI] Screenshot missing, falling back to basic AI');
        ai_analysis = await runBasicAIAnalysis(violations);
        console.log('[AI] Basic AI fallback result:', ai_analysis ? 'success' : 'null');
      } else {
        console.log('[AI] No violations and no screenshot, skipping AI analysis');
      }
    }

    const scanDuration = Math.round((Date.now() - startTime) / 1000);

    // Check if any pages were actually scanned
    if (visited.size === 0) {
      return res.status(400).json({
        success: false,
        error: 'Unable to access website',
        error_details: 'The website could not be reached. Please check that the URL is correct and the website is accessible. Common issues: invalid domain, website is down, or website blocks automated scanning.',
        website_url,
        pages_scanned: 0,
        scan_id,
        customer_id,
        email,
        company_name,
        plan
      });
    }

    const complianceScore = Math.max(0, 100 - violations.length * 5);

    // Convert visited Set to comma-separated string for Google Sheets storage
    // This prevents JSON.stringify issues when writing to sheets
    const scannedPageUrls = Array.from(visited).join(',');

    return res.status(200).json({
      violations,
      complianceScore,
      total_violations: violations.length,
      critical_count: violations.filter(v => v.impact === "critical").length,
      serious_count: violations.filter(v => v.impact === "serious").length,
      moderate_count: violations.filter(v => v.impact === "moderate").length,
      minor_count: violations.filter(v => v.impact === "minor").length,
      pages_scanned: visited.size,
      scanned_page_urls: scannedPageUrls,
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
      scanner_version: "axe-core 4.10.0 + puppeteer + Claude Sonnet 4.5 (Cloud Run)",
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
  res.status(200).json({ status: 'ok', service: 'ada-scanner-cloud-run' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ADA Scanner running on port ${PORT}`);
});
