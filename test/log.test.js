import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLogEntry, clearLog, historyUrl, readLog } from '../src/log.js';
import { createStorage } from '../src/storage.js';
import { createChromeStorage } from './helpers/chrome-mock.js';

test('addLogEntry prepends and caps the log', async () => {
  const s = createStorage(createChromeStorage());
  for (let i = 0; i < 5; i++) await addLogEntry(s, { n: i }, 3);
  assert.deepEqual(await s.getLog(), [{ n: 4, url: '' }, { n: 3, url: '' }, { n: 2, url: '' }]);
  await clearLog(s);
  assert.deepEqual(await s.getLog(), []);
});

test('concurrent rule and age closes retain every history entry', async () => {
  const s = createStorage(createChromeStorage());
  await Promise.all(Array.from({ length: 20 }, (_, n) => addLogEntry(s, { n })));
  const log = await s.getLog();
  assert.equal(log.length, 20);
  assert.equal(new Set(log.map((e) => e.n)).size, 20);
});

test('clearing history cannot be undone by an earlier in-flight append', async () => {
  const s = createStorage(createChromeStorage());
  await Promise.all([addLogEntry(s, { n: 1 }), clearLog(s)]);
  assert.deepEqual(await s.getLog(), []);
});

test('a failed log write does not block later writes', async () => {
  const s = createStorage(createChromeStorage());
  const set = s.setLog;
  s.setLog = async () => { throw new Error('write failed'); };
  await assert.rejects(addLogEntry(s, { n: 1 }), /write failed/);
  s.setLog = set;
  await addLogEntry(s, { n: 2 });
  assert.deepEqual(await s.getLog(), [{ n: 2, url: '' }]);
});

test('history removes URL credentials, queries and fragments and rejects non-web schemes', () => {
  assert.equal(historyUrl('https://user:secret@example.com/reset?token=secret#credential'), 'https://example.com/reset');
  for (const url of ['data:text/html,secret', 'file:///private/secret', 'javascript:alert(1)', 'invalid']) {
    assert.equal(historyUrl(url), '');
  }
});

test('legacy history is scrubbed on disk and a concurrent Clear stays cleared', async () => {
  const s = createStorage(createChromeStorage());
  await s.setLog([{ url: 'https://example.com/ticket?token=secret#private' }, { url: 'data:text/html,secret' }]);
  assert.deepEqual(await readLog(s), [{ url: 'https://example.com/ticket' }, { url: '' }]);
  assert.deepEqual(await s.getLog(), [{ url: 'https://example.com/ticket' }, { url: '' }]);
  await Promise.all([readLog(s), clearLog(s)]);
  assert.deepEqual(await s.getLog(), []);
});
