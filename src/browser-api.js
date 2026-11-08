// Firefox's browser namespace provides Promise APIs; Chrome 121+ provides them
// on chrome. Prefer browser where available without adding a runtime polyfill.
export const api = globalThis.browser ?? globalThis.chrome;
export const IS_FIREFOX = typeof api?.runtime?.getBrowserInfo === 'function';

// Firefox match patterns cannot contain ports. The browser grant covers the
// host's ports; URL rules still determine which actual pages are processed.
export function hostPermission(origin, firefox = IS_FIREFOX) {
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return firefox ? `${url.protocol}//${url.hostname}/*` : `${url.origin}/*`;
  } catch { return ''; }
}

export function isExtensionUrl(url, baseUrl) {
  return typeof url === 'string' && typeof baseUrl === 'string' && baseUrl.endsWith('/') && url.startsWith(baseUrl);
}

// Sender identity comes from the browser, never from the message payload.
export function isExtensionSender(sender, extensionId, baseUrl) {
  return sender?.id === extensionId && isExtensionUrl(sender?.url, baseUrl);
}

export function extensionSettingsUrl(extensionId, firefox = IS_FIREFOX) {
  // Firefox rejects tabs.create for privileged about:addons URLs. Show the
  // manual access instructions rather than offer a silently broken link.
  return firefox ? null : `chrome://extensions/?id=${extensionId}`;
}
