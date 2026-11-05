import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupRecord } from '../src/group-record.js';
import { createStorage } from '../src/storage.js';
import { createChromeStorage } from './helpers/chrome-mock.js';

test('record round-trips through session storage and supports lookups by group id', async () => {
  const cs = createChromeStorage();
  const storage = createStorage(cs);
  const rec = createGroupRecord(storage);
  await rec.load();
  rec.set(1, 'ABC-123', { groupId: 10, status: null, ruleId: 'r' });
  rec.set(1, 'ABC-124', { groupId: 11, status: 'Done', ruleId: 'r' });
  rec.set(2, 'ABC-123', { groupId: 12, status: null, ruleId: 'r' });
  await rec.persist();

  const again = createGroupRecord(storage);
  await again.load();
  assert.deepEqual(again.get(1, 'ABC-124'), { groupId: 11, status: 'Done', ruleId: 'r' });
  assert.deepEqual(again.findByGroupId(12), { windowId: 2, baseTitle: 'ABC-123', entry: { groupId: 12, status: null, ruleId: 'r' } });
  assert.equal(again.findByGroupId(99), null);
  assert.equal(again.removeGroup(11), true);
  assert.equal(again.get(1, 'ABC-124'), null);
  assert.equal(again.removeWindow(2), true);
  assert.deepEqual(again.entries(), [{ windowId: 1, baseTitle: 'ABC-123', groupId: 10, status: null, ruleId: 'r' }]);
  assert.equal(again.remove(1, 'ABC-123'), true);
  assert.deepEqual(again.snapshot(), {});
});
