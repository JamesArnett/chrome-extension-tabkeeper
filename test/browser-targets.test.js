import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { targetManifest, FIREFOX_ID } from '../scripts/browser-targets.mjs';
import { isExtensionSender, isMessageSender, isExtensionUrl, extensionSettingsUrl, hostPermission } from '../src/browser-api.js';
import { isIgnoredUrl } from '../src/group-rules.js';

test('Firefox manifest keeps optional host access and supplies its own event-page and AMO identity', () => {
  const source = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  const original = structuredClone(source);
  const firefox = targetManifest(source, 'firefox');
  assert.equal(firefox.browser_specific_settings.gecko.id, FIREFOX_ID);
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.deepEqual(firefox.background, { scripts: ['src/background.js'], type: 'module' });
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.equal(firefox.host_permissions, undefined);
  assert.deepEqual(firefox.optional_host_permissions, source.optional_host_permissions);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  assert.deepEqual(source, original, 'target generation must not change the Chrome source manifest');
  assert.deepEqual(targetManifest(source, 'chrome'), original);
  assert.throws(() => targetManifest(source, 'unknown'), /Unknown browser/);
});

test('only this extension’s pages can send privileged messages in either browser', () => {
  for (const base of ['chrome-extension://extension-id/', 'moz-extension://internal-uuid/']) {
    const sender = { id: 'extension-id', url: base + 'options/options.html', tab: { id: 12 } };
    assert.equal(isExtensionSender(sender, 'extension-id', base), true);
    assert.equal(isExtensionSender({ ...sender, url: 'https://example.test/' }, 'extension-id', base), false);
    assert.equal(isExtensionSender({ ...sender, id: 'another-extension' }, 'extension-id', base), false);
    assert.equal(isExtensionSender({ ...sender, url: base.slice(0, -1) + '.attacker/options.html' }, 'extension-id', base), false);
    assert.equal(isExtensionSender({ id: 'extension-id', origin: base.slice(0, -1) }, 'extension-id', base), false);
  }
});

test('Firefox internal pages are excluded and browser-specific settings links stay in their browser', () => {
  assert.equal(isIgnoredUrl('moz-extension://some-id/options/options.html'), true);
  assert.equal(isIgnoredUrl('about:addons'), true);
  assert.equal(isExtensionUrl('https://example.test/', 'moz-extension://some-id/'), false);
  assert.equal(extensionSettingsUrl('some-id', true), null);
  assert.equal(extensionSettingsUrl('some-id', false), 'chrome://extensions/?id=some-id');
});

test('status messages require this extension identity and a real sender tab in both browsers', () => {
  for (const base of ['chrome-extension://extension-id/', 'moz-extension://internal-uuid/']) {
    const reader = { id: 'extension-id', url: 'https://example.test/', tab: { id: 12 } };
    assert.equal(isMessageSender('status-report', reader, 'extension-id', base), true);
    assert.equal(isMessageSender('set-title-limit', reader, 'extension-id', base), false);
    for (const sender of [{ ...reader, id: 'other' }, { ...reader, id: undefined }, { ...reader, tab: undefined }, { ...reader, tab: { id: -1 } }]) {
      assert.equal(isMessageSender('status-report', sender, 'extension-id', base), false);
    }
  }
});

test('Firefox host grants omit unsupported ports while Chrome retains its origin pattern', () => {
  assert.equal(hostPermission('https://example.test:8443', true), 'https://example.test/*');
  assert.equal(hostPermission('https://example.test:8443', false), 'https://example.test:8443/*');
  assert.equal(hostPermission('http://127.0.0.1:1234', true), 'http://127.0.0.1/*');
  assert.equal(hostPermission('moz-extension://id/page', true), '');
  assert.equal(hostPermission('not a URL', true), '');
});
