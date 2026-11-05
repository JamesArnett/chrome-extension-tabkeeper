// Renders Chrome Web Store assets with headless Chrome: the small promo tile
// (440x280), the marquee tile (1400x560) and a 1280x800 screenshot of the popup
// with fictional sample rules. Output goes to store/.
//
//   CHROME="/path/to/Google Chrome for Testing" node scripts/make-promo.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME;
if (!CHROME) {
  console.error('Set CHROME to a Chrome for Testing / Chromium binary.');
  process.exit(2);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store');
mkdirSync(OUT, { recursive: true });
const PORT = 9400 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BLUE = '#1A5FD6';
const INK = '#1F2328';
const MUTED = '#57606A';
const PAPER = '#F6F8FA';

/** The icon mark as inline SVG, same geometry as scripts/make-icons.mjs (unit square scaled). */
function mark(size) {
  const s = size;
  const r = 0.22 * s;
  const baseY = 0.68 * s;
  const baseH = 0.085 * s;
  const tabH = 0.3 * s;
  const front = { x: 0.21 * s, y: baseY - tabH, w: 0.36 * s, r: 0.07 * s };
  const back = { x: 0.46 * s, y: baseY - tabH + 0.05 * s, w: 0.33 * s, r: 0.06 * s };
  const tabPath = (t) =>
    `M${t.x} ${baseY} V${t.y + t.r} Q${t.x} ${t.y} ${t.x + t.r} ${t.y} H${t.x + t.w - t.r} Q${t.x + t.w} ${t.y} ${t.x + t.w} ${t.y + t.r} V${baseY} Z`;
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${s}" height="${s}" rx="${r}" fill="${BLUE}"/>
    <path d="${tabPath(back)}" fill="#fff" fill-opacity="0.55"/>
    <path d="${tabPath(front)}" fill="#fff"/>
    <rect x="${0.16 * s}" y="${baseY}" width="${0.68 * s}" height="${baseH}" rx="${baseH / 2}" fill="#fff"/>
  </svg>`;
}

const ICONS = {
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7"/></svg>`,
  group: `<svg viewBox="0 0 24 24" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a2 2 0 0 1 2-2h6l2 2h8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M7 7V5a2 2 0 0 1 2-2h5l2 2h5v6"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9a4.5 4.5 0 0 1 .5 9z"/></svg>`,
};

const base = (body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:${PAPER};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:${INK};-webkit-font-smoothing:antialiased}
  .wrap{display:flex;align-items:center;height:100%;box-sizing:border-box}
  h1{margin:0;font-weight:800;letter-spacing:-0.02em;line-height:1}
  p{margin:0;color:${MUTED};font-weight:400}
  .features{display:flex;gap:0}
  .feature{display:flex;align-items:center;gap:16px;padding:0 36px;border-left:1px solid #D0D7DE}
  .feature:first-child{border-left:none;padding-left:0}
  .feature svg{width:44px;height:44px;flex:none}
  .feature div{font-weight:700;font-size:22px;line-height:1.2}
  ${extra}</style></head><body>${body}</body></html>`;

const smallTile = base(`
  <div class="wrap" style="width:440px;height:280px;padding:0 36px;gap:28px">
    ${mark(132)}
    <div><h1 style="font-size:48px">Tabkeeper</h1><p style="font-size:17px;margin-top:10px">Tabs that take care of themselves.</p></div>
  </div>`);

const marqueeTile = base(`
  <div class="wrap" style="width:1400px;height:560px;padding:0 90px;flex-direction:column;align-items:stretch;justify-content:center;gap:60px">
    <div style="display:flex;align-items:center;gap:44px">
      ${mark(200)}
      <div><h1 style="font-size:104px">Tabkeeper</h1><p style="font-size:36px;margin-top:14px">Tabs that take care of themselves.</p></div>
    </div>
    <div class="features">
      <div class="feature">${ICONS.trash}<div>Auto-close<br>leftover tabs</div></div>
      <div class="feature">${ICONS.group}<div>Group by rule<br>with live status</div></div>
      <div class="feature">${ICONS.cloud}<div>AWS Console<br>by account &amp; role</div></div>
    </div>
  </div>`);

// ---- CDP plumbing ----
class CDP {
  constructor(ws, origin) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      if (ev.origin !== origin) return;
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new CDP(ws, new URL(url).origin);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(sessionId, expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed');
    return result.value;
  }
}

async function waitFor(fn, { timeout = 10_000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('timeout');
    await sleep(interval);
  }
}

const userDataDir = mkdtempSync(join(tmpdir(), 'tabkeeper-promo-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--use-mock-keychain', '--password-store=basic', '--hide-scrollbars',
    `--user-data-dir=${userDataDir}`, `--load-extension=${ROOT}`, `--remote-debugging-port=${PORT}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

async function shoot(cdp, { url, width, height, file, prepare }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  // Headless reports a dark colour scheme; store assets are rendered light.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(600);
  if (prepare) await prepare(sessionId);
  await sleep(300);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  console.log('wrote store/' + file);
}

let exit = 0;
try {
  const version = await waitFor(() => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null));
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  const dataUrl = (html) => 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

  await shoot(cdp, { url: dataUrl(smallTile), width: 440, height: 280, file: 'promo-small-440x280.png' });
  await shoot(cdp, { url: dataUrl(marqueeTile), width: 1400, height: 560, file: 'promo-marquee-1400x560.png' });

  // Popup screenshot with fictional sample data.
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'));
  const extId = new URL(sw.url).host;
  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, swSession);
  await waitFor(() => cdp.eval(swSession, "typeof chrome === 'object'").catch(() => false));
  await cdp.eval(
    swSession,
    `Promise.all([
      chrome.storage.sync.set({
        'rule:a': { id: 'a', name: 'Zoom redirect', enabled: true, title: { mode: 'contains', pattern: 'Launch Meeting - Zoom', caseSensitive: false }, url: null, delaySeconds: 5, createdAt: 1 },
        'rule:b': { id: 'b', name: 'AWS sign-in confirmation', enabled: true, title: null, url: { mode: 'startsWith', pattern: 'https://signin.aws.amazon.com/oauth', caseSensitive: false }, delaySeconds: 10, createdAt: 2 },
        'rule:c': { id: 'c', name: 'Slack redirect', enabled: false, title: { mode: 'startsWith', pattern: 'Slack', caseSensitive: false }, url: { mode: 'contains', pattern: 'slack.com/ssb/redirect', caseSensitive: false }, delaySeconds: 3, createdAt: 3 },
        ruleOrder: ['a', 'b', 'c'],
      }),
      chrome.storage.local.set({ log: [
        { title: 'Launch Meeting - Zoom', url: 'https://example.zoom.us/j/123456789', ruleId: 'a', ruleName: 'Zoom redirect', closedAt: Date.now() - 120000 },
        { title: 'Amazon Web Services Sign-In', url: 'https://signin.aws.amazon.com/oauth?response_type=code', ruleId: 'b', ruleName: 'AWS sign-in confirmation', closedAt: Date.now() - 3600000 },
      ] }),
    ])`,
  );
  await cdp.eval(
    swSession,
    `chrome.storage.sync.set({
      'grule:j': { id: 'j', name: 'Jira issue', enabled: true, regex: '/browse/([A-Z][A-Z0-9_]+-\\\\d+)', titleTemplate: '$1', color: 'blue', randomColor: false, statusEnabled: true,
        statusFields: [{ selector: '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] button, #status-val', keepOnly: '', label: '' }], siteOrigin: 'https://example.atlassian.net', createdAt: 1 },
      'grule:g': { id: 'g', name: 'GitLab merge request', enabled: true, regex: '/([^/]+)/-/merge_requests/(\\\\d+)', titleTemplate: '$1!$2', color: 'orange', randomColor: false, statusEnabled: true,
        statusFields: [{ selector: '.issuable-status-badge .gl-badge-content', keepOnly: '', label: '' }, { selector: '.mr-pipeline-title', keepOnly: '#\\\\d+\\\\s+(\\\\S+)', label: 'CI' }], siteOrigin: 'https://gitlab.example.com', createdAt: 2 },
      groupRuleOrder: ['j', 'g'],
      awsSettings: { enabled: true, fields: { account: true, accountId: false, role: true, user: false, region: false }, separator: ' · ' },
    })`,
  );
  const frame = (view, extraPrep = '') => async (sid) => {
    await waitFor(() => cdp.eval(sid, "document.querySelectorAll('#rule-list li').length > 0"));
    await cdp.eval(sid, `(() => {
      const st = document.createElement('style');
      st.textContent = 'html{background:${PAPER}} body{max-width:760px;margin:28px auto;zoom:1.0;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.14);padding:12px 24px 20px;min-height:0} #stale-banner{display:none!important} #aws-access{display:none!important}';
      document.head.append(st);
      document.getElementById('tab-${view}').click();
      ${extraPrep}
    })()`);
  };
  const optionsUrl = `chrome-extension://${extId}/options/options.html`;
  const popupUrl = `chrome-extension://${extId}/options/options.html?popup=1`;
  await shoot(cdp, { url: optionsUrl, width: 1280, height: 800, file: 'screenshot-1-1280x800.png', prepare: frame('close', "document.getElementById('log-details').open = true;") });
  await shoot(cdp, { url: optionsUrl, width: 1280, height: 800, file: 'screenshot-2-1280x800.png', prepare: frame('group') });
  await shoot(cdp, { url: optionsUrl, width: 1280, height: 800, file: 'screenshot-3-1280x800.png', prepare: frame('aws') });
  // The popup lists only rules matching the current tab: put a Zoom launch page in front first.
  await cdp.eval(swSession, `chrome.tabs.create({ url: 'data:text/html,<title>Launch Meeting - Zoom</title>zoom', active: true })`);
  await sleep(500);
  await shoot(cdp, {
    url: popupUrl,
    width: 1280,
    height: 800,
    file: 'screenshot-4-1280x800.png',
    prepare: async (sid) => {
      await waitFor(() => cdp.eval(sid, "document.querySelectorAll('#rule-list li').length > 0"));
      await cdp.eval(sid, `(() => {
        const st = document.createElement('style');
        st.textContent = 'html{background:${PAPER}} body{margin:40px auto!important;zoom:1.2;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.14)} #stale-banner{display:none!important}';
        document.head.append(st);
        document.getElementById('tab-close').click();
        document.getElementById('auto-close-details').open = true;
      })()`);
    },
  });
} catch (err) {
  exit = 1;
  console.error('promo render failed:', err.message);
} finally {
  chrome.kill('SIGKILL');
  await sleep(200);
  rmSync(userDataDir, { recursive: true, force: true });
  process.exit(exit);
}
