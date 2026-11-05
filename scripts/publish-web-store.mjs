// Chrome Web Store API v2. Credentials stay in environment variables; never log
// token responses. Default mode uploads a draft. CWS_SUBMIT=true submits review.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export function readConfig(env) {
  for (const key of ['CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'RELEASE_TAG']) {
    if (!env[key]) throw new Error(`Missing ${key}. See docs/RELEASING.md.`);
  }
  if (!/^[a-z0-9_-]+$/i.test(env.CWS_PUBLISHER_ID)) throw new Error('Invalid publisher ID.');
  if (!/^[a-p]{32}$/.test(env.CWS_EXTENSION_ID)) throw new Error('Invalid extension ID.');
  if (!/^v\d+\.\d+\.\d+$/.test(env.RELEASE_TAG)) throw new Error('Use a release tag such as v1.0.0.');
  if (env.CWS_SUBMIT && !['true', 'false'].includes(env.CWS_SUBMIT)) throw new Error('CWS_SUBMIT must be true or false.');
  return {
    publisherId: env.CWS_PUBLISHER_ID,
    extensionId: env.CWS_EXTENSION_ID,
    clientId: env.CWS_CLIENT_ID,
    clientSecret: env.CWS_CLIENT_SECRET,
    refreshToken: env.CWS_REFRESH_TOKEN,
    version: env.RELEASE_TAG.slice(1),
    submit: env.CWS_SUBMIT === 'true',
  };
}

export async function publishWebStore(config, bytes, { fetchImpl = fetch, wait = sleep, log = console.log, maxPolls = 24 } = {}) {
  async function request(url, options, label) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}). Check the Web Store dashboard and OAuth configuration.`);
    const data = await response.json();
    if (data.error) throw new Error(`${label} returned an API error. Check the Web Store dashboard.`);
    return data;
  }
  const token = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret,
      refresh_token: config.refreshToken, grant_type: 'refresh_token',
    }),
  }, 'OAuth token refresh');
  if (!token.access_token) throw new Error('OAuth response did not contain an access token.');
  const name = `publishers/${config.publisherId}/items/${config.extensionId}`;
  const endpoint = `https://chromewebstore.googleapis.com/v2/${name}`;
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const uploaded = await request(`https://chromewebstore.googleapis.com/upload/v2/${name}:upload`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: bytes,
  }, 'Package upload');
  if (uploaded.crxVersion && uploaded.crxVersion !== config.version) throw new Error('Uploaded version differs from the requested release.');
  let state = uploaded.uploadState;
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < maxPolls; attempt++) {
    await wait(5000);
    const status = await request(`${endpoint}:fetchStatus`, { headers }, 'Upload status');
    state = status.lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new Error(`Upload did not succeed (${state ?? 'unknown state'}). No publish request was sent.`);
  log(`Uploaded Tabkeeper ${config.version}.`);
  if (!config.submit) {
    log('Saved as a Web Store draft. No review or publication requested.');
    return { uploaded: true, submitted: false };
  }
  const result = await request(`${endpoint}:publish`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }),
  }, 'Review submission');
  if (!['PENDING_REVIEW', 'PUBLISHED'].includes(result.state)) {
    throw new Error(`Unexpected submission state (${result.state ?? 'unknown'}). Check the Web Store dashboard before retrying.`);
  }
  log(`Web Store state: ${result.state}. Google controls review and availability.`);
  return { uploaded: true, submitted: true, state: result.state };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = readConfig(process.env);
    const path = new URL(`../dist/tabkeeper-${config.version}.zip`, import.meta.url);
    const manifest = JSON.parse(execFileSync('unzip', ['-p', fileURLToPath(path), 'manifest.json'], { encoding: 'utf8' }));
    if (manifest.version !== config.version) throw new Error('ZIP manifest does not match the release tag.');
    await publishWebStore(config, readFileSync(path));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
