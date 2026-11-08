// Packaging differences only; all runtime logic stays shared.
export const FIREFOX_ID = 'tabkeeper@jamesarnett';
export const FIREFOX_MIN_VERSION = '140.0';

export function targetManifest(source, target = 'chrome') {
  const manifest = structuredClone(source);
  if (target === 'chrome') return manifest;
  if (target !== 'firefox') throw new Error(`Unknown browser target: ${target}`);
  delete manifest.minimum_chrome_version;
  manifest.background = { scripts: [source.background.service_worker], type: 'module' };
  manifest.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: FIREFOX_MIN_VERSION,
      // No developer/server transmission. Browser-provided sync is disclosed
      // separately in the privacy guide; no telemetry or custom sync exists.
      data_collection_permissions: { required: ['none'] },
    },
  };
  return manifest;
}
