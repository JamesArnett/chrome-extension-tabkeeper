import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../scripts/check-release.mjs';
import { readConfig, publishWebStore } from '../scripts/publish-web-store.mjs';

test('release gate rejects mismatched tags, versions and invalid Chrome metadata', () => {
  const manifest = { version: '1.0.0', description: 'Tabkeeper' };
  assert.equal(validateRelease(manifest, { version: '1.0.0' }, 'v1.0.0'), '1.0.0');
  assert.throws(() => validateRelease(manifest, { version: '0.1.0' }), /versions must match/);
  assert.throws(() => validateRelease(manifest, { version: '1.0.0' }, 'v0.1.0'), /Tag must/);
  assert.throws(() => validateRelease({ ...manifest, version: '1.0.0-beta' }, {}), /Chrome version/);
  assert.throws(() => validateRelease({ ...manifest, description: 'x'.repeat(133) }, { version: '1.0.0' }), /description/);
});

const env = {
  CWS_PUBLISHER_ID: 'publisher', CWS_EXTENSION_ID: 'a'.repeat(32),
  CWS_CLIENT_ID: 'client', CWS_CLIENT_SECRET: 'secret', CWS_REFRESH_TOKEN: 'refresh',
  RELEASE_TAG: 'v1.0.0',
};
function mockApi(replies) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      assert.ok(replies.length, 'no unexpected network requests');
      const { status = 200, ...body } = replies.shift();
      return { ok: status < 400, status, json: async () => body };
    },
    wait: async () => {}, log: () => {}, maxPolls: 2,
  };
}
const token = { access_token: 'test-token' };
const success = { uploadState: 'SUCCEEDED', crxVersion: '1.0.0' };

test('Web Store config validates IDs and defaults to draft upload', () => {
  assert.equal(readConfig(env).submit, false);
  assert.throws(() => readConfig({ ...env, CWS_CLIENT_SECRET: '' }), /Missing CWS_CLIENT_SECRET/);
  assert.throws(() => readConfig({ ...env, CWS_EXTENSION_ID: '../bad' }), /extension ID/);
  assert.throws(() => readConfig({ ...env, RELEASE_TAG: '../../bad' }), /release tag/);
});

test('draft upload never submits for review', async () => {
  const api = mockApi([token, success]);
  const result = await publishWebStore(readConfig(env), new Uint8Array([1]), api);
  assert.equal(result.submitted, false);
  assert.equal(api.calls.length, 2);
  assert.match(api.calls[1].url, /\/upload\/v2\/publishers\/publisher\/items\/a{32}:upload$/);
});

test('submission waits for async upload success and retains Google review', async () => {
  const api = mockApi([token, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
  const result = await publishWebStore(readConfig({ ...env, CWS_SUBMIT: 'true' }), new Uint8Array([1]), api);
  assert.equal(result.state, 'PENDING_REVIEW');
  assert.match(api.calls[2].url, /:fetchStatus$/);
  assert.deepEqual(JSON.parse(api.calls[3].body), { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
});

for (const [name, replies] of Object.entries({
  'OAuth failure': [{ status: 401 }],
  'upload HTTP failure': [token, { status: 400 }],
  'failed upload': [token, { uploadState: 'FAILED' }],
  'unknown upload state': [token, {}],
  'wrong uploaded version': [token, { ...success, crxVersion: '2.0.0' }],
  'upload timeout': [token, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' }],
})) {
  test(`Web Store ${name} prevents publication`, async () => {
    const api = mockApi([...replies]);
    await assert.rejects(publishWebStore(readConfig({ ...env, CWS_SUBMIT: 'true' }), new Uint8Array([1]), api));
    assert.equal(api.calls.some((c) => c.url.endsWith(':publish')), false);
  });
}
