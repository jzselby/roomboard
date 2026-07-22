require('dotenv').config();
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const TARGET_URL = 'https://www.roomandboard.com/clearance/living/sofas-and-loveseats';
const INTERVAL_MS = 10 * 60 * 1000;
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

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

// ─── Strategy 1: Next.js data API (pure JSON, no PerimeterX) ───

async function tryNextDataApi() {
  console.log('  Strategy 1: Next.js data API...');

  // First fetch the page to get the buildId from __NEXT_DATA__
  try {
    const resp = await fetch(TARGET_URL, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    const html = await resp.text();

    if (html.includes('Press & Hold') || html.includes('Just Checking') || html.includes('Before we continue')) {
      console.log('    Mobile UA blocked, skipping data API');
      return null;
    }

    // Extract buildId from __NEXT_DATA__
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) {
      console.log('    No __NEXT_DATA__ found');
      return null;
    }

    const nextData = JSON.parse(nextDataMatch[1]);
    const buildId = nextData.buildId;
    console.log(`    buildId: ${buildId}`);

    // Try fetching the JSON data endpoint directly
    if (buildId) {
      const dataUrl = `https://www.roomandboard.com/_next/data/${buildId}/clearance/living/sofas-and-loveseats.json`;
      console.log(`    Fetching data API: ${dataUrl}`);
      const dataResp = await fetch(dataUrl, {
        headers: {
          'User-Agent': MOBILE_UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (dataResp.ok) {
        const json = await dataResp.json();
        console.log(`    Data API returned ${JSON.stringify(json).length} bytes`);
        const products = extractProductsFromJson(json);
        if (products.length > 0) {
          console.log(`    Extracted ${products.length} products from data API`);
          return products;
        }
      } else {
        console.log(`    Data API returned ${dataResp.status}`);
      }
    }

    // Fall back to parsing __NEXT_DATA__ from the HTML
    const products = extractProductsFromNextData(nextData);
    if (products.length > 0) {
      console.log(`    Extracted ${products.length} products from __NEXT_DATA__`);
      return products;
    }

    console.log('    Could not extract products from __NEXT_DATA__, trying HTML parse...');
    return parseHtmlProducts(html);
  } catch (err) {
    console.log(`    Error: ${err.message}`);
    return null;
  }
}

// Recursively search JSON for product-like data
function extractProductsFromJson(obj) {
  const products = [];
  findProducts(obj, products, '');
  return deduplicateProducts(products);
}

function extractProductsFromNextData(nextData) {
  const products = [];
  const pageProps = nextData?.props?.pageProps;
  if (!pageProps) {
    console.log('    No pageProps in __NEXT_DATA__');
    logStructure(nextData, '    ', 2);
    return products;
  }

  console.log('    pageProps keys:', Object.keys(pageProps).join(', '));

  // Deep-inspect clearanceData which is where products live
  const cd = pageProps.clearanceData;
  if (cd) {
    console.log('    clearanceData keys:', Object.keys(cd).join(', '));
    logStructure(cd, '      ', 4);

    // Try document.items, document.products, or any array inside clearanceData
    const doc = cd.document || cd;
    if (doc && typeof doc === 'object') {
      for (const [key, val] of Object.entries(doc)) {
        if (Array.isArray(val) && val.length > 0) {
          console.log(`    clearanceData.document.${key}: array[${val.length}]`);
          if (typeof val[0] === 'object' && val[0] !== null) {
            console.log(`      [0] keys: ${Object.keys(val[0]).join(', ')}`);
            console.log(`      [0] sample: ${JSON.stringify(val[0]).substring(0, 500)}`);
          }
        }
      }
    }
  }

  findProducts(pageProps, products, 'pageProps');
  return deduplicateProducts(products);
}

function findProducts(obj, products, path, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    // Check if this is an array of product-like objects
    const productLike = obj.filter(item =>
      item && typeof item === 'object' &&
      (item.name || item.title || item.productName || item.displayName) &&
      (item.price || item.salePrice || item.clearancePrice || item.prices || item.pricing)
    );

    if (productLike.length > 0) {
      console.log(`    Found ${productLike.length} product-like items at ${path}`);
      for (const item of productLike) {
        const name = item.name || item.title || item.productName || item.displayName || '';
        const price = extractPrice(item);
        const originalPrice = extractOriginalPrice(item);
        const url = extractUrl(item);
        const stock = extractStock(item);
        const sku = item.sku || item.id || item.productId || '';

        if (name) {
          products.push({ name, price, originalPrice, url, stockInfo: stock, sku, source: 'next-data' });
        }
      }
      return;
    }

    // Check if it's an array of items with nested product data
    for (let i = 0; i < Math.min(obj.length, 50); i++) {
      findProducts(obj[i], products, `${path}[${i}]`, depth + 1);
    }
    return;
  }

  // Check if this individual object looks like a product
  if (isProductLike(obj)) {
    const name = obj.name || obj.title || obj.productName || obj.displayName || '';
    const price = extractPrice(obj);
    const originalPrice = extractOriginalPrice(obj);
    const url = extractUrl(obj);
    const stock = extractStock(obj);
    const sku = obj.sku || obj.id || obj.productId || '';

    if (name) {
      products.push({ name, price, originalPrice, url, stockInfo: stock, sku, source: 'next-data' });
    }
  }

  // Recurse into child properties
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'object' && val !== null) {
      findProducts(val, products, `${path}.${key}`, depth + 1);
    }
  }
}

function isProductLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const hasName = !!(obj.name || obj.title || obj.productName || obj.displayName);
  const hasPrice = !!(obj.price || obj.salePrice || obj.clearancePrice || obj.prices || obj.pricing ||
                      obj.regularPrice || obj.retailPrice);
  return hasName && hasPrice;
}

function extractPrice(item) {
  if (typeof item.price === 'string') return item.price;
  if (typeof item.price === 'number') return `$${item.price}`;
  if (item.salePrice) return typeof item.salePrice === 'number' ? `$${item.salePrice}` : String(item.salePrice);
  if (item.clearancePrice) return typeof item.clearancePrice === 'number' ? `$${item.clearancePrice}` : String(item.clearancePrice);
  if (item.prices?.sale) return typeof item.prices.sale === 'number' ? `$${item.prices.sale}` : String(item.prices.sale);
  if (item.prices?.clearance) return typeof item.prices.clearance === 'number' ? `$${item.prices.clearance}` : String(item.prices.clearance);
  if (item.pricing?.sale) return typeof item.pricing.sale === 'number' ? `$${item.pricing.sale}` : String(item.pricing.sale);
  if (typeof item.price === 'object' && item.price?.amount) return `$${item.price.amount}`;
  return '';
}

function extractOriginalPrice(item) {
  if (item.originalPrice) return typeof item.originalPrice === 'number' ? `$${item.originalPrice}` : String(item.originalPrice);
  if (item.regularPrice) return typeof item.regularPrice === 'number' ? `$${item.regularPrice}` : String(item.regularPrice);
  if (item.retailPrice) return typeof item.retailPrice === 'number' ? `$${item.retailPrice}` : String(item.retailPrice);
  if (item.prices?.regular) return typeof item.prices.regular === 'number' ? `$${item.prices.regular}` : String(item.prices.regular);
  if (item.prices?.retail) return typeof item.prices.retail === 'number' ? `$${item.prices.retail}` : String(item.prices.retail);
  if (item.pricing?.regular) return typeof item.pricing.regular === 'number' ? `$${item.pricing.regular}` : String(item.pricing.regular);
  return '';
}

function extractUrl(item) {
  if (item.url) return item.url.startsWith('http') ? item.url : `https://www.roomandboard.com${item.url}`;
  if (item.href) return item.href.startsWith('http') ? item.href : `https://www.roomandboard.com${item.href}`;
  if (item.link) return item.link.startsWith('http') ? item.link : `https://www.roomandboard.com${item.link}`;
  if (item.slug) return `https://www.roomandboard.com${item.slug.startsWith('/') ? '' : '/'}${item.slug}`;
  if (item.pdpUrl) return item.pdpUrl.startsWith('http') ? item.pdpUrl : `https://www.roomandboard.com${item.pdpUrl}`;
  return '';
}

function extractStock(item) {
  const parts = [];
  if (item.stockLevel !== undefined) parts.push(`Stock: ${item.stockLevel}`);
  if (item.stockStatus) parts.push(item.stockStatus);
  if (item.availability) parts.push(item.availability);
  if (item.inStock !== undefined) parts.push(item.inStock ? 'In Stock' : 'Out of Stock');
  if (item.inventory !== undefined) {
    if (typeof item.inventory === 'number') parts.push(`${item.inventory} available`);
    else if (typeof item.inventory === 'object') {
      if (item.inventory.quantity !== undefined) parts.push(`${item.inventory.quantity} available`);
      if (item.inventory.status) parts.push(item.inventory.status);
    }
  }
  if (item.quantityAvailable !== undefined) parts.push(`${item.quantityAvailable} available`);
  if (item.qty !== undefined) parts.push(`${item.qty} available`);
  return parts.join(' | ');
}

function deduplicateProducts(products) {
  const seen = new Set();
  return products.filter(p => {
    const key = p.name + (p.sku || '') + (p.url || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function logStructure(obj, indent = '', maxDepth = 3, depth = 0) {
  if (depth >= maxDepth || !obj || typeof obj !== 'object') return;
  const entries = Object.entries(obj);
  for (const [k, v] of entries.slice(0, 15)) {
    if (Array.isArray(v)) {
      console.log(`${indent}${k}: array[${v.length}]`);
      if (v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
        console.log(`${indent}  [0] keys: ${Object.keys(v[0]).slice(0, 12).join(', ')}`);
      }
    } else if (typeof v === 'object' && v !== null) {
      console.log(`${indent}${k}: {${Object.keys(v).slice(0, 8).join(', ')}}`);
      logStructure(v, indent + '  ', maxDepth, depth + 1);
    } else {
      console.log(`${indent}${k}: ${typeof v} = ${String(v).substring(0, 80)}`);
    }
  }
}

// ─── Strategy 2: Direct HTML parse with broader selectors ───

function parseHtmlProducts(html) {
  const $ = cheerio.load(html);
  const products = [];

  // Strategy A: Parse clearance-item cards (known to match 10 elements)
  const cardSelectors = [
    '[class*="clearance-item"]', '[class*="ClearanceItem"]',
    '[data-testid*="product"]', '[data-testid*="Product"]',
    '[class*="ProductCard"]', '[class*="product-card"]',
    '[class*="ProductTile"]', '[class*="product-tile"]',
  ];

  for (const sel of cardSelectors) {
    const cards = $(sel);
    if (cards.length > 0) {
      console.log(`    Found ${cards.length} elements matching: ${sel}`);

      // Log the first card's full HTML structure for debugging
      if (cards.length > 0) {
        const firstCard = $(cards[0]);
        console.log(`    First card inner HTML (500 chars): ${firstCard.html()?.substring(0, 500)}`);
        console.log(`    First card classes: ${firstCard.attr('class')}`);
      }

      cards.each((_, el) => {
        const card = $(el);
        // Extract name from various selectors
        const name = (
          card.find('h2, h3, h4').first().text().trim() ||
          card.find('[class*="name"], [class*="Name"], [class*="title"], [class*="Title"]').first().text().trim() ||
          card.find('a').first().text().trim()
        ).replace(/\s+/g, ' ');

        const link = card.find('a').first().attr('href') || '';
        const fullUrl = link.startsWith('http') ? link : link ? `https://www.roomandboard.com${link}` : '';

        // Extract all price-related text
        const allText = card.text().replace(/\s+/g, ' ').trim();
        const priceMatches = allText.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
        let price = '', originalPrice = '';
        if (priceMatches.length >= 2) {
          originalPrice = priceMatches[0];
          price = priceMatches[1];
        } else if (priceMatches.length === 1) {
          price = priceMatches[0];
        }

        // Extract stock/quantity info
        let stockInfo = '';
        const qtyMatch = allText.match(/(\d+)\s*(left|available|remaining|in stock)/i);
        if (qtyMatch) stockInfo = `${qtyMatch[1]} ${qtyMatch[2]}`;
        const onlyMatch = allText.match(/only\s+(\d+)/i);
        if (onlyMatch && !stockInfo) stockInfo = `Only ${onlyMatch[1]} left`;

        if (name && name.length > 5 && fullUrl.includes('/clearance/')) {
          products.push({
            name: name.substring(0, 200), url: fullUrl,
            price, originalPrice, stockInfo,
            source: 'html-cards',
          });
        }
      });
      if (products.length > 0) break;
    }
  }

  // Strategy B: If no cards found, try product links (filter out nav)
  if (products.length === 0) {
    $('a[href*="/clearance/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      // Only include links that look like individual products (deep paths)
      // e.g. /clearance/living/sofas-and-loveseats/clemens-66-armless-loveseat-...
      if (href.split('/').filter(Boolean).length < 5) return;
      const fullUrl = href.startsWith('http') ? href : `https://www.roomandboard.com${href}`;
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text.length > 5 && !products.some(p => p.url === fullUrl)) {
        // Try to get price from parent or sibling elements
        const parent = $(el).parent();
        const parentText = parent.text().replace(/\s+/g, ' ');
        const priceMatches = parentText.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
        let price = priceMatches.length > 0 ? priceMatches[priceMatches.length - 1] : '';

        products.push({ name: text.substring(0, 200), url: fullUrl, price, source: 'html-links' });
      }
    });
  }

  if (products.length === 0) {
    const allClasses = new Set();
    $('[class]').each((_, el) => {
      const cls = $(el).attr('class');
      if (cls) cls.split(/\s+/).forEach(c => { if (c.length > 3) allClasses.add(c); });
    });
    const relevant = [...allClasses].filter(c =>
      /product|item|card|tile|grid|sofa|clearance|price|stock/i.test(c)
    ).sort();
    if (relevant.length > 0) {
      console.log(`    Relevant CSS classes found: ${relevant.slice(0, 30).join(', ')}`);
    }
  }

  return products.length > 0 ? products : null;
}

// ─── Strategy 3: Room & Board internal API discovery ───

async function tryInternalApis() {
  console.log('  Strategy 3: Internal API discovery...');

  const apiPaths = [
    '/api/clearance/living/sofas-and-loveseats',
    '/api/products/clearance/living/sofas-and-loveseats',
    '/api/catalog/clearance/living/sofas-and-loveseats',
    '/api/v1/products?category=clearance-living-sofas',
    '/api/search?category=clearance&subcategory=sofas',
    '/graphql',
  ];

  for (const apiPath of apiPaths) {
    try {
      const url = `https://www.roomandboard.com${apiPath}`;
      const isGraphQL = apiPath === '/graphql';

      const opts = {
        method: isGraphQL ? 'POST' : 'GET',
        headers: {
          'User-Agent': MOBILE_UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      };

      if (isGraphQL) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify({
          query: `{ products(category: "clearance/living/sofas-and-loveseats") { name price url } }`,
        });
      }

      const resp = await fetch(url, opts);
      const contentType = resp.headers.get('content-type') || '';

      if (resp.ok && contentType.includes('json')) {
        const data = await resp.json();
        console.log(`    ${apiPath}: 200 JSON (${JSON.stringify(data).length} bytes)`);
        const products = extractProductsFromJson(data);
        if (products.length > 0) {
          console.log(`    Found ${products.length} products from API`);
          return products;
        }
      } else if (resp.status !== 404 && resp.status !== 403) {
        console.log(`    ${apiPath}: ${resp.status} ${contentType}`);
      }
    } catch {}
  }

  return null;
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
      if (p.canAddToCart !== null && p.canAddToCart !== undefined) parts.push(p.canAddToCart ? 'Can add to cart' : 'Cannot add to cart');
      if (p.qtyFromText !== null && p.qtyFromText !== undefined) parts.push(`${p.qtyFromText} available`);
      if (p.sku) parts.push(`SKU: ${p.sku}`);
      if (p.source) parts.push(`via ${p.source}`);
      stockDisplay = parts.length > 0 ? parts.join(' &bull; ') : '<span style="color:#7f8c8d">No stock info found</span>';
    }
    const priceDisplay = p.price || p.listingPrice || 'N/A';
    const origPrice = p.originalPrice ? `<del style="color:#95a5a6">${p.originalPrice}</del> ` : '';
    const nameHtml = p.url ? `<a href="${p.url}" style="color:#2980b9;text-decoration:none;font-weight:600">${p.name || 'Unknown'}</a>` : (p.name || 'Unknown');
    return `<tr style="border-bottom:1px solid #ecf0f1">
        <td style="padding:12px 8px;vertical-align:top">${nameHtml}</td>
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
      <h2 style="color:#c0392b;border-bottom:2px solid #e74c3c;padding-bottom:8px">Room & Board — Bot Detection</h2>
      <p style="color:#7f8c8d;font-size:14px">Checked at ${timestamp}</p>
      <p>All strategies failed. Strategies tried: Next.js data API, HTML parsing, internal API discovery.</p>
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
    subject = `Clearance Sofas: Blocked — ${timestamp}`;
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
    // Strategy 1: Next.js data API / __NEXT_DATA__ (fastest, most reliable)
    let result = await tryNextDataApi();
    if (result && Array.isArray(result) && result.length > 0) {
      console.log(`  Strategy 1 succeeded: ${result.length} product(s)`);
    } else {
      // Strategy 3: Try internal APIs
      console.log('  Strategy 1 found nothing, trying internal APIs...');
      result = await tryInternalApis();
      if (result && Array.isArray(result) && result.length > 0) {
        console.log(`  Strategy 3 succeeded: ${result.length} product(s)`);
      }
    }

    if (!result || (Array.isArray(result) && result.length === 0)) {
      console.log('  No products found through any strategy');
      result = [];
    }

    if (result && result.blocked) {
      console.log('  All strategies failed — blocked');
    } else if (Array.isArray(result)) {
      console.log(`  Found ${result.length} product(s)`);
      result.forEach(p => {
        const stock = p.stockInfo || 'no stock info';
        console.log(`    - ${p.name || 'Unknown'}: ${p.price || 'N/A'} [${stock}] ${p.source || ''}`);
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
