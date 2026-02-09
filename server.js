import express from 'express';
import puppeteer from 'puppeteer';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

// Load axe-core script from node_modules for injection into pages
const require = createRequire(import.meta.url);
const axeCorePath = require.resolve('axe-core/axe.min.js');
const axeCoreScript = readFileSync(axeCorePath, 'utf-8');

const app = express();
app.use(express.json());

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// AI Prompts - Concise but complete versions
const VIOLATION_EXPLANATION_PROMPT = `Explain this accessibility violation to a non-technical website owner:

Rule: {rule_id}
Impact: {impact}
Description: {description}
Affected element: {html_snippet}
Selector: {target}

Return JSON only:
{
  "explanation": "What this means in plain English",
  "impact_on_users": "How this affects people with disabilities",
  "fix_steps": "Numbered steps to fix this specific element",
  "code_before": "Current problematic code",
  "code_after": "Corrected code",
  "estimated_time": "realistic time estimate"
}

Be specific to THIS element. Include actual values (colors, sizes, text) from the HTML provided.`;

const PAGE_ANALYSIS_PROMPT = `Analyze this screenshot and structured data for accessibility issues that automated tools cannot detect.

Automated testing already checked: links, images, contrast, forms, ARIA, headings, landmarks, keyboard access, page structure.

You must check ONLY:
1. Visual (screenshot): Touch targets <44px, focus indicators, text-in-images, layout issues
2. Content (data): Reading level >Grade 8, placeholder-only labels, generic link text, unclear error messages, sensory-dependent instructions

Use provided data: textContent (reading level), formElements.hasPlaceholderOnly, interactiveElements.isGeneric, errorElements, sensoryInstructions.

Return JSON only:
{
  "summary": "1-2 sentence overview",
  "visual_issues": [{"type": "touch_target|focus_indicator|text_in_image|layout", "description": "specific issue with location", "wcag": "criterion", "fix": "code example"}],
  "content_issues": [{"type": "reading_level|placeholder|generic_links|error_messages|sensory", "examples": ["exact quotes"], "wcag": "criterion", "fix": "before/after"}],
  "priority_fixes": [{"rank": 1, "issue": "brief", "impact": "critical|serious|moderate|minor", "fix": "specific solution", "time": "estimate"}]
}

Be specific. Use exact locations and values from the data.`;

// Function to explain violations using AI
async function explainViolations(violations) {
  if (!violations || violations.length === 0) return [];

  try {
    // Group violations by rule_id to reduce API calls
    const violationsByRule = {};
    violations.forEach(v => {
      if (!violationsByRule[v.rule_id]) {
        violationsByRule[v.rule_id] = [];
      }
      violationsByRule[v.rule_id].push(v);
    });

    console.log(`[AI EXPLAIN] Processing ${Object.keys(violationsByRule).length} violation types`);

    // Process each violation type with AI
    const explanationPromises = Object.entries(violationsByRule).map(async ([ruleId, ruleViolations]) => {
      try {
        const firstViolation = ruleViolations[0];

        // Build prompt with specific violation data
        const prompt = VIOLATION_EXPLANATION_PROMPT
          .replace('{rule_id}', firstViolation.rule_id)
          .replace('{impact}', firstViolation.impact)
          .replace('{description}', firstViolation.description)
          .replace('{html_snippet}', 'Element at selector: ' + firstViolation.element_selector)
          .replace('{target}', firstViolation.element_selector);

        const message = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: prompt
          }]
        });

        const responseText = message.content[0].text;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          const explanation = JSON.parse(jsonMatch[0]);
          return { ruleId, explanation };
        }

        return { ruleId, explanation: null };
      } catch (error) {
        console.error(`[AI EXPLAIN] Error explaining ${ruleId}:`, error.message);
        return { ruleId, explanation: null };
      }
    });

    // Wait for all explanations with staggered delays to avoid rate limits
    const explanations = [];
    for (let i = 0; i < explanationPromises.length; i++) {
      if (i > 0) {
        // Add 500ms delay between API calls to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      explanations.push(await explanationPromises[i]);
    }

    // Map explanations back to violations
    const explanationMap = {};
    explanations.forEach(({ ruleId, explanation }) => {
      if (explanation) {
        explanationMap[ruleId] = explanation;
      }
    });

    // Add explanations to each violation
    return violations.map(v => ({
      ...v,
      ai_explanation: explanationMap[v.rule_id] || null
    }));

  } catch (error) {
    console.error('[AI EXPLAIN] Fatal error:', error);
    return violations; // Return original violations without explanations
  }
}

// Function to run Advanced AI page analysis
async function runAdvancedAIAnalysis(screenshot, accessibilityData) {
  try {
    const formattedData = `
COMPLETE PAGE TEXT (for reading level analysis):
${accessibilityData.textContent.substring(0, 10000)}

STATISTICS:
- Total forms: ${accessibilityData.stats.totalForms}
- Total buttons: ${accessibilityData.stats.totalButtons}
- Total links: ${accessibilityData.stats.totalLinks}
- Inputs with placeholder-only labels: ${accessibilityData.stats.hasPlaceholderOnlyInputs}

FORM ELEMENTS (ALL ${accessibilityData.formElements.length} inputs captured):
${JSON.stringify(accessibilityData.formElements, null, 2)}

INTERACTIVE ELEMENTS (first 30 of ${accessibilityData.interactiveElements.length}):
${JSON.stringify(accessibilityData.interactiveElements.slice(0, 30), null, 2)}

ERROR/VALIDATION ELEMENTS:
${JSON.stringify(accessibilityData.errorElements, null, 2)}

POTENTIAL SENSORY INSTRUCTIONS:
${JSON.stringify(accessibilityData.sensoryInstructions, null, 2)}
`;

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
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
              text: `${PAGE_ANALYSIS_PROMPT}\n\n${formattedData}`
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
        console.error('[AI PAGE] JSON parse error:', parseError.message);
        console.error('[AI PAGE] Attempted to parse:', jsonMatch[0].substring(0, 500));
        return {
          summary: 'AI analysis generated but could not be parsed.',
          visual_issues: [],
          content_issues: [],
          _parseError: parseError.message
        };
      }
    }
    return { summary: responseText, visual_issues: [], content_issues: [] };
  } catch (error) {
    console.error('[AI PAGE] Error:', error.message);
    if (error.error) {
      console.error('[AI PAGE] API error details:', error.error);
    }
    return null;
  }
}

// Extract structured accessibility data from page for AI analysis
async function extractAccessibilityData(page) {
  const data = await page.evaluate(() => {
    // 1. Extract text content for reading level analysis (limited to first 50k chars)
    const allText = (document.body.innerText || document.body.textContent).substring(0, 50000);

    // 2. Extract form elements (inputs, textareas, selects)
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

    // 3. Extract buttons and links (for context analysis)
    const interactiveElements = Array.from(document.querySelectorAll('button, a[href]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      text: el.textContent?.trim() || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      href: el.href || null,
      isGeneric: ['click here', 'read more', 'learn more', 'click', 'here'].includes(
        el.textContent?.trim().toLowerCase()
      )
    }));

    // 4. Extract error/validation messages
    const errorElements = Array.from(document.querySelectorAll(
      '[role="alert"], [aria-invalid="true"], .error, .error-message, [aria-live="polite"], [aria-live="assertive"]'
    )).map(el => ({
      role: el.getAttribute('role'),
      text: el.textContent?.trim(),
      ariaLive: el.getAttribute('aria-live')
    }));

    // 5. Check for sensory-dependent instructions in visible text
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
      textContent: allText,
      formElements: formElements,
      interactiveElements: interactiveElements,
      errorElements: errorElements,
      sensoryInstructions: textNodes,
      stats: {
        totalForms: formElements.length,
        totalButtons: interactiveElements.filter(el => el.tag === 'button').length,
        totalLinks: interactiveElements.filter(el => el.tag === 'a').length,
        hasPlaceholderOnlyInputs: formElements.filter(el => el.hasPlaceholderOnly).length,
        hasForms: formElements.length > 0
      }
    };
  });

  return data;
}

// Normalize URL to prevent duplicate scanning of same page
function normalizeUrl(urlString) {
  try {
    const url = new URL(urlString);
    // Force HTTPS
    url.protocol = 'https:';
    // Remove trailing slash (except for root path)
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // Remove default ports
    url.port = '';
    // Lowercase hostname
    url.hostname = url.hostname.toLowerCase();
    // Remove fragment
    url.hash = '';
    // Remove common tracking parameters
    url.searchParams.delete('utm_source');
    url.searchParams.delete('utm_medium');
    url.searchParams.delete('utm_campaign');
    url.searchParams.delete('ref');
    return url.toString();
  } catch {
    return urlString; // Return original if parsing fails
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
                    plan === 'guest' ? 'basic' : 'advanced'; // essentials and professional get advanced

    const visited = new Set();
    const toVisit = new Set([normalizeUrl(website_url)]);
    const violations = [];
    const startTime = Date.now();

    // Track important pages for AI analysis
    const importantPages = [];
    const pageViolationCounts = new Map();

    // Launch browser
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

      // URLs in toVisit are already normalized, but double-check
      if (visited.has(currentUrl)) continue;

      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(currentUrl, { waitUntil: "networkidle2", timeout: 30000 });

        // Check if this is an important page for AI analysis
        let isImportantPage = false;
        let pageData = null;
        let pageScreenshot = null;

        // Always mark homepage as important
        if (visited.size === 0) {
          isImportantPage = true;
        }

        // Check if page has forms (important for accessibility)
        if (aiLevel === 'advanced' && !isImportantPage) {
          pageData = await extractAccessibilityData(page);
          if (pageData.stats.hasForms) {
            isImportantPage = true;
          }
        }

        // Inject axe-core from local node_modules (WCAG 2.2 support)
        await page.addScriptTag({ content: axeCoreScript });

        // Run axe-core scan with WCAG 2.2 Level AA tags
        const result = await page.evaluate(async () => {
          return await axe.run({
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
            }
          });
        });

        const scanDate = new Date().toISOString();
        const pageViolationCount = result.violations.length;
        pageViolationCounts.set(currentUrl, pageViolationCount);

        // Mark pages with high violation counts as important
        if (aiLevel === 'advanced' && !isImportantPage && pageViolationCount >= 5) {
          isImportantPage = true;
        }

        // Capture screenshot and data for important pages
        if (aiLevel === 'advanced' && isImportantPage && importantPages.length < 10) {
          if (!pageData) {
            pageData = await extractAccessibilityData(page);
          }
          pageScreenshot = await page.screenshot({
            encoding: 'base64',
            fullPage: false
          });

          importantPages.push({
            url: currentUrl,
            screenshot: pageScreenshot,
            data: pageData
          });

          console.log(`[AI PAGE] Marked as important: ${currentUrl} (forms: ${pageData.stats.hasForms}, violations: ${pageViolationCount})`);
        }

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
        const internalLinks = await getInternalLinks(page, currentUrl);

        console.log(`[SCAN] Visited: ${currentUrl}`);
        console.log(`[SCAN] Violations: ${pageViolationCount}, Forms: ${pageData?.stats.hasForms || 'not checked'}`);
        console.log(`[SCAN] Progress: ${visited.size}/${pageLimit} pages, ${toVisit.size} queued`);

        internalLinks.forEach(link => {
          const normalizedLink = normalizeUrl(link);
          if (!visited.has(normalizedLink)) toVisit.add(normalizedLink);
        });

        visited.add(normalizeUrl(currentUrl));
        await page.close();

      } catch (error) {
        console.error(`Error scanning ${currentUrl}:`, error.message);
      }
    }

    await browser.close();

    // Run AI analysis based on plan
    let ai_page_analysis = [];
    let violationsWithExplanations = violations;

    console.log(`[AI] Level: ${aiLevel}, Violations: ${violations.length}, Important pages: ${importantPages.length}`);

    if (aiLevel === 'advanced') {
      // Explain all violations
      if (violations.length > 0) {
        console.log('[AI] Generating violation explanations...');
        violationsWithExplanations = await explainViolations(violations);
        console.log('[AI] Violation explanations complete');
      }

      // Analyze important pages
      if (importantPages.length > 0) {
        console.log(`[AI] Analyzing ${importantPages.length} important pages...`);

        for (let i = 0; i < importantPages.length; i++) {
          const pageInfo = importantPages[i];

          // Add delay between API calls to avoid rate limits
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          const analysis = await runAdvancedAIAnalysis(pageInfo.screenshot, pageInfo.data);

          if (analysis) {
            ai_page_analysis.push({
              page_url: pageInfo.url,
              analysis: analysis
            });
          }
        }

        console.log(`[AI] Page analysis complete: ${ai_page_analysis.length} pages analyzed`);
      }
    } else if (aiLevel === 'basic' && violations.length > 0) {
      // For basic tier (guest), just provide simple explanations
      console.log('[AI] Generating basic violation explanations...');
      violationsWithExplanations = await explainViolations(violations);
      console.log('[AI] Basic explanations complete');
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
    const scannedPageUrls = Array.from(visited).join(',');

    return res.status(200).json({
      violations: violationsWithExplanations,
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
      scanner_version: "axe-core 4.10.3 + puppeteer + Claude Haiku 4.5 (Cloud Run)",
      scan_method: "Self-hosted Puppeteer + axe-core + Claude AI",
      ai_page_analysis,
      ai_level: aiLevel,
      important_pages_analyzed: importantPages.length
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
