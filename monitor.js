require('dotenv').config();
const nodemailer = require('nodemailer');

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

function extractProductsFromNextData(nextData) {
  const productGroups = nextData?.props?.pageProps?.clearanceData?.document?.productGroups;
  if (!Array.isArray(productGroups) || productGroups.length === 0) {
    console.log('    No productGroups found in __NEXT_DATA__');
    return [];
  }

  console.log(`    Found ${productGroups.length} products in productGroups`);
  return productGroups.map(p => ({
    name: p.name || '',
    price: p.priceRange || '',
    originalPrice: p.wasPriceString || '',
    url: `https://www.roomandboard.com/clearance/living/sofas-and-loveseats/${p.url || p.articleNumber}`,
    stockInfo: p.status?.status || '',
    sku: p.articleNumber || '',
  })).filter(p => {
    if (!p.name) return false;
    const priceNum = parseFloat(p.price.replace(/[$,]/g, ''));
    return isNaN(priceNum) || priceNum < 2000;
  });
}

async function fetchProducts() {
  console.log('  Fetching page with mobile UA...');
  const resp = await fetch(TARGET_URL, {
    headers: {
      'User-Agent': MOBILE_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  const html = await resp.text();
  console.log(`    Response: ${resp.status}, ${html.length} bytes`);

  if (html.includes('Press & Hold') || html.includes('Just Checking') || html.includes('Before we continue')) {
    console.log('    Bot detection triggered');
    return { blocked: true, bodyPreview: html.substring(0, 500) };
  }

  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nextDataMatch) {
    console.log('    No __NEXT_DATA__ found in page');
    return [];
  }

  const nextData = JSON.parse(nextDataMatch[1]);
  return extractProductsFromNextData(nextData);
}

function formatEmailHtml(products, timestamp) {
  const rows = products.map(p => {
    const stockDisplay = p.stockInfo || '<span style="color:#7f8c8d">—</span>';
    const priceDisplay = p.price || 'N/A';
    const origPrice = p.originalPrice ? `<del style="color:#95a5a6">${p.originalPrice}</del> ` : '';
    const nameHtml = `<a href="${p.url}" style="color:#2980b9;text-decoration:none;font-weight:600">${p.name}</a>`;
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
      <p style="color:#95a5a6;font-size:12px;margin-top:20px"><a href="${TARGET_URL}" style="color:#3498db">View on Room & Board</a> &bull; Next check in 1 hour</p>
    </div>`;
}

async function sendEmail(result) {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'America/Chicago' });
  let subject, html;

  if (result && result.blocked) {
    subject = `Clearance Sofas: Blocked — ${timestamp}`;
    html = `<p>Bot detection triggered. Will retry on next scheduled run.</p>`;
  } else {
    const products = Array.isArray(result) ? result : [];
    subject = `Clearance Sofas: ${products.length} items — ${timestamp}`;
    html = formatEmailHtml(products, timestamp);
  }

  const info = await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
    subject,
    html,
  });
  console.log(`  Email sent: ${info.messageId}`);
}

async function run() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Checking Room & Board clearance sofas...`);

  try {
    const result = await fetchProducts();

    if (result && result.blocked) {
      console.log('  Blocked by bot detection');
    } else if (Array.isArray(result)) {
      console.log(`  Found ${result.length} product(s)`);
      result.forEach(p => {
        console.log(`    - ${p.name}: ${p.price || 'N/A'} [${p.stockInfo || 'no status'}]`);
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
