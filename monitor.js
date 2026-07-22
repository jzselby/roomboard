require('dotenv').config();
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const TARGET_URL = 'https://www.roomandboard.com/clearance/living/sofas-and-loveseats';
const HOMEPAGE_URL = 'https://www.roomandboard.com';
const INTERVAL_MS = 10 * 60 * 1000;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: process.env.SMTP_SECURE !== 'false',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// ─── Strategy 1: Direct HTTP fetch (no browser, no PerimeterX JS) ───

async function tryDirectFetch() {
  console.log('  Strategy 1: Direct HTTP fetch...');

  const userAgents = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ];

  for (const ua of userAgents) {
    try {
      const label = ua.includes('Googlebot') ? 'Googlebot' : ua.includes('iPhone') ? 'Mobile' : 'Desktop';
      console.log(`    Trying ${label} UA...`);
      const resp = await fetch(TARGET_URL, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        redirect: 'follow',
      });

      const html = await resp.text();

      if (html.includes('Press & Hold') || html.includes('Just Checking') || html.includes('Before we continue')) {
        console.log(`    ${label}: got PerimeterX challenge page`);
        continue;
      }

      if (html.includes('clearance') && html.length > 10000) {
        console.log(`    ${label}: got real content (${html.length} bytes)`);
        return parseHtmlProducts(html);
      }

      console.log(`    ${label}: unclear response (${html.length} bytes, status ${resp.status})`);
    } catch (err) {
      console.log(`    Error: ${err.message}`);
    }
  }

  return null;
}

function parseHtmlProducts(html) {
  const $ = cheerio.load(html);
  const products = [];

  $('a[href*="/clearance/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.split('/').length <= 5) return;
    const fullUrl = href.startsWith('http') ? href : `https://www.roomandboard.com${href}`;
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text.length > 3 && !products.some(p => p.url === fullUrl)) {
      products.push({ name: text.substring(0, 200), url: fullUrl, source: 'html-fetch' });
    }
  });

  // Try structured data (JSON-LD)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data['@type'] === 'Product' || data['@type'] === 'ItemList') {
        console.log(`    Found JSON-LD structured data: ${data['@type']}`);
      }
    } catch {}
  });

  // Try __NEXT_DATA__ or similar embedded JSON
  $('script#__NEXT_DATA__').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      console.log('    Found __NEXT_DATA__ embedded data');
    } catch {}
  });

  return products.length > 0 ? products : null;
}

// ─── Strategy 2: Rebrowser (CDP-patched Puppeteer) ───

async function tryRebrowser() {
  console.log('  Strategy 2: Rebrowser (patched Puppeteer)...');

  let puppeteer;
  try {
    puppeteer = require('rebrowser-puppeteer-core');
  } catch {
    console.log('    rebrowser-puppeteer-core not available, trying puppeteer-extra...');
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  }

  const useHeaded = !!(process.env.DISPLAY || process.env.HEADED === 'true');

  // Find Chromium executable
  const execPath = findChromium();
  if (!execPath) {
    console.log('    No Chromium found');
    return null;
  }
  console.log(`    Using: ${execPath}`);
  console.log(`    Mode: ${useHeaded ? 'headed (xvfb)' : 'headless'}`);

  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: useHeaded ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1440,900',
      '--lang=en-US',
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(params);
    });

    // Visit homepage first
    console.log('    Visiting homepage...');
    await page.goto(HOMEPAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(2000, 4000);
    await humanScrollPuppeteer(page);
    await randomDelay(1000, 2000);

    // Navigate to clearance page
    console.log('    Navigating to clearance sofas...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);

    let bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));

    if (isBlocked(bodyText)) {
      console.log('    Bot detection triggered, attempting challenge...');

      // Try to solve Press & Hold
      for (let attempt = 1; attempt <= 2; attempt++) {
        const solved = await solvePxChallenge(page);
        if (solved) {
          const currentUrl = page.url();
          if (!currentUrl.includes('clearance')) {
            await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await randomDelay(3000, 5000);
          }
          bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
          if (!isBlocked(bodyText)) break;
        }
        if (attempt < 2) {
          console.log('    Retrying...');
          await randomDelay(5000, 10000);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          await randomDelay(3000, 5000);
          bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
          if (!isBlocked(bodyText)) break;
        }
      }

      if (isBlocked(bodyText)) {
        console.log('    Still blocked after all attempts');
        const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
        await browser.close();
        return { blocked: true, bodyPreview: bodyText.substring(0, 500), screenshot };
      }
    }

    console.log('    Page loaded successfully!');
    await humanScrollPuppeteer(page);
    await randomDelay(1000, 2000);

    // Wait for content to load
    await page.waitForSelector('a[href*="/clearance/"]', { timeout: 15000 }).catch(() => {});
    await randomDelay(1000, 2000);

    return await scrapeProductsPuppeteer(page);
  } finally {
    await browser.close();
  }
}

function findChromium() {
  const fs = require('fs');
  const paths = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  // Check Playwright's installed browser
  try {
    const { execSync } = require('child_process');
    const pwPath = execSync('npx playwright install --dry-run chromium 2>/dev/null || true', { encoding: 'utf8' });
    // Try to find playwright's chromium
    const homeDir = process.env.HOME || '/root';
    const pwBrowsers = require('path').join(homeDir, '.cache', 'ms-playwright');
    if (fs.existsSync(pwBrowsers)) {
      const dirs = fs.readdirSync(pwBrowsers).filter(d => d.startsWith('chromium'));
      for (const dir of dirs) {
        const chromePath = require('path').join(pwBrowsers, dir, 'chrome-linux', 'chrome');
        if (fs.existsSync(chromePath)) paths.push(chromePath);
      }
    }
  } catch {}

  for (const p of paths) {
    if (p && require('fs').existsSync(p)) return p;
  }
  return null;
}

async function humanScrollPuppeteer(page) {
  const scrolls = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrolls; i++) {
    await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 400));
    await randomDelay(300, 800);
  }
}

async function solvePxChallenge(page) {
  console.log('    Looking for Press & Hold button...');
  await randomDelay(1000, 2000);

  // Check all frames (PerimeterX uses iframes)
  const frames = page.frames();
  let targetFrame = page;

  for (const frame of frames) {
    try {
      const hasChallenge = await frame.evaluate(() =>
        document.body?.innerText?.includes('Press & Hold')
      ).catch(() => false);
      if (hasChallenge && frame !== page.mainFrame()) {
        targetFrame = frame;
        console.log('    Found challenge in iframe');
        break;
      }
    } catch {}
  }

  // Find the captcha element
  const selectors = ['#px-captcha', '[id*="px-captcha"]', '[class*="px-captcha"]'];
  let buttonBox = null;

  for (const sel of selectors) {
    try {
      await targetFrame.waitForSelector(sel, { timeout: 3000 });
      buttonBox = await targetFrame.$eval(sel, el => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      if (buttonBox && buttonBox.width > 0) {
        console.log(`    Found: ${sel} (${buttonBox.width}x${buttonBox.height})`);
        break;
      }
    } catch {}
  }

  if (!buttonBox) {
    // Try broader selectors
    for (const sel of ['[role="button"]', 'button']) {
      try {
        const buttons = await targetFrame.$$(sel);
        for (const btn of buttons) {
          const text = await btn.evaluate(el => el.textContent || '');
          if (text.includes('Press') || text.includes('Hold')) {
            buttonBox = await btn.evaluate(el => {
              const rect = el.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            });
            console.log(`    Found via text: ${sel}`);
            break;
          }
        }
        if (buttonBox) break;
      } catch {}
    }
  }

  if (!buttonBox || buttonBox.width === 0) {
    console.log('    Could not find challenge button');
    return false;
  }

  const centerX = buttonBox.x + buttonBox.width / 2;
  const centerY = buttonBox.y + buttonBox.height / 2;

  // Move mouse naturally to button
  const steps = 10 + Math.floor(Math.random() * 10);
  let curX = 200 + Math.random() * 400;
  let curY = 200 + Math.random() * 300;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const jx = (Math.random() - 0.5) * 5;
    const jy = (Math.random() - 0.5) * 5;
    curX = curX + (centerX - curX) * t + jx;
    curY = curY + (centerY - curY) * t + jy;
    await page.mouse.move(curX, curY);
    await randomDelay(15, 45);
  }
  await page.mouse.move(centerX, centerY);
  await randomDelay(200, 500);

  // Press and hold
  console.log('    Pressing and holding...');
  await page.mouse.down();

  const holdMs = 6000 + Math.random() * 4000;
  const microMoves = 15 + Math.floor(Math.random() * 10);
  for (let i = 0; i < microMoves; i++) {
    await page.mouse.move(
      centerX + (Math.random() - 0.5) * 3,
      centerY + (Math.random() - 0.5) * 3,
    );
    await randomDelay(holdMs / microMoves * 0.8, holdMs / microMoves * 1.2);
  }

  await page.mouse.up();
  console.log(`    Released after ~${Math.round(holdMs)}ms`);
  await randomDelay(3000, 6000);

  const afterText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  const solved = !isBlocked(afterText);
  console.log(`    ${solved ? 'Challenge solved!' : 'Still blocked'}`);
  return solved;
}

async function scrapeProductsPuppeteer(page) {
  const productLinks = await page.evaluate(() => {
    const seen = new Set();
    const links = [];
    document.querySelectorAll('a').forEach(a => {
      const href = a.href;
      if (!href || seen.has(href)) return;
      if (href.includes('/clearance/') && href.split('/').length > 5) {
        const text = a.textContent.trim().replace(/\s+/g, ' ').substring(0, 200);
        if (text.length > 2) {
          seen.add(href);
          links.push({ href, text });
        }
      }
    });
    return links;
  });

  const gridProducts = await page.evaluate(() => {
    const products = [];
    const selectors = [
      '[data-testid*="product"]',
      '[class*="ProductCard"]', '[class*="product-card"]',
      '[class*="productCard"]', '[class*="product-tile"]',
      '[class*="ProductTile"]', '.grid-item',
      'article', 'li[class*="product"]',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        els.forEach(el => {
          const name = (
            el.querySelector('h2, h3, h4, [class*="name"], [class*="Name"], [class*="title"], [class*="Title"]')?.textContent ||
            el.querySelector('a')?.textContent || ''
          ).trim().replace(/\s+/g, ' ');
          const link = el.querySelector('a')?.href || '';
          const priceEl = el.querySelector('[class*="price"], [class*="Price"], [class*="sale"], [class*="Sale"]');
          const price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';
          const stockEl = el.querySelector('[class*="stock"], [class*="Stock"], [class*="avail"], [class*="Avail"], [class*="badge"], [class*="Badge"]');
          const stock = stockEl ? stockEl.textContent.trim() : '';
          if (name && name.length > 3) products.push({ name, link, price, stock });
        });
        if (products.length > 0) break;
      }
    }
    return products;
  });

  // Deduplicate
  const allLinks = new Map();
  for (const p of gridProducts) {
    if (p.link) allLinks.set(p.link, { name: p.name, price: p.price, stock: p.stock });
  }
  for (const p of productLinks) {
    if (!allLinks.has(p.href)) allLinks.set(p.href, { name: p.text, price: '', stock: '' });
  }

  if (allLinks.size === 0) {
    const debugText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    console.log('[DEBUG] No product links found. Page text:');
    console.log(debugText);
  }

  // Visit each product for stock detail
  const detailed = [];
  for (const [url, info] of allLinks) {
    try {
      console.log(`    Checking: ${info.name || url}`);
      await randomDelay(1500, 3000);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(2000, 3500);
      await humanScrollPuppeteer(page);

      const detail = await page.evaluate(() => {
        const getText = (...sels) => {
          for (const s of sels) { const el = document.querySelector(s); if (el) return el.textContent.trim().replace(/\s+/g, ' '); }
          return '';
        };
        const name = getText('h1', '[class*="productName"]', '[class*="product-name"]');
        const price = getText('[class*="salePrice"]', '[class*="sale-price"]', '[class*="price"]', '[class*="Price"]');
        const originalPrice = getText('[class*="originalPrice"]', '[class*="original-price"]', 'del', 's');
        let stockInfo = '';
        for (const s of ['[class*="stock"]', '[class*="Stock"]', '[class*="avail"]', '[class*="Avail"]', '[class*="badge"]', '[class*="Badge"]', '[class*="remaining"]']) {
          const el = document.querySelector(s);
          if (el) { const t = el.textContent.trim(); if (t.length > 0 && t.length < 200) stockInfo += (stockInfo ? ' | ' : '') + t; }
        }
        const addToCart = document.querySelector('button[class*="addToCart"], button[class*="add-to-cart"]');
        const canAddToCart = addToCart ? !addToCart.disabled : null;
        const bodyText = document.body.innerText;
        const qtyMatch = bodyText.match(/only\s+(\d+)\s+(left|available|remaining|in stock)/i) || bodyText.match(/(\d+)\s+(left|remaining|in stock|available)/i);
        const qtyFromText = qtyMatch ? parseInt(qtyMatch[1]) : null;
        return { name, price, originalPrice, stockInfo, canAddToCart, qtyFromText, url: window.location.href };
      });

      detailed.push({ ...detail, name: detail.name || info.name, listingPrice: info.price, listingStock: info.stock });
    } catch (err) {
      console.log(`    Error: ${err.message}`);
      detailed.push({ name: info.name, url, price: info.price, error: err.message });
    }
  }

  return detailed;
}

function isBlocked(text) {
  return text.includes('Just Checking') ||
         text.includes("confirm you're human") ||
         text.includes('Press & Hold') ||
         text.includes('Before we continue');
}

// ─── Email formatting ───

function formatEmailHtml(products, timestamp) {
  if (!Array.isArray(products)) return '';
  const rows = products.map(p => {
    let stockDisplay = '';
    if (p.error) {
      stockDisplay = `<span style="color:#c0392b">Error: ${p.error}</span>`;
    } else {
      const parts = [];
      if (p.stockInfo) parts.push(p.stockInfo);
      if (p.canAddToCart !== null) parts.push(p.canAddToCart ? 'Can add to cart' : 'Cannot add to cart');
      if (p.qtyFromText !== null) parts.push(`${p.qtyFromText} available`);
      if (p.listingStock) parts.push(p.listingStock);
      if (p.source) parts.push(`via ${p.source}`);
      stockDisplay = parts.length > 0 ? parts.join(' &bull; ') : '<span style="color:#7f8c8d">No stock info found</span>';
    }
    const priceDisplay = p.price || p.listingPrice || 'N/A';
    const origPrice = p.originalPrice ? `<del style="color:#95a5a6">${p.originalPrice}</del> ` : '';
    return `<tr style="border-bottom:1px solid #ecf0f1">
        <td style="padding:12px 8px;vertical-align:top"><a href="${p.url}" style="color:#2980b9;text-decoration:none;font-weight:600">${p.name || 'Unknown'}</a></td>
        <td style="padding:12px 8px;vertical-align:top;white-space:nowrap">${origPrice}${priceDisplay}</td>
        <td style="padding:12px 8px;vertical-align:top">${stockDisplay}</td></tr>`;
  }).join('\n');

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto">
      <h2 style="color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:8px">Room & Board Clearance Sofas</h2>
      <p style="color:#7f8c8d;font-size:14px">Checked at ${timestamp} &bull; ${products.length} item(s) found</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f8f9fa;text-align:left">
          <th style="padding:10px 8px;border-bottom:2px solid #dee2e6">Product</th>
          <th style="padding:10px 8px;border-bottom:2px solid #dee2e6">Price</th>
          <th style="padding:10px 8px;border-bottom:2px solid #dee2e6">Stock Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#95a5a6;font-size:12px;margin-top:20px"><a href="${TARGET_URL}" style="color:#3498db">View on Room & Board</a> &bull; Next check in 10 minutes</p>
    </div>`;
}

function formatBlockedEmailHtml(bodyPreview, timestamp) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto">
      <h2 style="color:#c0392b;border-bottom:2px solid #e74c3c;padding-bottom:8px">⚠ Room & Board — Bot Detection Triggered</h2>
      <p style="color:#7f8c8d;font-size:14px">Checked at ${timestamp}</p>
      <p>All strategies failed to bypass PerimeterX bot detection. Strategies tried: direct HTTP fetch (Googlebot/Desktop/Mobile UAs), rebrowser-patched Puppeteer with stealth + challenge solving.</p>
      <details><summary>Page text preview</summary>
        <pre style="background:#f8f9fa;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap">${bodyPreview}</pre>
      </details>
      <p style="color:#95a5a6;font-size:12px;margin-top:20px"><a href="${TARGET_URL}" style="color:#3498db">View on Room & Board</a> &bull; Will retry on next scheduled run</p>
    </div>`;
}

async function sendEmail(result) {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'America/Chicago' });
  let subject, html, attachments = [];

  if (result && result.blocked) {
    subject = `⚠ Clearance Sofas: Blocked by bot detection — ${timestamp}`;
    html = formatBlockedEmailHtml(result.bodyPreview || '', timestamp);
    if (result.screenshot) attachments.push({ filename: 'blocked-page.png', content: result.screenshot });
  } else {
    const products = Array.isArray(result) ? result : [];
    subject = `Clearance Sofas: ${products.length} items found — ${timestamp}`;
    html = formatEmailHtml(products, timestamp);
  }

  const info = await transporter.sendMail({ from: process.env.SMTP_USER, to: process.env.NOTIFY_EMAIL || process.env.SMTP_USER, subject, html, attachments });
  console.log(`  Email sent: ${info.messageId}`);
}

// ─── Main orchestrator ───

async function run() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Checking Room & Board clearance sofas...`);

  try {
    // Strategy 1: Direct HTTP fetch (fastest, no browser)
    let result = await tryDirectFetch();
    if (result && Array.isArray(result) && result.length > 0) {
      console.log(`  Strategy 1 succeeded: ${result.length} product(s)`);
    } else {
      console.log('  Strategy 1: no products found, trying browser...');
      // Strategy 2: Rebrowser-patched Puppeteer
      result = await tryRebrowser();
    }

    if (result && result.blocked) {
      console.log('  All strategies failed — blocked');
    } else if (Array.isArray(result)) {
      console.log(`  Found ${result.length} product(s)`);
      result.forEach(p => {
        const stock = [p.stockInfo, p.canAddToCart !== null ? (p.canAddToCart ? 'Purchasable' : 'Not purchasable') : '', p.qtyFromText ? `${p.qtyFromText} avail` : ''].filter(Boolean).join(' | ');
        console.log(`    - ${p.name || 'Unknown'}: ${p.price || 'N/A'} [${stock || 'no stock info'}]`);
      });
    }

    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      await sendEmail(result);
    } else {
      console.log('  [SKIP] Email not configured');
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    console.error(err.stack);
  }
}

async function main() {
  const once = process.argv.includes('--once');
  console.log('Room & Board Clearance Sofa Monitor');
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Mode: ${once ? 'single check' : `every ${INTERVAL_MS / 60000} minutes`}`);
  console.log('');

  await run();

  if (!once) {
    setInterval(run, INTERVAL_MS);
    console.log('\nMonitor running. Press Ctrl+C to stop.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
