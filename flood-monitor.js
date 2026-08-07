require('dotenv').config();
const nodemailer = require('nodemailer');

const USGS_SITE = '09405500';
const USGS_SITE_NAME = 'North Fork Virgin River near Springdale, UT';
const USGS_API = 'https://waterservices.usgs.gov/nwis/iv/';
const NWS_ALERTS_API = 'https://api.weather.gov/alerts/active';
const NWS_POINTS_API = 'https://api.weather.gov/points';
const NARROWS_LAT = 37.2853;
const NARROWS_LON = -112.9477;
const NWS_UA = 'ZionNarrowsFloodMonitor/1.0 (zselby@gmail.com)';

const INTERVAL_MS = 60 * 60 * 1000;

const FLOW_THRESHOLDS = [
  { max: 50, level: 'LOW', emoji: '🟢', desc: 'Normal conditions — Narrows hiking generally safe' },
  { max: 150, level: 'MODERATE', emoji: '🟡', desc: 'Elevated flow — exercise caution, check with rangers' },
  { max: 300, level: 'HIGH', emoji: '🟠', desc: 'Dangerous conditions — Narrows likely closed' },
  { max: Infinity, level: 'EXTREME', emoji: '🔴', desc: 'Flash flood conditions — stay out of all canyons' },
];

async function fetchJSON(url, headers = {}) {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': NWS_UA, ...headers },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} from ${url}`);
  return resp.json();
}

async function getUSGSData() {
  const params = new URLSearchParams({
    format: 'json',
    sites: USGS_SITE,
    parameterCd: '00060,00065',
    siteStatus: 'active',
  });
  const data = await fetchJSON(`${USGS_API}?${params}`);
  const series = data?.value?.timeSeries || [];
  const result = {};

  for (const ts of series) {
    const param = ts.variable?.variableCode?.[0]?.value;
    const values = ts.values?.[0]?.value || [];
    const latest = values[values.length - 1];
    const val = parseFloat(latest?.value);

    if (param === '00060') {
      result.flow = isNaN(val) ? null : val;
      result.flowTime = latest?.dateTime;
      const recent = values.slice(-6).map(v => parseFloat(v.value)).filter(v => !isNaN(v));
      if (recent.length >= 2) {
        const change = ((recent[recent.length - 1] - recent[0]) / recent[0]) * 100;
        result.flowTrend = change > 10 ? 'RISING' : change < -10 ? 'FALLING' : 'STABLE';
        result.flowChangePct = change;
      }
    } else if (param === '00065') {
      result.gageHeight = isNaN(val) ? null : val;
    }
  }
  return result;
}

async function getNWSAlerts() {
  try {
    const data = await fetchJSON(`${NWS_ALERTS_API}?point=${NARROWS_LAT},${NARROWS_LON}`);
    return (data?.features || []).map(f => ({
      event: f.properties?.event,
      severity: f.properties?.severity,
      headline: f.properties?.headline,
      expires: f.properties?.expires,
    }));
  } catch (err) {
    console.error('  NWS alerts fetch failed:', err.message);
    return [];
  }
}

async function getForecast() {
  try {
    const points = await fetchJSON(`${NWS_POINTS_API}/${NARROWS_LAT},${NARROWS_LON}`);
    const url = points?.properties?.forecast;
    if (!url) return [];
    const data = await fetchJSON(url);
    return (data?.properties?.periods || []).slice(0, 4).map(p => ({
      name: p.name,
      temp: p.temperature,
      unit: p.temperatureUnit,
      wind: p.windSpeed,
      short: p.shortForecast,
      precip: p.probabilityOfPrecipitation?.value,
    }));
  } catch (err) {
    console.error('  NWS forecast fetch failed:', err.message);
    return [];
  }
}

function assessRisk(usgs, alerts) {
  const flow = usgs.flow;
  if (flow == null) return { level: 'UNKNOWN', emoji: '⚪', reasons: ['Flow data unavailable'] };

  const threshold = FLOW_THRESHOLDS.find(t => flow < t.max);
  let level = threshold.level;
  let emoji = threshold.emoji;
  const reasons = [`Flow: ${flow} CFS — ${threshold.desc}`];

  if (usgs.flowTrend === 'RISING' && usgs.flowChangePct > 25) {
    if (level === 'LOW') { level = 'MODERATE'; emoji = '🟡'; }
    else if (level === 'MODERATE') { level = 'HIGH'; emoji = '🟠'; }
    reasons.push(`Flow rising rapidly (+${usgs.flowChangePct.toFixed(0)}%)`);
  }

  const floodAlerts = alerts.filter(a => /flood|flash/i.test(a.event));
  if (floodAlerts.length > 0) {
    if (level === 'LOW' || level === 'MODERATE') { level = 'HIGH'; emoji = '🟠'; }
    floodAlerts.forEach(a => reasons.push(`Active: ${a.event}`));
  }

  return { level, emoji, reasons };
}

function formatText(usgs, alerts, forecast, risk) {
  const time = usgs.flowTime
    ? new Date(usgs.flowTime).toLocaleString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', hour12: true })
    : '?';
  const trend = usgs.flowTrend || '';
  const trendArrow = trend === 'RISING' ? '↑' : trend === 'FALLING' ? '↓' : '→';

  const lines = [
    `${risk.emoji} ZION NARROWS — ${risk.level} RISK`,
    ``,
    `Flow: ${usgs.flow ?? '?'} CFS ${trendArrow} | Gage: ${usgs.gageHeight ?? '?'} ft`,
    `As of ${time} MDT`,
  ];

  if (alerts.length > 0) {
    lines.push('');
    alerts.forEach(a => lines.push(`⚠️ ${a.event}: ${a.headline || ''}`));
  }

  if (forecast.length > 0) {
    lines.push('');
    forecast.forEach(p => {
      const precip = p.precip != null ? ` (${p.precip}% rain)` : '';
      lines.push(`${p.name}: ${p.short}${precip}`);
    });
  }

  const rec = {
    LOW: '✅ Conditions look good for the Narrows. Check with rangers before entering.',
    MODERATE: '⚠️ Use caution. Monitor conditions and be prepared to exit quickly.',
    HIGH: '🚫 DO NOT enter the Narrows. Dangerous conditions.',
    EXTREME: '🚫 STAY OUT of all slot canyons. Life-threatening conditions.',
    UNKNOWN: '❓ Unable to assess — check NPS.gov or call the visitor center.',
  };
  lines.push('', rec[risk.level]);

  return lines.join('\n');
}

function formatEmailHtml(usgs, alerts, forecast, risk, timestamp) {
  const trendArrow = usgs.flowTrend === 'RISING' ? '&#8593;' : usgs.flowTrend === 'FALLING' ? '&#8595;' : '&#8594;';
  const riskColors = { LOW: '#27ae60', MODERATE: '#f39c12', HIGH: '#e67e22', EXTREME: '#e74c3c', UNKNOWN: '#95a5a6' };
  const riskColor = riskColors[risk.level] || '#95a5a6';

  let alertsHtml = '<p style="color:#7f8c8d">None</p>';
  if (alerts.length > 0) {
    alertsHtml = alerts.map(a =>
      `<div style="background:#fdf2e9;border-left:4px solid #e67e22;padding:8px 12px;margin:6px 0;border-radius:2px">
        <strong>${a.event}</strong><br><span style="font-size:13px;color:#666">${a.headline || ''}</span>
      </div>`
    ).join('');
  }

  let forecastHtml = '';
  if (forecast.length > 0) {
    const rows = forecast.map(p => {
      const precip = p.precip != null ? `<span style="color:#3498db">${p.precip}%</span>` : '—';
      return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${p.name}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${p.short}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center">${precip}</td></tr>`;
    }).join('');
    forecastHtml = `<h3 style="color:#2c3e50;margin-top:20px">Forecast</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#f8f9fa"><th style="padding:6px 8px;text-align:left">Period</th>
        <th style="padding:6px 8px;text-align:left">Conditions</th>
        <th style="padding:6px 8px;text-align:center">Precip</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
  }

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:${riskColor};color:#fff;padding:16px 20px;border-radius:6px 6px 0 0">
      <h2 style="margin:0;font-size:20px">${risk.emoji} Zion Narrows — ${risk.level} Risk</h2>
      <p style="margin:4px 0 0;opacity:0.9;font-size:14px">${timestamp}</p>
    </div>
    <div style="border:1px solid #dee2e6;border-top:none;padding:20px;border-radius:0 0 6px 6px">
      <div style="display:flex;gap:30px;margin-bottom:16px">
        <div><div style="font-size:12px;color:#7f8c8d;text-transform:uppercase;letter-spacing:1px">Flow</div>
          <div style="font-size:28px;font-weight:700">${usgs.flow ?? '?'} <span style="font-size:14px;font-weight:400">CFS</span> ${trendArrow}</div></div>
        <div><div style="font-size:12px;color:#7f8c8d;text-transform:uppercase;letter-spacing:1px">Gage Height</div>
          <div style="font-size:28px;font-weight:700">${usgs.gageHeight ?? '?'} <span style="font-size:14px;font-weight:400">ft</span></div></div>
      </div>
      <h3 style="color:#2c3e50;margin-top:16px">Weather Alerts</h3>
      ${alertsHtml}
      ${forecastHtml}
      <div style="margin-top:20px;padding:12px 16px;background:#f8f9fa;border-radius:4px;font-size:14px">
        ${risk.reasons.map(r => `<div style="margin:4px 0">• ${r}</div>`).join('')}
      </div>
      <p style="color:#95a5a6;font-size:12px;margin-top:16px">
        Data: USGS site ${USGS_SITE} &bull; NWS alerts &bull; Next check in 1 hour
      </p>
    </div>
  </div>`;
}

async function sendEmail(usgs, alerts, forecast, risk) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Denver' });
  const subject = `${risk.emoji} Narrows ${risk.level}: ${usgs.flow ?? '?'} CFS — ${timestamp}`;
  const text = formatText(usgs, alerts, forecast, risk);
  const html = formatEmailHtml(usgs, alerts, forecast, risk, timestamp);

  const info = await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
    subject,
    text,
    html,
  });
  console.log(`  Email sent: ${info.messageId}`);
}

async function run() {
  const now = new Date().toISOString();
  console.log(`\n[${now}] Checking Zion Narrows flood conditions...`);

  try {
    const [usgs, alerts, forecast] = await Promise.all([
      getUSGSData(),
      getNWSAlerts(),
      getForecast(),
    ]);

    const risk = assessRisk(usgs, alerts);
    const report = formatText(usgs, alerts, forecast, risk);

    console.log('\n' + report);

    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      await sendEmail(usgs, alerts, forecast, risk);
    } else {
      console.log('\n  [SKIP] Email not configured (set SMTP_USER and SMTP_PASS)');
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    console.error(err.stack);
  }
}

async function main() {
  const once = process.argv.includes('--once');
  console.log('Zion Narrows Flood Monitor');
  console.log(`USGS Site: ${USGS_SITE} (${USGS_SITE_NAME})`);
  console.log(`Mode: ${once ? 'single check' : 'every 60 minutes'}`);

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
