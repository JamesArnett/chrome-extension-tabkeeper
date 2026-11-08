// Isolated Firefox integration tests using standard WebDriver add-on install.
// No system-access flag, unsigned-extension preference changes or user profile.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const firefox = process.env.FIREFOX;
const geckodriver = process.env.GECKODRIVER ?? 'geckodriver';
if (!firefox) throw new Error('Set FIREFOX to a desktop Firefox 140+ executable.');
const scratch = mkdtempSync(join(tmpdir(), 'tabkeeper-firefox-e2e-'));
const source = join(scratch, 'extension');
let finish;
const result = new Promise((resolveResult) => { finish = resolveResult; });
const fixture = createServer(async (req, res) => {
  if (req.url === '/passed') {
    console.log('  ok  revoked host permission prevents new page reads');
    finish({ ok: true });
    res.writeHead(200).end('passed');
    return;
  }
  if (req.url.startsWith('/failed?')) {
    finish({ ok: false, error: new URL(req.url, 'http://localhost').searchParams.get('error') });
    res.writeHead(200).end('failed');
    return;
  }
  if (req.method === 'POST' && ['/result', '/progress'].includes(req.url)) {
    let text = '';
    for await (const chunk of req) text += chunk;
    const data = JSON.parse(text);
    if (req.url === '/result') finish(data);
    else console.log(data.message);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  // Test pages derive content from their URL; no request data is injected into HTML.
  res.end(`<!doctype html><html><head><title>Fixture</title></head><body>
    <span id="status"></span><div id="account">Acme Dev (123456789012)</div><div id="role">AdminRole/jane</div>
    <script>const p = new URLSearchParams(location.search); document.title = p.get('title') || 'Firefox fixture';
    document.getElementById('status').textContent = p.get('status') || 'To Do';</script></body></html>`);
});
await new Promise((resolveListen) => fixture.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const portProbe = createServer();
await new Promise((resolveListen) => portProbe.listen(0, '127.0.0.1', resolveListen));
const port = portProbe.address().port;
await new Promise((resolveClose) => portProbe.close(resolveClose));
const driver = spawn(geckodriver, ['--port', String(port), '--log', 'error'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
driver.on('error', (error) => { stderr += error.message; });
driver.stderr.on('data', (chunk) => { stderr += chunk; });
const endpoint = `http://127.0.0.1:${port}`;
let session;
async function request(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(endpoint + path, {
    method, headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data.value));
  return data.value;
}
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
let timeout;
try {
  execFileSync(process.execPath, ['scripts/package.mjs', 'firefox'], { cwd: root, stdio: 'inherit' });
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  execFileSync('unzip', ['-oq', join(root, 'dist', `tabkeeper-firefox-${version}.zip`), '-d', source]);
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json')));
  // Headless tests cannot answer native prompts. Only this disposable copy has
  // the fixture origin pre-granted; the distributed packages remain optional.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
  cpSync(join(root, 'scripts', 'fixtures', 'firefox-browser.js'), join(source, 'help', 'firefox-browser.js'));
  writeFileSync(join(source, 'help', 'test-config.json'), JSON.stringify({ origin }));
  // First-install guide starts a normal extension settings tab containing the
  // test module. It uses extension APIs only, never Firefox internals.
  writeFileSync(join(source, 'help', 'guide.js'), readFileSync(join(source, 'help', 'guide.js'), 'utf8') +
    '\nimport { api } from "../src/browser-api.js";\napi.tabs.create({ url: api.runtime.getURL("options/options.html") });\n');
  const options = join(source, 'options', 'options.html');
  writeFileSync(options, readFileSync(options, 'utf8').replace('</body>', '<script type="module" src="../help/firefox-browser.js"></script></body>'));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await request('/status')).ready) { ready = true; break; } } catch { /* starting */ }
    await wait(100);
  }
  if (!ready) throw new Error(`geckodriver did not start: ${stderr}`);
  const created = await request('/session', { capabilities: { alwaysMatch: {
    browserName: 'firefox', 'moz:firefoxOptions': { binary: resolve(firefox), args: ['-headless', '--no-remote'] },
  } } });
  session = created.sessionId;
  console.log(`Firefox ${created.capabilities.browserVersion}`);
  await request(`/session/${session}/moz/addon/install`, { path: source, temporary: true });
  const outcome = await Promise.race([result, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Firefox tests timed out.')), 180_000);
  })]);
  if (!outcome.ok) throw new Error(outcome.error);
  console.log('FIREFOX E2E PASSED');
} catch (error) {
  console.error('FIREFOX E2E FAILED:', error.message);
  if (stderr) console.error(stderr.slice(-6000));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  if (session) await request(`/session/${session}`, null, 'DELETE').catch(() => {});
  driver.kill('SIGTERM');
  await new Promise((resolveClose) => fixture.close(resolveClose));
  rmSync(scratch, { recursive: true, force: true });
}
