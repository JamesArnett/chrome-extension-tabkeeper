// Copied into the disposable browser-test extension only.
import { api } from '../src/browser-api.js';
import { defaultCloseSettings } from '../src/age-closer.js';
import { reopenEntry } from '../popup/shared.js';

export async function runSecurityChecks({ origin, tabId }) {
  const messages = [];
  const verify = (condition, message) => {
    if (!condition) throw new Error(message);
    messages.push(message);
  };
  const until = async (fn) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fn()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Security test timed out waiting for import UI/storage');
  };
  const original = await api.storage.sync.get(null);
  const originalLimit = (await api.storage.local.get('maxTitleLength')).maxTitleLength;
  const originalRule = Object.entries(original).find(([key]) => key.startsWith('rule:'));
  const text = document.getElementById('import-text');
  const preview = document.getElementById('import-preview');
  const confirmButton = document.getElementById('confirm-import');
  const loadPreview = (data) => {
    text.value = JSON.stringify(data);
    text.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('import-rules').click();
  };
  const data = {
    rules: [{
      id: originalRule[1].id, name: 'Security import <img src=x>', enabled: true, title: null,
      url: { mode: 'startsWith', pattern: 'https://', caseSensitive: false }, delaySeconds: 0,
    }],
    groupRules: [{ id: 'security-group', name: 'Security import group', enabled: true, regex: 'example', titleTemplate: 'Example' }],
    closeSettings: { ...defaultCloseSettings(), neverClose: ['security-import'] },
    awsSettings: { enabled: false }, settings: { maxTitleLength: 17 },
  };
  try {
    loadPreview(data);
    verify(!preview.hidden && preview.textContent.includes('Broad match warning') && !preview.querySelector('img'),
      'import preview flags broad rules and renders imported names as text');
    verify(JSON.stringify(await api.storage.sync.get(null)) === JSON.stringify(original),
      'preview writes no rules or settings');
    verify(preview.querySelectorAll('input:checked').length === 0, 'imported settings require separate opt-in');
    document.getElementById('cancel-import').click();
    verify(preview.hidden, 'Cancel dismisses the import without applying it');
    loadPreview(data);
    text.dispatchEvent(new Event('input', { bubbles: true }));
    verify(preview.hidden, 'editing pasted JSON invalidates its confirmation preview');
    loadPreview(data);
    confirmButton.click();
    await until(() => preview.hidden);
    const after = await api.storage.sync.get(null);
    const added = Object.values(after).filter((entry) => entry?.name?.startsWith('Security import'));
    verify(added.length === 2 && added.every((rule) => rule.enabled === false) &&
      added.find((rule) => rule.delaySeconds !== undefined).delaySeconds === 60,
    'confirmed imports add disabled rules with at least a 60-second close delay');
    verify(JSON.stringify(after[originalRule[0]]) === JSON.stringify(originalRule[1]),
      'importing an existing ID preserves the original rule');
    verify(JSON.stringify(after.closeSettings) === JSON.stringify(original.closeSettings) &&
      JSON.stringify(after.awsSettings) === JSON.stringify(original.awsSettings) &&
      (await api.storage.local.get('maxTitleLength')).maxTitleLength === originalLimit,
    'unchecked age, AWS and display settings are preserved');

    const oldConfirm = globalThis.confirm;
    try {
      loadPreview({ closeSettings: data.closeSettings });
      preview.querySelector('[data-import-setting="age"]').checked = true;
      globalThis.confirm = () => false;
      confirmButton.click();
      verify(!preview.hidden && JSON.stringify((await api.storage.sync.get('closeSettings')).closeSettings) === JSON.stringify(original.closeSettings),
        'declining the age-settings confirmation preserves limits and the never-close list');
      globalThis.confirm = () => true;
      confirmButton.click();
      await until(() => preview.hidden);
      verify((await api.storage.sync.get('closeSettings')).closeSettings.neverClose[0] === 'security-import',
        'age settings apply only after their additional confirmation');
    } finally {
      globalThis.confirm = oldConfirm;
    }
    loadPreview({ awsSettings: data.awsSettings, settings: data.settings });
    for (const input of preview.querySelectorAll('input')) input.checked = true;
    confirmButton.click();
    await until(() => preview.hidden);
    verify((await api.storage.sync.get('awsSettings')).awsSettings.enabled === false &&
      (await api.storage.local.get('maxTitleLength')).maxTitleLength === 17,
    'selected AWS and title settings apply after confirmation');
  } finally {
    const current = await api.storage.sync.get(null);
    await api.storage.sync.remove(Object.keys(current).filter((key) => !(key in original)));
    await api.storage.sync.set(original);
    if (originalLimit === undefined) await api.storage.local.remove('maxTitleLength');
    else await api.storage.local.set({ maxTitleLength: originalLimit });
  }

  await api.scripting.executeScript({ target: { tabId }, func: () => {
    for (const [type, autocomplete] of [['password', ''], ['hidden', ''], ['text', 'cc-number'], ['text', 'one-time-code']]) {
      const input = document.createElement('input');
      input.type = type;
      input.autocomplete = autocomplete;
      input.value = 'secret-security-value';
      input.className = 'security-sensitive';
      document.body.append(input);
    }
  } });
  const result = await api.runtime.sendMessage({ type: 'group-test', tabId, rule: {
    regex: '/ticket/', titleTemplate: 'Security test', statusEnabled: true, siteOrigin: origin,
    statusFields: [{ selector: '.security-sensitive' }],
  } });
  verify(result.ok && result.fields?.[0]?.raw === '' && result.fields[0].value === '',
    'page reader excludes credential values from status and raw Test previews');
  await api.scripting.executeScript({ target: { tabId }, func: () => {
    document.querySelectorAll('.security-sensitive').forEach((node) => node.remove());
  } });
  for (const url of ['data:text/html,secret', 'file:///private/secret', 'javascript:alert(1)']) {
    verify(await reopenEntry({ url }) === false, `history refuses to reopen ${url.split(':')[0]} URLs`);
  }
  return messages;
}
