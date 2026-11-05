import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore } from '../src/draft.js';
import { createStorage } from '../src/storage.js';
import { createChromeStorage, createClock } from './helpers/chrome-mock.js';

function setup() {
  const clock = createClock();
  const storage = createStorage(createChromeStorage());
  const draft = createDraftStore(storage, { debounceMs: 100, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { clock, storage, draft };
}

test('save is debounced and writes only the latest state', async () => {
  const { clock, storage, draft } = setup();
  draft.save({ v: 1 });
  await clock.advance(50);
  draft.save({ v: 2 });
  await clock.advance(50);
  assert.equal(await storage.getDraft(), null, 'not yet written');
  await clock.advance(50);
  assert.deepEqual(await storage.getDraft(), { v: 2 });
});

test('flush writes immediately; clear discards pending writes', async () => {
  const { clock, storage, draft } = setup();
  draft.save({ v: 1 });
  await draft.flush();
  assert.deepEqual(await storage.getDraft(), { v: 1 });
  assert.equal(clock.pendingTimers(), 0);

  draft.save({ v: 2 });
  await draft.clear();
  await clock.advance(1000);
  assert.equal(await storage.getDraft(), null);
});
