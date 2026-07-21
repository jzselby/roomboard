require('dotenv').config();
const { chromium } = require('playwright-core');
const nodemailer = require('nodemailer');

const TARGET_URL = 'https://www.roomandboard.com/clearance/living/sofas-and-loveseats';
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

async function scrapeProducts() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for product grid to render
    await page.waitForSelector('a[href*="/clearance/"]', { timeout: 15000 }).catch(() => {});
    // Give JS time to hydrate
    await page.waitForTimeout(3000);

    // Gather all product links from the listing page
    const productLinks = await page.evaluate(() => {
      const seen = new Set();
      const links = [];
      document.querySelectorAll('a').forEach(a => {
        const href = a.href;
        if (!href || seen.has(href)) return;
        // Match clearance product detail links (they typically have a SKU-like path)
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

    // Also try to grab product cards from the listing grid
    const gridProducts = await page.evaluate(() => {
      const products = [];
      // Common patterns for product grids on furniture sites
      const selectors = [
        '[data-testid*="product"]',
        '[class*="ProductCard"]',
        '[class*="product-card"]',
        '[class*="productCard"]',
        '[class*="product-tile"]',
        '[class*="ProductTile"]',
        '.grid-item',
        '[class*="clearance"] [class*="card"]',
        'article',
        'li[class*="product"]',
      ];

      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          els.forEach(el => {
            const name = (
              el.querySelector('h2, h3, h4, [class*="name"], [class*="Name"], [class*="title"], [class*="Title"]')?.textContent ||
              el.querySelector('a')?.textContent ||
              ''
            ).trim().replace(/\s+/g, ' ');

            const link = el.querySelector('a')?.href || '';

            const priceEl = el.querySelector('[class*="price"], [class*="Price"], [class*="sale"], [class*="Sale"]');
            const price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';

            const stockEl = el.querySelector('[class*="stock"], [class*="Stock"], [class*="avail"], [class*="Avail"], [class*="quantity"], [class*="Quantity"], [class*="badge"], [class*="Badge"]');
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

    // Visit each product page to get detailed stock info
    const detailedProducts = [];

    // Deduplicate links - prefer gridProducts links, fall back to productLinks
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
      // Fallback: grab the full page text to help debug
      const bodyText = await page.evaluate(() =>
        document.body.innerText.substring(0, 3000)
      );
      console.log('[DEBUG] No product links found. Page text preview:');
      console.log(bodyText);

      // Try getting all links on the page for debugging
      const allPageLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({ href: a.href, text: a.textContent.trim().substring(0, 80) }))
          .filter(a => a.text.length > 0)
          .slice(0, 50);
      });
      console.log('[DEBUG] All links:', JSON.stringify(allPageLinks, null, 2));
    }

    for (const [url, info] of allLinks) {
      try {
        console.log(`  Checking: ${info.name || url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        const detail = await page.evaluate(() => {
          const getText = (...selectors) => {
            for (const s of selectors) {
              const el = document.querySelector(s);
              if (el) return el.textContent.trim().replace(/\s+/g, ' ');
            }
            return '';
          };

          const name = getText(
            'h1', '[class*="productName"]', '[class*="product-name"]',
            '[class*="ProductName"]', '[data-testid="product-name"]'
          );

          const price = getText(
            '[class*="salePrice"]', '[class*="sale-price"]', '[class*="SalePrice"]',
            '[class*="clearance-price"]', '[class*="price"]', '[class*="Price"]'
          );

          const originalPrice = getText(
            '[class*="originalPrice"]', '[class*="original-price"]',
            '[class*="comparePrice"]', '[class*="wasPrice"]',
            '[class*="strikethrough"]', 'del', 's'
          );

          // Look for stock/availability/quantity info
          const stockSelectors = [
            '[class*="stock"]', '[class*="Stock"]',
            '[class*="avail"]', '[class*="Avail"]',
            '[class*="inventory"]', '[class*="Inventory"]',
            '[class*="quantity"]', '[class*="Quantity"]',
            '[class*="in-stock"]', '[class*="inStock"]',
            '[class*="out-of-stock"]', '[class*="outOfStock"]',
            '[class*="badge"]', '[class*="Badge"]',
            '[class*="remaining"]', '[class*="left"]',
            '[data-testid*="stock"]', '[data-testid*="avail"]',
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

          // Check for "Add to Cart" button state (disabled usually means out of stock)
          const addToCart = document.querySelector(
            'button[class*="addToCart"], button[class*="add-to-cart"], ' +
            'button[data-testid*="add-to-cart"], button[class*="AddToCart"]'
          );
          const canAddToCart = addToCart ? !addToCart.disabled : null;

          // Look for quantity selector
          const qtySelect = document.querySelector('select[class*="qty"], select[class*="quantity"], input[class*="qty"]');
          let maxQty = null;
          if (qtySelect && qtySelect.tagName === 'SELECT') {
            const opts = qtySelect.querySelectorAll('option');
            if (opts.length > 0) {
              maxQty = parseInt(opts[opts.length - 1].value) || opts.length;
            }
          }

          // Check for "Only X left" type messages
          const bodyText = document.body.innerText;
          const qtyMatch = bodyText.match(/only\s+(\d+)\s+(left|available|remaining|in stock)/i) ||
                          bodyText.match(/(\d+)\s+(left|remaining|in stock|available)/i) ||
                          bodyText.match(/quantity[:\s]+(\d+)/i);
          const qtyFromText = qtyMatch ? parseInt(qtyMatch[1]) : null;

          return {
            name,
            price,
            originalPrice,
            stockInfo,
            canAddToCart,
            maxQty,
            qtyFromText,
            url: window.location.href,
          };
        });

        detailedProducts.push({
          ...detail,
          name: detail.name || info.name,
          listingPrice: info.price,
          listingStock: info.stock,
        });
      } catch (err) {
        console.log(`  Error checking ${url}: ${err.message}`);
        detailedProducts.push({
          name: info.name,
          url,
          price: info.price,
          error: err.message,
        });
      }
    }

    return detailedProducts;
  } finally {
    await browser.close();
  }
}

function formatEmailHtml(products, timestamp) {
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

async function sendEmail(products) {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'America/Chicago' });

  const info = await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
    subject: `Clearance Sofas: ${products.length} items found — ${timestamp}`,
    html: formatEmailHtml(products, timestamp),
  });

  console.log(`  Email sent: ${info.messageId}`);
}

async function run() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Checking Room & Board clearance sofas...`);

  try {
    const products = await scrapeProducts();
    console.log(`  Found ${products.length} product(s)`);

    products.forEach(p => {
      const stock = [p.stockInfo, p.canAddToCart !== null ? (p.canAddToCart ? 'Purchasable' : 'Not purchasable') : '', p.qtyFromText ? `${p.qtyFromText} avail` : ''].filter(Boolean).join(' | ');
      console.log(`    - ${p.name || 'Unknown'}: ${p.price || 'N/A'} [${stock || 'no stock info'}]`);
    });

    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      await sendEmail(products);
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
