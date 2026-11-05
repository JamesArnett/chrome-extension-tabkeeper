import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLogEntry, clearLog } from '../src/log.js';
import { createStorage } from '../src/storage.js';
import { createChromeStorage } from './helpers/chrome-mock.js';

test('addLogEntry prepends and caps the log', async () => {
  const s = createStorage(createChromeStorage());
  for (let i = 0; i < 5; i++) await addLogEntry(s, { n: i }, 3);
  assert.deepEqual(await s.getLog(), [{ n: 4 }, { n: 3 }, { n: 2 }]);
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
  assert.deepEqual(await s.getLog(), [{ n: 2 }]);
});
