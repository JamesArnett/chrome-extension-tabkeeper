// End-to-end smoke test: launches Chrome (for Testing) headless with the
// extension loaded and drives it over the DevTools protocol. No dependencies.
//
//   CHROME="/path/to/Google Chrome for Testing" node scripts/e2e.mjs
//
// Branded Chrome 137+ ignores --load-extension, so point CHROME at Chrome for
// Testing or Chromium (e.g. npx @puppeteer/browsers install chrome@stable).

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME;
if (!CHROME) {
  console.error('Set CHROME to a Chrome for Testing / Chromium binary.');
  process.exit(2);
}
const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333 + Math.floor(Math.random() * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

class CDP {
  constructor(ws, expectedOrigin) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      // Only accept frames from the DevTools endpoint we connected to.
      if (ev.origin !== expectedOrigin) return;
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
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
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    // Extension API bindings appear slightly after the context is created; wait for them.
    await waitFor(() => this.eval(sessionId, "typeof chrome === 'object'").catch(() => false), {
      timeout: 5000,
      interval: 50,
      label: 'chrome.* bindings in target',
    });
    return sessionId;
  }
  async eval(sessionId, expression) {
    const { result, exceptionDetails } = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? JSON.stringify(exceptionDetails));
    return result.value;
  }
}

async function pageSession(cdp, urlPart) {
  const target = await waitFor(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'page' && t.url.includes(urlPart));
  }, { label: `page target ${urlPart}` });
  return cdp.attach(target.targetId);
}

async function waitFor(fn, { timeout = 10_000, interval = 100, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
}

// Fixture site over HTTPS with a throwaway self-signed certificate (Chrome runs with
// --ignore-certificate-errors). /ticket/<KEY>?status=<text>&delay=<ms> renders #status
// after <delay>. The page derives everything from its own URL client-side; the server
// never interpolates request data into the response.
const certDir = mkdtempSync(join(tmpdir(), 'tac-cert-'));
execFileSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')],
  { stdio: 'ignore' },
);
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Ticket</title></head>
<body><h1 id="key"></h1><div id="holder"></div>
<script>
  const key = (location.pathname.match(/^\\/ticket\\/([A-Z]+-\\d+)$/) || [])[1] || 'unknown';
  document.title = 'Ticket ' + key;
  document.getElementById('key').textContent = key;
  const p = new URLSearchParams(location.search);
  const delay = Number(p.get('delay') || 0);
  const status = p.get('status') || '';
  setTimeout(() => {
    if (!status) return;
    const s = document.createElement('span'); s.id = 'status'; s.textContent = status;
    document.getElementById('holder').append(s);
  }, delay);
</script></body></html>`;
// Fake AWS console nav: /aws?account=<label>&role=<role/user>&delay=<ms>. Rendered client-side.
const AWS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>AWS Console</title></head>
<body><header id="awsc-nav-header"><span>Services</span><span>Search</span></header><main>console</main>
<script>
  const p = new URLSearchParams(location.search);
  const delay = Number(p.get('delay') || 0);
  setTimeout(() => {
    const nav = document.getElementById('awsc-nav-header');
    const acct = document.createElement('span'); acct.className = 'globalNav-2253 freeTierNotOkay'; acct.setAttribute('data-testid', 'account-label');
    acct.textContent = p.get('account') || ''; nav.append(acct);
    if (p.get('role')) { const role = document.createElement('span'); role.className = 'globalNav-2253 freeTierNotOkay globalNav-2246'; role.textContent = p.get('role'); nav.append(role); }
  }, delay);
</script></body></html>`;
const fixture = createServer(
  { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
  (req, res) => {
    if (/^\/aws(\?|$)/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(AWS_HTML);
      return;
    }
    if (!/^\/ticket\/[A-Z]+-\d+(\?|$)/.test(req.url)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  },
);
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const FIXTURE_ORIGIN = `https://127.0.0.1:${fixture.address().port}`;

// Headless Chrome cannot answer a permission prompt, so the test copy of the
// extension pre-grants the fixture origin as a required host permission. The
// shipped manifest keeps host access optional.
const extCopy = mkdtempSync(join(tmpdir(), 'tac-ext-'));
cpSync(EXT_DIR, extCopy, {
  recursive: true,
  filter: (src) => !['node_modules', '.git', 'dist'].includes(basename(src)) && !basename(src).startsWith('.'),
});
cpSync(join(EXT_DIR, 'scripts', 'fixtures', 'security-browser.js'), join(extCopy, 'help', 'security-browser.js'));
{
  const manifest = JSON.parse(readFileSync(join(extCopy, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['https://127.0.0.1/*', 'https://*.console.aws.amazon.com/*'];
  writeFileSync(join(extCopy, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

const userDataDir = mkdtempSync(join(tmpdir(), 'tac-e2e-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--use-mock-keychain',
    '--password-store=basic',
    '--ignore-certificate-errors',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extCopy}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let stderr = '';
chrome.stderr.on('data', (d) => (stderr += d));

let exitCode = 0;
const capturedErrors = [];
try {
  const version = await waitFor(
    () => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null),
    { label: 'DevTools endpoint' },
  );
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  const errors = capturedErrors;
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? 'exception');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  console.log('service worker');
  const worker = await waitFor(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'));
  }, { label: 'extension service worker' });
  const extId = new URL(worker.url).host;
  const sw = await cdp.attach(worker.targetId);
  assert(await cdp.eval(sw, 'typeof chrome.tabs.query'), 'service worker is running');

  console.log('rule setup');
  await cdp.eval(
    sw,
    `chrome.storage.sync.set({
      'rule:e2e': { id: 'e2e', name: 'E2E rule', enabled: true,
        title: { mode: 'contains', pattern: 'e2e-close-me', caseSensitive: false }, url: null,
        delaySeconds: 1, createdAt: Date.now() },
      ruleOrder: ['e2e'],
    })`,
  );
  await sleep(300); // background debounces rule changes by 100 ms

  console.log('matching tab closes');
  const tabId = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: 'data:text/html,<title>e2e-close-me</title>hello', active: false }).then(t => t.id)`,
  );
  await sleep(200);
  const pending = await cdp.eval(sw, `chrome.storage.session.get('pending').then(r => r.pending ?? {})`);
  assert(pending[tabId]?.ruleId === 'e2e', 'tab is pending under the rule');
  await waitFor(
    () => cdp.eval(sw, `chrome.tabs.query({}).then(ts => !ts.some(t => t.id === ${tabId}))`),
    { timeout: 5000, label: 'tab to be closed' },
  );
  assert(true, 'tab was closed after the delay');
  const log = await cdp.eval(sw, `chrome.storage.local.get('log').then(r => r.log ?? [])`);
  assert(log.length === 1 && log[0].ruleId === 'e2e' && log[0].title === 'e2e-close-me', 'close was logged');

  console.log('pinned tab survives');
  const pinnedId = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: 'data:text/html,<title>e2e-close-me pinned</title>x', active: false, pinned: true }).then(t => t.id)`,
  );
  await sleep(2000);
  assert(
    await cdp.eval(sw, `chrome.tabs.query({}).then(ts => ts.some(t => t.id === ${pinnedId}))`),
    'pinned matching tab was not closed',
  );

  console.log('non-matching tab survives');
  const otherId = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: 'data:text/html,<title>unrelated</title>x', active: false }).then(t => t.id)`,
  );
  await sleep(1500);
  assert(await cdp.eval(sw, `chrome.tabs.query({}).then(ts => ts.some(t => t.id === ${otherId}))`), 'unrelated tab untouched');

  console.log('pause');
  await cdp.eval(sw, `chrome.storage.local.set({ paused: true })`);
  await sleep(200);
  const pausedTab = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: 'data:text/html,<title>e2e-close-me paused</title>x', active: false }).then(t => t.id)`,
  );
  await sleep(2000);
  assert(await cdp.eval(sw, `chrome.tabs.query({}).then(ts => ts.some(t => t.id === ${pausedTab}))`), 'no closes while paused');
  await cdp.eval(sw, `chrome.storage.local.set({ paused: false })`);
  await waitFor(
    () => cdp.eval(sw, `chrome.tabs.query({}).then(ts => !ts.some(t => t.id === ${pausedTab}))`),
    { timeout: 5000, label: 'tab closed after unpause rescan' },
  );
  assert(true, 'unpausing rescanned and closed the tab');

  console.log('settings page renders');
  const popupUrl = `chrome-extension://${extId}/options/options.html?popup=1`;
  const optionsUrl = `chrome-extension://${extId}/options/options.html`;
  const open = async (url = optionsUrl, background = false) => {
    const { targetId } = await cdp.send('Target.createTarget', { url, background });
    const session = await cdp.attach(targetId);
    const ready = `document.querySelectorAll('#rule-list li').length > 0`;
    await waitFor(() => cdp.eval(session, ready), { label: `page ready: ${url.split('/').pop()}` });
    return { targetId, session };
  };
  let popup = await open();
  assert(await cdp.eval(popup.session, `document.getElementById('rules-filter-note').hidden`), 'full page lists every rule without a filter note');
  const ruleName = await cdp.eval(popup.session, `document.querySelector('#rule-list li .name').textContent`);
  assert(ruleName.startsWith('E2E rule'), `settings page lists the rule (${ruleName})`);
  assert(
    (await cdp.eval(popup.session, `document.querySelector('#log-count').textContent`)) === '(2)',
    'settings page shows log count',
  );
  assert((await cdp.eval(popup.session, `document.querySelectorAll('#log-list li button').length`)) === 2, 'log entries have Reopen buttons');

  console.log('Help reopens the welcome page with the store banner');
  assert(await cdp.eval(popup.session, `document.getElementById('welcome-guide').textContent === 'Help'`), 'Help is available in the settings header');
  // Close any first-install guide so this checks opening it again from Help.
  const beforeHelp = await cdp.send('Target.getTargets');
  for (const target of beforeHelp.targetInfos) {
    if (target.type === 'page' && target.url === 'chrome-extension://' + extId + '/help/guide.html') {
      await cdp.send('Target.closeTarget', { targetId: target.targetId });
    }
  }
  await cdp.eval(popup.session, `document.getElementById('welcome-guide').click()`);
  const guideTarget = await waitFor(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'page' && t.url === 'chrome-extension://' + extId + '/help/guide.html');
  }, { label: 'welcome page reopened from Help' });
  const guideSession = await cdp.attach(guideTarget.targetId);
  await waitFor(() => cdp.eval(guideSession, `document.querySelector('.welcome-banner')?.naturalWidth === 1400`), { label: 'welcome banner loaded' });
  assert(await cdp.eval(guideSession, `document.body.firstElementChild.classList.contains('welcome-banner')`), 'store banner appears above the welcome instructions');
  assert(await cdp.eval(guideSession, `document.getElementById('privacy').textContent.includes('Chrome Sync') && document.getElementById('privacy').textContent.includes('saved-password store')`), 'bundled privacy explanation covers storage and permission boundaries');
  assert(await cdp.eval(popup.session, `!!document.querySelector('header a[href="../help/guide.html#privacy"]')`), 'privacy details are linked from the settings header');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, guideSession);
  assert(await cdp.eval(guideSession, `document.querySelector('.welcome-banner').getBoundingClientRect().width <= window.innerWidth`), 'banner fits a narrow window');
  await cdp.send('Target.closeTarget', { targetId: guideTarget.targetId });

  console.log('new rule pre-fills from the active tab');
  // Make a page tab active, then open the popup in the background so that page stays active.
  await cdp.eval(
    sw,
    `chrome.tabs.create({ url: 'data:text/html,<title>Prefill Source</title>x', active: true })`,
  );
  await sleep(300);
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  popup = await open(optionsUrl, true);
  await cdp.eval(popup.session, `document.getElementById('add-rule').click()`);
  await waitFor(() => cdp.eval(popup.session, `!document.getElementById('form-section').hidden`), { label: 'form open' });
  const prefName = await cdp.eval(popup.session, `document.getElementById('rule-form').elements.name.value`);
  assert(prefName === 'Prefill Source', `name pre-filled from active tab title (${prefName})`);
  assert(
    (await cdp.eval(popup.session, `document.getElementById('rule-form').elements.titlePattern.value`)) === 'Prefill Source',
    'title condition pre-filled',
  );
  assert(
    (await cdp.eval(popup.session, `document.getElementById('rule-form').elements.urlPattern.value`)) === '',
    'non-http URL (data:) not used for URL condition',
  );
  assert(!(await cdp.eval(popup.session, `document.getElementById('prefill-notice').hidden`)), 'prefill notice shown');
  await cdp.eval(popup.session, `document.getElementById('cancel-rule').click()`);
  await sleep(200);
  // Hidden tabs get their timers throttled to 1 Hz; a real popup is always visible. Foreground it.
  await cdp.send('Target.activateTarget', { targetId: popup.targetId });
  await waitFor(() => cdp.eval(popup.session, `document.visibilityState === 'visible'`), { label: 'popup visible' });

  console.log('draft autosave');
  await cdp.eval(popup.session, `document.getElementById('add-rule').click()`);
  await waitFor(() => cdp.eval(popup.session, `!document.getElementById('form-section').hidden`), { label: 'form open' });
  await cdp.eval(
    popup.session,
    `(() => { const f = document.getElementById('rule-form').elements;
       f.name.value = 'Half typed'; f.name.dispatchEvent(new Event('input', { bubbles: true }));
       f.urlPattern.value = '^https://'; f.urlMode.value = 'regex';
       f.urlPattern.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(500);
  const draftSaved = await cdp.eval(popup.session, `chrome.storage.local.get('draft').then(r => r.draft)`);
  assert(
    draftSaved?.fields?.name === 'Half typed' && draftSaved.editingId === null,
    `draft persisted while typing (got ${JSON.stringify(draftSaved)})`,
  );
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  popup = await open();
  assert(!(await cdp.eval(popup.session, `document.getElementById('form-section').hidden`)), 'form reopened from draft');
  assert(!(await cdp.eval(popup.session, `document.getElementById('draft-notice').hidden`)), 'restore notice shown');
  assert(
    (await cdp.eval(popup.session, `document.getElementById('rule-form').elements.name.value`)) === 'Half typed',
    'draft fields restored',
  );
  assert(
    (await cdp.eval(popup.session, `document.getElementById('rule-form').elements.urlMode.value`)) === 'regex',
    'draft select restored',
  );

  console.log('invalid regex blocks save');
  await cdp.eval(
    popup.session,
    `(() => { const f = document.getElementById('rule-form').elements;
       f.urlPattern.value = '('; f.urlPattern.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  assert(await cdp.eval(popup.session, `document.getElementById('save-rule').disabled`), 'save disabled on bad regex');
  assert(
    (await cdp.eval(popup.session, `document.querySelector('[data-error="url"]').textContent`)).includes('Invalid regex'),
    'regex error shown inline',
  );

  console.log('save rule via form');
  await cdp.eval(
    popup.session,
    `(() => { const f = document.getElementById('rule-form').elements;
       f.urlPattern.value = '^https://signin\\\\.aws'; f.urlPattern.dispatchEvent(new Event('input', { bubbles: true }));
       f.titlePattern.value = ''; f.titlePattern.dispatchEvent(new Event('input', { bubbles: true }));
       f.delay.value = '42'; f.delay.dispatchEvent(new Event('input', { bubbles: true }));
       document.getElementById('rule-form').requestSubmit(); })()`,
  );
  await waitFor(() => cdp.eval(popup.session, `document.querySelectorAll('#rule-list li').length === 2`), { label: 'second rule listed' });
  assert(await cdp.eval(popup.session, `document.getElementById('form-section').hidden`), 'form closed after save');
  assert((await cdp.eval(popup.session, `chrome.storage.local.get('draft').then(r => r.draft ?? null)`)) === null, 'draft cleared after save');
  const saved = await cdp.eval(sw, `chrome.storage.sync.get(null).then(all => Object.values(all).find(r => r && r.name === 'Half typed'))`);
  assert(saved && saved.url.mode === 'regex' && saved.delaySeconds === 42 && saved.title === null, 'saved rule has expected shape');

  console.log('cancel pending from popup');
  const slowId = await cdp.eval(sw, `chrome.storage.sync.set({ 'rule:slow': { id: 'slow', name: 'Slow', enabled: true,
      title: { mode: 'contains', pattern: 'e2e-slow', caseSensitive: false }, url: null, delaySeconds: 20, createdAt: Date.now() } })
    .then(() => new Promise(r => setTimeout(r, 300)))
    .then(() => chrome.tabs.create({ url: 'data:text/html,<title>e2e-slow</title>x', active: false })).then(t => t.id)`);
  await cdp.eval(sw, `chrome.tabs.update(${slowId}, { active: true })`);
  await sleep(200);
  const quick = await open(popupUrl, true);
  assert(await cdp.eval(quick.session, `document.body.classList.contains('in-popup')`), 'toolbar popup loads the settings UI in compact mode');
  assert(await cdp.eval(quick.session, `document.getElementById('welcome-guide').getBoundingClientRect().width > 0`), 'Help is available in the toolbar popup');
  await cdp.eval(quick.session, `document.getElementById('privacy-details').open = true`);
  assert(await cdp.eval(quick.session, `document.getElementById('privacy-details').textContent.includes('last 100') && !!document.querySelector('header a[href="../help/guide.html#privacy"]') && document.documentElement.scrollWidth <= window.innerWidth`), 'toolbar popup exposes privacy/storage details without horizontal overflow');
  await cdp.eval(quick.session, `document.getElementById('privacy-details').open = false`);
  const shownRules = await cdp.eval(quick.session, `[...document.querySelectorAll('#rule-list li .name')].map(n => n.textContent)`);
  assert(shownRules.length === 1 && shownRules[0].startsWith('Slow'), `popup lists only the rule matching the current tab (${shownRules.join(', ')})`);
  const filterNote = await cdp.eval(quick.session, `document.getElementById('rules-filter-note').textContent`);
  assert(/other rules?: see All rules/.test(filterNote), `popup says where the other rules are (${filterNote})`);
  assert(await cdp.eval(quick.session, `document.querySelectorAll('#rule-list li button.icon:not(.chevron)').length === 0`), 'no reorder arrows in the filtered popup list');
  assert((await cdp.eval(quick.session, `document.getElementById('open-in-tab').textContent`)) === 'All rules', 'header button is labelled All rules');
  assert(await cdp.eval(quick.session, `document.getElementById('auto-close-details') !== null && document.getElementById('add-rule') !== null`), 'toolbar popup has Add rule and the automatic-closing options');
  assert(!(await cdp.eval(quick.session, `document.getElementById('open-in-tab').hidden`)), 'toolbar popup offers the All rules button');
  assert((await cdp.eval(quick.session, `document.body.getBoundingClientRect().width`)) === 630, 'toolbar popup is 630 px wide');
  await waitFor(() => cdp.eval(quick.session, `document.querySelectorAll('#pending-list li').length > 0`), { label: 'pending entry in popup' });
  const pendingText = await cdp.eval(quick.session, `document.querySelector('#pending-list li .meta').textContent`);
  assert(/closes in \d+s/.test(pendingText), `pending countdown shown (${pendingText})`);

  console.log('the Closing group');
  const groupId = await cdp.eval(sw, `chrome.tabs.get(${slowId}).then(t => t.groupId)`);
  assert(groupId !== -1, 'pending tab was placed in a tab group');
  const groupInfo = await cdp.eval(sw, `chrome.tabGroups.get(${groupId})`);
  assert(groupInfo.title === 'Closing', `group is titled "Closing" (${groupInfo.title})`);
  assert(groupInfo.color === 'red', 'group is red');
  const slowId2 = await cdp.eval(sw, `chrome.tabs.create({ url: 'data:text/html,<title>e2e-slow two</title>x', active: false }).then(t => t.id)`);
  await waitFor(() => cdp.eval(sw, `chrome.tabs.get(${slowId2}).then(t => t.groupId === ${groupId})`), { label: 'second pending tab joins the Closing group' });
  assert(true, 'all pending tabs share one Closing group');
  const stripEnd = await cdp.eval(sw, `chrome.tabs.get(${slowId}).then(t => chrome.tabs.query({ windowId: t.windowId })).then(ts => ({ last: Math.max(...ts.map(t => t.index)), members: ts.filter(t => t.groupId === ${groupId}).map(t => t.index).sort((a, b) => b - a) }))`);
  assert(stripEnd.members[0] === stripEnd.last, `Closing group sits at the end of the strip (${stripEnd.members} of ${stripEnd.last})`);
  await sleep(1200);
  assert((await cdp.eval(sw, `chrome.tabGroups.get(${groupId}).then(g => g.title)`)) === 'Closing', 'title does not tick; countdown lives in the popup');
  await waitFor(() => cdp.eval(quick.session, `document.querySelectorAll('#pending-list li').length === 2`), { label: 'popup lists both pending tabs' });
  await cdp.eval(popup.session, `chrome.runtime.sendMessage({ type: 'cancel', tabId: ${slowId2} })`);
  await waitFor(() => cdp.eval(sw, `chrome.tabs.get(${slowId2}).then(t => t.groupId === -1)`), { label: 'second tab released' });
  assert((await cdp.eval(sw, `chrome.tabGroups.get(${groupId}).then(g => g.title, () => null)`)) === 'Closing', 'group remains while another tab is still pending');

  await cdp.eval(quick.session, `document.querySelector('#pending-list li button').click()`);
  await waitFor(() => cdp.eval(quick.session, `document.getElementById('pending-section').hidden`), { label: 'pending list emptied' });
  assert(await cdp.eval(sw, `chrome.tabs.query({}).then(ts => ts.some(t => t.id === ${slowId}))`), 'tab kept after cancel');
  const keptMap = await cdp.eval(sw, `chrome.storage.session.get('kept').then(r => r.kept ?? {})`);
  assert(Array.isArray(keptMap[slowId]) && keptMap[slowId].includes('slow'), 'Keep recorded an exemption for this tab and rule');
  await cdp.eval(sw, `chrome.storage.sync.set({ 'rule:slow2': { id: 'slow2', name: 'Slow copy', enabled: true, title: { mode: 'contains', pattern: 'zzz-no-match', caseSensitive: false }, url: null, delaySeconds: 20, createdAt: Date.now() } })`);
  await sleep(500);
  assert(!(await cdp.eval(sw, `chrome.storage.session.get('pending').then(r => String(${slowId}) in (r.pending ?? {}))`)), 'rescan after a rule edit does not reschedule the kept tab');
  await cdp.send('Target.closeTarget', { targetId: quick.targetId });
  assert((await cdp.eval(sw, `chrome.tabs.get(${slowId}).then(t => t.groupId)`)) === -1, 'tab ungrouped after cancel');
  assert(
    await cdp.eval(sw, `chrome.tabGroups.get(${groupId}).then(() => false, () => true)`),
    'empty Closing group removed after the last cancel',
  );

  console.log('grouping rule: group created, late status appended, live change renames');
  await cdp.eval(
    sw,
    `chrome.storage.sync.set({
      'grule:tix': { id: 'tix', name: 'Tickets', enabled: true, regex: '/ticket/([A-Z]+-\\\\d+)', titleTemplate: '$1',
        color: 'purple', randomColor: false, statusEnabled: true,
        statusFields: [{ selector: '#status', keepOnly: '', label: '' }],
        siteOrigin: ${JSON.stringify(FIXTURE_ORIGIN)}, createdAt: Date.now() },
      groupRuleOrder: ['tix'],
    })`,
  );
  await sleep(300);
  const groupTitle = (gid) => cdp.eval(sw, `chrome.tabGroups.get(${gid}).then(g => g.title)`);
  const tabGroup = (id) => cdp.eval(sw, `chrome.tabs.get(${id}).then(t => t.groupId)`);

  const t1 = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: ${JSON.stringify(FIXTURE_ORIGIN + '/ticket/ABC-123?status=In%20Progress&delay=1500')}, active: true }).then(t => t.id)`,
  );
  const g1 = await waitFor(async () => {
    const gid = await tabGroup(t1);
    return gid !== -1 ? gid : null;
  }, { label: 'ticket tab grouped' });
  const early = await groupTitle(g1);
  assert(early === 'ABC-123' || early === 'ABC-123 - In Progress', `group titled from the URL (${early})`);
  assert((await cdp.eval(sw, `chrome.tabGroups.get(${g1}).then(g => g.color)`)) === 'purple', 'rule colour applied');
  await waitFor(async () => (await groupTitle(g1)) === 'ABC-123 - In Progress', { timeout: 8000, label: 'late status appended' });
  assert(true, 'status read after the element appeared late');

  const page1 = await pageSession(cdp, '/ticket/ABC-123');
  await cdp.eval(page1, `document.getElementById('status').textContent = 'Done'`);
  await waitFor(async () => (await groupTitle(g1)) === 'ABC-123 - Done', { timeout: 5000, label: 'live rename' });
  assert(true, 'changing the status in the page renamed the group without a reload');

  console.log('grouping rule: second tab joins, other ticket separate, SPA navigation regroups');
  const t2 = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: ${JSON.stringify(FIXTURE_ORIGIN + '/ticket/ABC-123?status=Done')}, active: false }).then(t => t.id)`,
  );
  await waitFor(async () => (await tabGroup(t2)) === g1, { label: 'second tab joins the same group' });
  assert((await cdp.eval(sw, `chrome.tabGroups.query({}).then(gs => gs.filter(g => g.title.startsWith('ABC-123')).length)`)) === 1, 'exactly one ABC-123 group');

  const t3 = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: ${JSON.stringify(FIXTURE_ORIGIN + '/ticket/XYZ-9?status=Open')}, active: false }).then(t => t.id)`,
  );
  const g3 = await waitFor(async () => {
    const gid = await tabGroup(t3);
    return gid !== -1 && gid !== g1 ? gid : null;
  }, { label: 'other ticket gets its own group' });
  await waitFor(async () => (await groupTitle(g3)) === 'XYZ-9 - Open', { timeout: 5000, label: 'XYZ-9 status' });
  assert(true, 'different ticket got a separate group with its own status');

  await cdp.eval(page1, `history.pushState({}, '', '/ticket/ABC-124?status=Done')`);
  const g4 = await waitFor(async () => {
    const gid = await tabGroup(t1);
    return gid !== -1 && gid !== g1 ? gid : null;
  }, { timeout: 5000, label: 'SPA navigation regroups' });
  await waitFor(async () => (await groupTitle(g4)).startsWith('ABC-124'), { label: 'new group title' });
  assert(true, 'URL change without reload moved the tab to the ABC-124 group');
  assert((await groupTitle(g1)) === 'ABC-123 - Done', 'old group kept its title');

  console.log('title length limit');
  const t5 = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: ${JSON.stringify(FIXTURE_ORIGIN + '/ticket/LONGPROJECTNAME-1234567?status=Blocked')}, active: false }).then(t => t.id)`,
  );
  const g5 = await waitFor(async () => {
    const gid = await tabGroup(t5);
    return gid !== -1 ? gid : null;
  }, { label: 'long ticket grouped' });
  await waitFor(async () => (await groupTitle(g5)) === 'LONGPROJECTNAME-1234567 - Blocked', { timeout: 5000, label: 'long title with status' });
  const limitRes = await cdp.eval(popup.session, `chrome.runtime.sendMessage({ type: 'set-title-limit', limit: 20 })`);
  assert(limitRes.ok && limitRes.changed >= 1, `limit applied and re-titled ${limitRes.changed} group(s)`);
  assert((await groupTitle(g5)) === 'LONGPROJE… - Blocked', `long base shortened, status kept (${await groupTitle(g5)})`);
  assert((await groupTitle(g1)) === 'ABC-123 - Done', 'short titles untouched by the limit');
  await cdp.eval(popup.session, `chrome.runtime.sendMessage({ type: 'set-title-limit', limit: 0 })`);
  assert((await groupTitle(g5)) === 'LONGPROJECTNAME-1234567 - Blocked', 'limit 0 restores full titles');

  console.log('settings group view: list, Test on current tab');
  await cdp.eval(sw, `chrome.tabs.update(${t1}, { active: true })`);
  await sleep(200);
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  popup = await open(optionsUrl, true);
  await waitFor(() => cdp.eval(popup.session, `document.querySelectorAll('#group-rule-list li').length > 0`), { label: 'settings group rules list' });
  await cdp.send('Target.activateTarget', { targetId: popup.targetId });
  await waitFor(() => cdp.eval(popup.session, `document.visibilityState === 'visible'`), { label: 'popup visible' });
  await cdp.eval(popup.session, `document.getElementById('tab-group').click()`);
  assert(!(await cdp.eval(popup.session, `document.getElementById('view-group').hidden`)), 'Group tab shows the group view');
  const entryText = await cdp.eval(popup.session, `document.querySelector('#group-rule-list li').textContent`);
  assert(entryText.includes('Tickets') && entryText.includes('STATUS') && entryText.includes('/ticket/'), `rule entry shows name, STATUS badge and regex`);

  await cdp.eval(popup.session, `document.getElementById('add-group-rule').click()`);
  await waitFor(() => cdp.eval(popup.session, `!document.getElementById('group-form-section').hidden`), { label: 'group form open' });
  assert(
    (await cdp.eval(popup.session, `document.getElementById('group-form').elements.siteOrigin.value`)) === FIXTURE_ORIGIN,
    'site origin pre-filled from the active tab',
  );
  await cdp.eval(
    popup.session,
    `(() => { const f = document.getElementById('group-form').elements;
       f.regex.value = '/ticket/([A-Z]+-\\\\d+)'; f.regex.dispatchEvent(new Event('input', { bubbles: true }));
       f.titleTemplate.value = 'T $1'; f.titleTemplate.dispatchEvent(new Event('input', { bubbles: true }));
       f.statusEnabled.checked = true; f.statusEnabled.dispatchEvent(new Event('change', { bubbles: true }));
       const sel = document.querySelector('#status-fields [data-key="selector"]'); sel.value = '#status'; sel.dispatchEvent(new Event('input', { bubbles: true }));
       const keep = document.querySelector('#status-fields [data-key="keepOnly"]'); keep.value = '(D)one'; keep.dispatchEvent(new Event('input', { bubbles: true }));
     })()`,
  );
  assert(await cdp.eval(popup.session, `!document.getElementById('status-block').hidden && document.getElementById('group-permission-save').textContent.includes(${JSON.stringify(FIXTURE_ORIGIN)})`), 'status permission explanation is visible before saving or testing');
  await cdp.eval(popup.session, `(() => { const input = document.getElementById('group-form').elements.siteOrigin; input.dataset.previousOrigin = input.value; input.value = 'https://other.example.test'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(await cdp.eval(popup.session, `document.getElementById('group-permission-save').textContent.includes('https://other.example.test/*') && document.getElementById('group-permission-test').textContent.includes(${JSON.stringify(FIXTURE_ORIGIN + '/*')})`), 'permission explanation distinguishes the saved site from the current test site');
  await cdp.eval(popup.session, `(() => { const input = document.getElementById('group-form').elements.siteOrigin; input.value = input.dataset.previousOrigin; delete input.dataset.previousOrigin; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  // A real click so chrome.permissions.request has a user gesture. Scroll the button into
  // view first: dispatchMouseEvent uses viewport coordinates.
  const rect = await cdp.eval(
    popup.session,
    `(() => { const b = document.getElementById('test-group-rule'); b.scrollIntoView({ block: 'center' });
       const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, popup.session);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, popup.session);
  }
  // If the synthetic click missed, fall back to a programmatic click: the fixture origin is
  // pre-granted so the test still exercises the read path, just without the gesture.
  const clicked = await waitFor(() => cdp.eval(popup.session, `!document.getElementById('test-result').hidden`), { timeout: 2000, label: 'test started' }).then(() => true, () => false);
  if (!clicked) {
    console.log('  (synthetic click missed; using element.click())');
    await cdp.eval(popup.session, `document.getElementById('test-group-rule').click()`);
  }
  await waitFor(() => cdp.eval(popup.session, `document.getElementById('test-result').querySelector('dl') !== null`), { timeout: 8000, label: 'test result panel' });
  const resultText = await cdp.eval(popup.session, `document.getElementById('test-result').textContent`);
  assert(resultText.includes('T ABC-124'), `test shows the resolved group title (${resultText.slice(0, 80)}…)`);
  assert(resultText.includes('kept from "Done"') && resultText.includes('read from span#status'), 'test shows keep-only effect and element description');
  assert(resultText.includes('Final title') && resultText.includes('T ABC-124 - D'), 'test shows the final title');
  assert((await cdp.eval(popup.session, `document.getElementById('test-result').className`)) === 'result ok', 'result panel is green');
  assert((await groupTitle(g4)).startsWith('ABC-124'), 'Test was a dry run: real group untouched');

  await cdp.eval(popup.session, `document.getElementById('cancel-group-rule').click()`);
  await sleep(200);

  console.log('AWS console grouping');
  const awsUrl = (q) => `${FIXTURE_ORIGIN}/aws?${q}`;
  await cdp.eval(
    sw,
    `chrome.storage.sync.set({ awsSettings: { enabled: true, fields: { account: true, accountId: false, role: true, user: false, region: false },
       separator: ' · ', urlPattern: '^https://127\\\\.0\\\\.0\\\\.1:\\\\d+/aws' } })`,
  );
  await sleep(300);
  const aws1 = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: ${JSON.stringify(awsUrl('account=Acme%20Dev%20(123456789012)&role=AdminRole%2Fjane&delay=800'))}, active: true }).then(t => t.id)`,
  );
  const awsG1 = await waitFor(async () => {
    const gid = await tabGroup(aws1);
    return gid !== -1 ? gid : null;
  }, { timeout: 15000, label: 'AWS console tab grouped' });
  assert((await groupTitle(awsG1)) === 'Acme Dev · AdminRole', `group named account · role (${await groupTitle(awsG1)})`);
  const aws2 = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: ${JSON.stringify(awsUrl('account=Acme%20Dev%20(123456789012)&role=AdminRole%2Fjane&delay=0'))}, active: false }).then(t => t.id)`,
  );
  await waitFor(async () => (await tabGroup(aws2)) === awsG1, { timeout: 15000, label: 'second console tab joins the account/role group' });
  assert(true, 'same account and role share one group');
  const aws3 = await cdp.eval(
    sw,
    `chrome.tabs.create({ url: ${JSON.stringify(awsUrl('account=Prod%20(111111111111)&role=ReadOnly%2Fjane'))}, active: false }).then(t => t.id)`,
  );
  const awsG3 = await waitFor(async () => {
    const gid = await tabGroup(aws3);
    return gid !== -1 && gid !== awsG1 ? gid : null;
  }, { timeout: 15000, label: 'other account gets its own group' });
  assert((await groupTitle(awsG3)) === 'Prod · ReadOnly', `other account/role group (${await groupTitle(awsG3)})`);

  for (const [role, expected] of [['root', 'Acme Dev · root'], ['Recently visited', 'Acme Dev']]) {
    const id = await cdp.eval(sw, `chrome.tabs.create({ url: ${JSON.stringify(awsUrl(`account=Acme%20Dev%20(123456789012)&role=${encodeURIComponent(role)}`))}, active: false }).then(t => t.id)`);
    await waitFor(async () => {
      const gid = await tabGroup(id);
      return gid !== -1 && (await groupTitle(gid)) === expected;
    // A missing role resolves only after the reader's 10-second render window.
    }, { timeout: 15000, label: `AWS identity ${role}` });
    assert(true, role === 'root' ? 'AWS root session has the correct group title' : 'AWS unmatched navigation text is excluded from group titles');
  }

  console.log('settings AWS view: preview and Test');
  await cdp.eval(sw, `chrome.tabs.update(${aws1}, { active: true })`);
  await sleep(200);
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  popup = await open(optionsUrl, true);
  await waitFor(() => cdp.eval(popup.session, `document.getElementById('aws-preview').textContent.length > 0`), { label: 'settings aws view ready' });
  await cdp.send('Target.activateTarget', { targetId: popup.targetId });
  await waitFor(() => cdp.eval(popup.session, `document.visibilityState === 'visible'`), { label: 'popup visible' });
  await cdp.eval(popup.session, `document.getElementById('tab-aws').click()`);
  assert(!(await cdp.eval(popup.session, `document.getElementById('view-aws').hidden`)), 'AWS tab shows the AWS view');
  assert(await cdp.eval(popup.session, `document.getElementById('aws-permission-note').getBoundingClientRect().height > 0 && document.getElementById('aws-permission-note').textContent.includes('https://*.console.aws.amazon.com/*')`), 'AWS access scope is explained beside permission controls');
  assert(await cdp.eval(popup.session, `document.getElementById('aws-enabled').checked`), 'enabled state reflected');
  assert((await cdp.eval(popup.session, `document.getElementById('aws-preview').textContent`)) === 'Acme Dev · AdminRole', 'preview shows the default title shape');
  await cdp.eval(popup.session, `(() => { const u = document.querySelector('[data-aws-field="user"]'); u.checked = true; u.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(() => cdp.eval(popup.session, `document.getElementById('aws-preview').textContent === 'Acme Dev · AdminRole · jane'`), { label: 'preview updates with user field' });
  assert(true, 'ticking User updates the preview and saves');
  const awsRect = await cdp.eval(
    popup.session,
    `(() => { const b = document.getElementById('aws-test'); b.scrollIntoView({ block: 'center' });
       const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: awsRect.x, y: awsRect.y }, popup.session);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: awsRect.x, y: awsRect.y, button: 'left', clickCount: 1 }, popup.session);
  }
  const awsClicked = await waitFor(() => cdp.eval(popup.session, `!document.getElementById('aws-result').hidden`), { timeout: 2000, label: 'aws test started' }).then(() => true, () => false);
  if (!awsClicked) await cdp.eval(popup.session, `document.getElementById('aws-test').click()`);
  await waitFor(() => cdp.eval(popup.session, `document.getElementById('aws-result').querySelector('dl') !== null`), { timeout: 8000, label: 'aws test result' });
  const awsText = await cdp.eval(popup.session, `document.getElementById('aws-result').textContent`);
  assert(awsText.includes('Acme Dev · AdminRole · jane'), `AWS test shows the title with the unsaved-safe settings (${awsText.slice(0, 60)}…)`);
  assert(awsText.includes('123456789012') && awsText.includes('jane') && awsText.includes('account-label'), 'AWS test shows parsed fields and the element read from');
  assert((await cdp.eval(popup.session, `document.getElementById('aws-result').className`)) === 'result ok', 'AWS result panel is green');
  // restore default fields for later runs
  await cdp.eval(popup.session, `(() => { const u = document.querySelector('[data-aws-field="user"]'); u.checked = false; u.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);

  console.log('age-based closing');
  await cdp.eval(sw, `chrome.storage.sync.set({ closeSettings: { maxOpen: { enabled: true, value: 1, unit: 'hours' }, maxIdle: { enabled: false, value: 2, unit: 'days' } } })`);
  await sleep(300);
  const oldTab = await cdp.eval(sw, `chrome.tabs.create({ url: 'data:text/html,<title>e2e-old-tab</title>x', active: false }).then(t => t.id)`);
  const pinnedOld = await cdp.eval(sw, `chrome.tabs.create({ url: 'data:text/html,<title>e2e-old-pinned</title>x', active: false, pinned: true }).then(t => t.id)`);
  await sleep(300);
  // Backdate first-seen for both tabs to two hours ago, then run a sweep.
  await cdp.eval(
    sw,
    `chrome.storage.session.get('firstSeen').then(({ firstSeen = {} }) => { firstSeen[${oldTab}] = Date.now() - 7200000; firstSeen[${pinnedOld}] = Date.now() - 7200000; return chrome.storage.session.set({ firstSeen }); })`,
  );
  const sweepRes = await cdp.eval(popup.session, `chrome.runtime.sendMessage({ type: 'sweep' })`);
  assert(sweepRes.ok && sweepRes.closed.some((c) => c.tabId === oldTab && c.why === 'open'), `sweep closed the old tab (${JSON.stringify(sweepRes.closed)})`);
  assert(await cdp.eval(sw, `chrome.tabs.query({}).then(ts => !ts.some(t => t.id === ${oldTab}))`), 'old tab is gone');
  assert(await cdp.eval(sw, `chrome.tabs.query({}).then(ts => ts.some(t => t.id === ${pinnedOld}))`), 'old pinned tab survived');
  const ageLog = await cdp.eval(sw, `chrome.storage.local.get('log').then(r => r.log ?? [])`);
  assert(ageLog[0].ruleId === 'age-open' && ageLog[0].title === 'e2e-old-tab', `age close logged (${ageLog[0].ruleName})`);
  assert(!(await cdp.eval(sw, `chrome.storage.session.get('pending').then(r => String(${oldTab}) in (r.pending ?? {}))`)), 'no countdown entry was created for the age close');

  console.log('a tab from the middle of the strip joins the Closing group at the end and returns on cancel');
  const created = await cdp.eval(sw, `chrome.tabs.create({ url: 'data:text/html,<title>e2e-slow</title>x', active: false, index: 0 }).then(t => ({ id: t.id, index: t.index }))`);
  const endTab = created.id; // index 0 lands after any pinned tabs; Chrome reports where it really went
  const endGid = await waitFor(async () => {
    const gid = await cdp.eval(sw, `chrome.tabs.get(${endTab}).then(t => t.groupId)`);
    return gid !== -1 ? gid : null;
  }, { label: 'Closing group for strip-end test' });
  // The Closing group may hold other pending tabs; what matters is that its members fill the last positions.
  const layout = await cdp.eval(
    sw,
    `chrome.tabs.get(${endTab}).then(t => chrome.tabs.query({ windowId: t.windowId })).then(ts => ({
       last: Math.max(...ts.map(t => t.index)),
       members: ts.filter(t => t.groupId === ${endGid}).map(t => t.index).sort((a, b) => a - b),
       mine: ts.find(t => t.id === ${endTab}).index,
     }))`,
  );
  const expectedFirst = layout.last - layout.members.length + 1;
  assert(
    layout.members[0] === expectedFirst && layout.members.at(-1) === layout.last && layout.members.includes(layout.mine),
    `tab joined the Closing group, which fills the end of the strip (members ${layout.members.join(',')} of ${layout.last})`,
  );
  await cdp.eval(popup.session, `chrome.runtime.sendMessage({ type: 'cancel', tabId: ${endTab} })`);
  await waitFor(() => cdp.eval(sw, `chrome.tabs.get(${endTab}).then(t => t.groupId === -1)`), { label: 'ungrouped after cancel' });
  const backIndex = await cdp.eval(sw, `chrome.tabs.get(${endTab}).then(t => t.index)`);
  assert(backIndex === created.index, `cancelled tab returned to its original position (${backIndex} = ${created.index})`);
  await cdp.eval(sw, `chrome.storage.sync.set({ closeSettings: { maxOpen: { enabled: false, value: 1, unit: 'hours' }, maxIdle: { enabled: false, value: 2, unit: 'days' } } })`);
  await sleep(300);

  console.log('grace before grouping (login redirect)');
  await cdp.eval(
    sw,
    `chrome.storage.sync.set({ 'rule:login': { id: 'login', name: 'Login page', enabled: true,
        title: { mode: 'contains', pattern: 'e2e-login', caseSensitive: false }, url: null,
        delaySeconds: 20, groupAfterSeconds: 3, createdAt: Date.now() } })`,
  );
  await sleep(300);
  const loginTab = await cdp.eval(sw, `chrome.tabs.create({ url: 'data:text/html,<title>e2e-login</title>x', active: false }).then(t => t.id)`);
  await waitFor(() => cdp.eval(sw, `chrome.storage.session.get('pending').then(r => String(${loginTab}) in (r.pending ?? {}))`), { label: 'login tab pending' });
  await sleep(800);
  assert((await cdp.eval(sw, `chrome.tabs.get(${loginTab}).then(t => t.groupId)`)) === -1, 'login tab not grouped during the grace period');
  // Redirect back before the grace ends: countdown cancelled, never grouped.
  await cdp.eval(sw, `chrome.tabs.update(${loginTab}, { url: ${JSON.stringify(FIXTURE_ORIGIN + '/ticket/BACK-1')} })`);
  try {
    await waitFor(() => cdp.eval(sw, `chrome.storage.session.get('pending').then(r => !(String(${loginTab}) in (r.pending ?? {})))`), { label: 'countdown cancelled after redirect' });
  } catch (err) {
    console.log('  tab now:', JSON.stringify(await cdp.eval(sw, `chrome.tabs.get(${loginTab}).then(t => ({ url: t.url, title: t.title, status: t.status, groupId: t.groupId }))`)));
    console.log('  pending:', JSON.stringify(await cdp.eval(sw, `chrome.storage.session.get('pending').then(r => r.pending?.[${loginTab}] ?? null)`)));
    throw err;
  }
  await sleep(3000);
  const backGroupTitle = await cdp.eval(sw, `chrome.tabs.get(${loginTab}).then(t => t.groupId === -1 ? null : chrome.tabGroups.get(t.groupId).then(g => g.title))`);
  assert(backGroupTitle !== 'Closing', `tab that redirected back was never moved to the Closing group (now in ${backGroupTitle ?? 'no group'})`);
  // Abandoned login: grouped once the grace passes.
  const abandoned = await cdp.eval(sw, `chrome.tabs.create({ url: 'data:text/html,<title>e2e-login abandoned</title>x', active: false }).then(t => t.id)`);
  await waitFor(() => cdp.eval(sw, `chrome.tabs.get(${abandoned}).then(t => t.groupId !== -1)`), { timeout: 8000, label: 'abandoned login grouped after the grace' });
  assert((await cdp.eval(sw, `chrome.tabs.get(${abandoned}).then(t => chrome.tabGroups.get(t.groupId)).then(g => g.title)`)) === 'Closing', 'abandoned login joined the Closing group');
  await cdp.eval(popup.session, `chrome.runtime.sendMessage({ type: 'cancel', tabId: ${abandoned} })`);
  await sleep(300);

  console.log('history appends are coordinated across extension contexts');
  await cdp.eval(sw, `chrome.storage.sync.set({ 'rule:history-race': {
    id: 'history-race', name: 'History race', enabled: true,
    title: { mode: 'contains', pattern: 'e2e-history-race', caseSensitive: false }, url: null,
    delaySeconds: 1, createdAt: Date.now()
  } })`);
  await sleep(300);
  const appendHistory = (source) => `(async () => {
    const { addLogEntry } = await import(chrome.runtime.getURL('src/log.js'));
    const { createStorage } = await import(chrome.runtime.getURL('src/storage.js'));
    const storage = createStorage(chrome.storage);
    await Promise.all(Array.from({ length: 10 }, (_, n) => addLogEntry(storage, { title: '${source}-' + n, url: 'https://example.test/' + n, ruleId: 'history-race', ruleName: 'History race', closedAt: Date.now() })));
  })()`;
  await Promise.all([
    cdp.eval(sw, `Promise.all(Array.from({ length: 10 }, (_, n) => chrome.tabs.create({ url: 'data:text/html,<title>e2e-history-race-' + n + '</title>x', active: false })))`),
    cdp.eval(popup.session, appendHistory('page')),
  ]);
  try {
    await waitFor(() => cdp.eval(popup.session, `chrome.storage.local.get('log').then(r => r.log.filter(e => e.ruleId === 'history-race').length === 20)`), { timeout: 20_000, label: 'all concurrent history entries' });
  } catch (error) {
    console.log('  history race entries:', JSON.stringify(await cdp.eval(popup.session, `chrome.storage.local.get('log').then(r => r.log.filter(e => e.ruleId === 'history-race'))`)));
    console.log('  pending:', JSON.stringify(await cdp.eval(popup.session, `chrome.storage.session.get('pending')`)));
    console.log('  history source tabs:', JSON.stringify(await cdp.eval(popup.session, `chrome.tabs.query({}).then(ts => ts.filter(t => (t.url + t.title).includes('e2e-history-race')).map(t => ({ id: t.id, title: t.title, status: t.status, url: t.url })))`)));
    throw error;
  }
  const historyCount = await cdp.eval(popup.session, `chrome.storage.local.get('log').then(r => r.log.filter(e => e.ruleId === 'history-race').length)`);
  assert(historyCount === 20, 'concurrent worker and page writes retain all 20 history entries');

  console.log('security import and reader checks');
  const securityMessages = await cdp.eval(popup.session, `(async () => {
    const { runSecurityChecks } = await import(chrome.runtime.getURL('help/security-browser.js'));
    return runSecurityChecks({ origin: ${JSON.stringify(FIXTURE_ORIGIN)}, tabId: ${t1} });
  })()`);
  for (const message of securityMessages) assert(true, message);

  console.log('long grouping grace survives a stopped service worker');
  await cdp.eval(sw, `chrome.storage.sync.set({ 'rule:wake': {
    id: 'wake', name: 'Worker wake', enabled: true,
    title: { mode: 'contains', pattern: 'e2e-worker-wake', caseSensitive: false }, url: null,
    delaySeconds: 180, groupAfterSeconds: 45, createdAt: Date.now()
  } })`);
  await sleep(300);
  const wakeTab = await cdp.eval(sw, `chrome.tabs.create({ url: 'data:text/html,<title>e2e-worker-wake</title>x', active: false }).then(t => t.id)`);
  await waitFor(() => cdp.eval(sw, `chrome.alarms.get('group:${wakeTab}').then(Boolean)`), { label: 'persisted grace alarm' });
  assert((await cdp.eval(sw, `chrome.tabs.get(${wakeTab}).then(t => t.groupId)`)) === -1, 'long grace leaves the tab ungrouped initially');
  await cdp.send('ServiceWorker.enable', {}, popup.session);
  await cdp.send('Target.detachFromTarget', { sessionId: sw });
  await cdp.send('ServiceWorker.stopAllWorkers', {}, popup.session);
  await waitFor(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return !targetInfos.some((t) => t.targetId === worker.targetId);
  }, { label: 'original worker stopped' });
  // Query through the extension page, without messaging or debugging the worker.
  // Only its persisted alarm should wake the worker to group the tab.
  await waitFor(() => cdp.eval(popup.session, `chrome.tabs.get(${wakeTab}).then(async t => t.groupId !== -1 && (await chrome.tabGroups.get(t.groupId)).title === 'Closing')`), {
    timeout: 55_000, interval: 500, label: 'grouping alarm wakes stopped worker',
  });
  assert(await cdp.eval(popup.session, `chrome.tabs.get(${wakeTab}).then(Boolean)`), 'alarm grouped the tab without closing it early');
  await cdp.eval(popup.session, `chrome.runtime.sendMessage({ type: 'cancel', tabId: ${wakeTab}, keep: true })`);

  assert(errors.length === 0, `no console errors or uncaught exceptions${errors.length ? `: ${errors.join(' || ')}` : ''}`);
  console.log('\nE2E PASSED');
} catch (err) {
  exitCode = 1;
  console.error('\nE2E FAILED:', err.message);
  if (capturedErrors.length) console.error('console errors captured:\n  ' + capturedErrors.join('\n  '));
  if (stderr.trim()) console.error('chrome stderr:\n', stderr.split('\n').filter((l) => !/^\[\d+:\d+:\d+\/\d+\.\d+:(INFO|WARNING)/.test(l)).join('\n'));
} finally {
  chrome.kill('SIGKILL');
  fixture.close();
  await sleep(200);
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(extCopy, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
  process.exit(exitCode);
}
