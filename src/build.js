// Detects a stale service worker during development. The worker hashes the
// source files from disk when it starts; the popup (always freshly loaded)
// hashes them when it opens. A mismatch means files changed since the worker
// started and the extension should be reloaded.

import { api as chrome } from './browser-api.js';

export const SOURCE_FILES = [
  'manifest.json',
  'src/background.js',
  'src/browser-api.js',
  'src/scheduler.js',
  'src/grouper.js',
  'src/aws.js',
  'src/age-closer.js',
  'src/group-rules.js',
  'src/group-record.js',
  'src/titles.js',
  'src/status-reader.js',
  'src/status-core.js',
  'src/reader.js',
  'src/storage.js',
  'src/matcher.js',
  'src/rules.js',
  'src/log.js',
  'src/presets.js',
];

export async function computeSourceHash() {
  const texts = await Promise.all(
    SOURCE_FILES.map((file) => fetch(chrome.runtime.getURL(file)).then((r) => r.text())),
  );
  const bytes = new TextEncoder().encode(texts.join('\n\u0000'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
