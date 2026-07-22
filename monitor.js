require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const nodemailer = require('nodemailer');

chromium.use(StealthPlugin());

const TARGET_URL = 'https://www.roomandboard.com/clearance/living/sofas-and-loveseats';
const HOMEPAGE_URL = 'https://www.roomandboard.com';
const INTERVAL_MS = 10 * 60 * 1000;

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;

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

async function humanScroll(page) {
  const scrolls = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrolls; i++) {
    await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 400));
    await randomDelay(300, 800);
  }
}

async function humanMouseMove(page, x, y) {
  const steps = 8 + Math.floor(Math.random() * 8);
  const current = { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 };
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const jitterX = (Math.random() - 0.5) * 6;
    const jitterY = (Math.random() - 0.5) * 6;
    const moveX = current.x + (x - current.x) * progress + jitterX;
    const moveY = current.y + (y - current.y) * progress + jitterY;
    await page.mouse.move(moveX, moveY);
    await randomDelay(10, 40);
  }
  await page.mouse.move(x, y);
}

async function solveChallenge(page) {
  console.log('  Attempting to solve Press & Hold challenge...');
  await randomDelay(1000, 2000);

  // Look for the Press & Hold button — could be in main page or iframe
  let challengeFrame = page;

  // Check iframes first (PerimeterX often uses iframes)
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const hasChallenge = await frame.evaluate(() =>
        document.body?.innerText?.includes('Press & Hold')
      ).catch(() => false);
      if (hasChallenge) {
        challengeFrame = frame;
        console.log('  Found challenge in iframe');
        break;
      }
    } catch {}
  }

  // Find the press-and-hold button
  const buttonSelectors = [
    '#px-captcha',
    '[id*="px-captcha"]',
    '[class*="px-captcha"]',
    'button:has-text("Press & Hold")',
    'div:has-text("Press & Hold")',
    '[role="button"]',
    '#challenge',
    '[id*="challenge"]',
  ];

  let button = null;
  for (const sel of buttonSelectors) {
    try {
      const el = challengeFrame.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        button = el;
        console.log(`  Found challenge element: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!button) {
    console.log('  Could not find Press & Hold button element');
    return false;
  }

  // Get button position
  const box = await button.boundingBox();
  if (!box) {
    console.log('  Could not get button position');
    return false;
  }

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  // Simulate human-like mouse movement to button
  await humanMouseMove(page, centerX, centerY);
  await randomDelay(200, 500);

  // Press and hold
  console.log('  Pressing and holding...');
  await page.mouse.down();

  // Hold for several seconds with micro-movements (human hands aren't perfectly still)
  const holdDuration = 5000 + Math.random() * 3000;
  const microMoveCount = 10 + Math.floor(Math.random() * 10);
  const microInterval = holdDuration / microMoveCount;

  for (let i = 0; i < microMoveCount; i++) {
    const jx = centerX + (Math.random() - 0.5) * 4;
    const jy = centerY + (Math.random() - 0.5) * 4;
    await page.mouse.move(jx, jy);
    await randomDelay(microInterval * 0.8, microInterval * 1.2);
  }

  // Release
  await page.mouse.up();
  console.log(`  Released after ${Math.round(holdDuration)}ms hold`);

  // Wait for potential redirect/page change
  await randomDelay(3000, 5000);

  // Check if challenge is gone
  const afterText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  const stillBlocked = afterText.includes('Press & Hold') ||
                       afterText.includes('Just Checking') ||
                       afterText.includes('Before we continue');

  if (!stillBlocked) {
    console.log('  Challenge appears solved!');
    return true;
  }

  console.log('  Challenge still present after attempt');
  return false;
}

function isBlocked(text) {
  return text.includes('Just Checking') ||
         text.includes("confirm you're human") ||
         text.includes('Press & Hold') ||
         text.includes('Before we continue');
}

async function scrapeProducts() {
  const useHeaded = !!(process.env.DISPLAY || process.env.HEADED === 'true');
  console.log(`  Browser mode: ${useHeaded ? 'headed (xvfb)' : 'headless'}`);

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: !useHeaded,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1440,900',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/Chicago',
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    // Visit homepage first to establish cookies/session
    console.log('  Visiting homepage first...');
    await page.goto(HOMEPAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(2000, 4000);
    await humanScroll(page);
    await randomDelay(1000, 2000);

    // Navigate to clearance sofas
    console.log('  Navigating to clearance sofas...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 5000);

    // Check for bot detection and try to solve it
    let bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    if (isBlocked(bodyText)) {
      console.log('  Bot detection triggered');

      // Attempt 1: solve the challenge
      const solved = await solveChallenge(page);
      if (solved) {
        // Navigate back to the target URL if we were redirected
        const currentUrl = page.url();
        if (!currentUrl.includes('clearance')) {
          await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await randomDelay(3000, 5000);
        }
        bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
      }

      // Attempt 2: if still blocked, wait longer and try again
      if (isBlocked(bodyText)) {
        console.log('  Retrying challenge after delay...');
        await randomDelay(5000, 10000);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await randomDelay(3000, 5000);
        bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));

        if (isBlocked(bodyText)) {
          const solved2 = await solveChallenge(page);
          if (solved2) {
            await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await randomDelay(3000, 5000);
            bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
          }
        }
      }

      if (isBlocked(bodyText)) {
        console.log('  Still blocked after all attempts — sending alert email');
        const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
        await browser.close();
        return { blocked: true, bodyPreview: bodyText.substring(0, 500), screenshot };
      }
    }

    console.log('  Page loaded successfully');
    await humanScroll(page);
    await randomDelay(1000, 2000);

    // Wait for product grid
    await page.waitForSelector('a[href*="/clearance/"]', { timeout: 15000 }).catch(() => {});
    await randomDelay(1000, 2000);

    // Gather product links
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

    // Try to grab product cards from the listing grid
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
            if (name && name.length > 3) {
              products.push({ name, link, price, stock, selector: sel });
            }
          });
          if (products.length > 0) break;
        }
      }
      return products;
    });

    // Deduplicate links
    const allLinks = new Map();
    for (const p of gridProducts) {
      if (p.link) allLinks.set(p.link, { name: p.name, price: p.price, stock: p.stock });
    }
    for (const p of productLinks) {
      if (!allLinks.has(p.href)) {
        allLinks.set(p.href, { name: p.text, price: '', stock: '' });
      }
    }

    if (allLinks.size === 0) {
      const debugText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
      console.log('[DEBUG] No product links found. Page text preview:');
      console.log(debugText);
    }

    // Visit each product page for detailed stock info
    const detailedProducts = [];
    for (const [url, info] of allLinks) {
      try {
        console.log(`  Checking: ${info.name || url}`);
        await randomDelay(1500, 3000);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 3500);
        await humanScroll(page);

        const detail = await page.evaluate(() => {
          const getText = (...selectors) => {
            for (const s of selectors) {
              const el = document.querySelector(s);
              if (el) return el.textContent.trim().replace(/\s+/g, ' ');
            }
            return '';
          };

          const name = getText('h1', '[class*="productName"]', '[class*="product-name"]', '[class*="ProductName"]');
          const price = getText('[class*="salePrice"]', '[class*="sale-price"]', '[class*="SalePrice"]', '[class*="price"]', '[class*="Price"]');
          const originalPrice = getText('[class*="originalPrice"]', '[class*="original-price"]', '[class*="comparePrice"]', 'del', 's');

          const stockSelectors = [
            '[class*="stock"]', '[class*="Stock"]', '[class*="avail"]', '[class*="Avail"]',
            '[class*="inventory"]', '[class*="quantity"]', '[class*="in-stock"]', '[class*="inStock"]',
            '[class*="out-of-stock"]', '[class*="outOfStock"]', '[class*="badge"]', '[class*="Badge"]',
            '[class*="remaining"]', '[class*="left"]',
          ];

          let stockInfo = '';
          for (const s of stockSelectors) {
            const el = document.querySelector(s);
            if (el) {
              const t = el.textContent.trim();
              if (t.length > 0 && t.length < 200) {
                stockInfo += (stockInfo ? ' | ' : '') + t;
              }
            }
          }

          const addToCart = document.querySelector('button[class*="addToCart"], button[class*="add-to-cart"], button[class*="AddToCart"]');
          const canAddToCart = addToCart ? !addToCart.disabled : null;

          const qtySelect = document.querySelector('select[class*="qty"], select[class*="quantity"], input[class*="qty"]');
          let maxQty = null;
          if (qtySelect && qtySelect.tagName === 'SELECT') {
            const opts = qtySelect.querySelectorAll('option');
            if (opts.length > 0) maxQty = parseInt(opts[opts.length - 1].value) || opts.length;
          }

          const bodyText = document.body.innerText;
          const qtyMatch = bodyText.match(/only\s+(\d+)\s+(left|available|remaining|in stock)/i) ||
                          bodyText.match(/(\d+)\s+(left|remaining|in stock|available)/i) ||
                          bodyText.match(/quantity[:\s]+(\d+)/i);
          const qtyFromText = qtyMatch ? parseInt(qtyMatch[1]) : null;

          return { name, price, originalPrice, stockInfo, canAddToCart, maxQty, qtyFromText, url: window.location.href };
        });

        detailedProducts.push({
          ...detail,
          name: detail.name || info.name,
          listingPrice: info.price,
          listingStock: info.stock,
        });
      } catch (err) {
        console.log(`  Error checking ${url}: ${err.message}`);
        detailedProducts.push({ name: info.name, url, price: info.price, error: err.message });
      }
    }

    return detailedProducts;
  } finally {
    await browser.close();
  }
}

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
      if (p.maxQty !== null) parts.push(`Max qty: ${p.maxQty}`);
      if (p.qtyFromText !== null) parts.push(`${p.qtyFromText} available`);
      if (p.listingStock) parts.push(p.listingStock);
      stockDisplay = parts.length > 0 ? parts.join(' &bull; ') : '<span style="color:#7f8c8d">No stock info found</span>';
    }

    const priceDisplay = p.price || p.listingPrice || 'N/A';
    const origPrice = p.originalPrice ? `<del style="color:#95a5a6">${p.originalPrice}</del> ` : '';

    return `
      <tr style="border-bottom:1px solid #ecf0f1">
        <td style="padding:12px 8px;vertical-align:top">
          <a href="${p.url}" style="color:#2980b9;text-decoration:none;font-weight:600">${p.name || 'Unknown'}</a>
        </td>
        <td style="padding:12px 8px;vertical-align:top;white-space:nowrap">
          ${origPrice}${priceDisplay}
        </td>
        <td style="padding:12px 8px;vertical-align:top">
          ${stockDisplay}
        </td>
      </tr>`;
  }).join('\n');

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto">
      <h2 style="color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:8px">
        Room & Board Clearance Sofas
      </h2>
      <p style="color:#7f8c8d;font-size:14px">
        Checked at ${timestamp} &bull; ${products.length} item(s) found
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f8f9fa;text-align:left">
            <th style="padding:10px 8px;border-bottom:2px solid #dee2e6">Product</th>
            <th style="padding:10px 8px;border-bottom:2px solid #dee2e6">Price</th>
            <th style="padding:10px 8px;border-bottom:2px solid #dee2e6">Stock Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p style="color:#95a5a6;font-size:12px;margin-top:20px">
        <a href="${TARGET_URL}" style="color:#3498db">View on Room & Board</a>
        &bull; Next check in 10 minutes
      </p>
    </div>`;
}

function formatBlockedEmailHtml(bodyPreview, timestamp) {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto">
      <h2 style="color:#c0392b;border-bottom:2px solid #e74c3c;padding-bottom:8px">
        ⚠ Room & Board — Bot Detection Triggered
      </h2>
      <p style="color:#7f8c8d;font-size:14px">
        Checked at ${timestamp}
      </p>
      <p>The scraper was blocked by bot detection (PerimeterX "Press & Hold" challenge). No product data was collected this run.</p>
      <details>
        <summary>Page text preview</summary>
        <pre style="background:#f8f9fa;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap">${bodyPreview}</pre>
      </details>
      <p style="color:#95a5a6;font-size:12px;margin-top:20px">
        <a href="${TARGET_URL}" style="color:#3498db">View on Room & Board</a>
        &bull; Will retry on next scheduled run
      </p>
    </div>`;
}

async function sendEmail(result) {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'America/Chicago' });

  let subject, html, attachments = [];

  if (result && result.blocked) {
    subject = `⚠ Clearance Sofas: Blocked by bot detection — ${timestamp}`;
    html = formatBlockedEmailHtml(result.bodyPreview || '', timestamp);
    if (result.screenshot) {
      attachments.push({ filename: 'blocked-page.png', content: result.screenshot });
    }
  } else {
    const products = Array.isArray(result) ? result : [];
    subject = `Clearance Sofas: ${products.length} items found — ${timestamp}`;
    html = formatEmailHtml(products, timestamp);
  }

  const info = await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
    subject,
    html,
    attachments,
  });

  console.log(`  Email sent: ${info.messageId}`);
}

async function run() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Checking Room & Board clearance sofas...`);

  try {
    const result = await scrapeProducts();

    if (result && result.blocked) {
      console.log('  Blocked by bot detection');
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
      console.log('  [SKIP] Email not configured (set SMTP_USER and SMTP_PASS in .env)');
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
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
