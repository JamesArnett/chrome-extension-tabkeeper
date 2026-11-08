import { IS_FIREFOX } from '../src/browser-api.js';

// The same bundled pages explain the browser actually running them.
export function applyBrowserCopy(root = document) {
  const copy = IS_FIREFOX ? {
    name: 'Firefox', sync: 'Firefox Sync', account: 'Mozilla account',
    shortcuts: 'about:addons → Manage Extension Shortcuts',
    access: 'Firefox → Add-ons and themes → Extensions → Tabkeeper → Permissions',
    ports: 'Firefox site grants cover all ports on that host; rules still choose which URLs are processed.',
    settingsButton: 'Access instructions',
  } : {
    name: 'Chrome', sync: 'Chrome Sync', account: 'Google account',
    shortcuts: 'chrome://extensions/shortcuts',
    access: 'Chrome → Extensions → Manage extensions → Tabkeeper → Details → Site access',
    ports: '',
    settingsButton: 'Extension settings',
  };
  for (const node of root.querySelectorAll('[data-browser-copy]')) {
    const text = copy[node.dataset.browserCopy];
    if (text !== undefined) node.textContent = text;
  }
}
