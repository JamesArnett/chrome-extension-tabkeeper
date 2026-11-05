import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/storage.js';
import { createChromeStorage } from './helpers/chrome-mock.js';

const rule = (id, createdAt = 0) => ({ id, name: id, enabled: true, title: null, url: null, delaySeconds: 1, createdAt });

test('rules are stored one key per rule with an order list', async () => {
  const cs = createChromeStorage();
  const s = createStorage(cs);
  await s.saveRule(rule('a'));
  await s.saveRule(rule('b'));
  const dump = cs.sync._dump();
  assert.deepEqual(Object.keys(dump).sort(), ['rule:a', 'rule:b', 'ruleOrder']);
  assert.deepEqual(dump.ruleOrder, ['a', 'b']);
  assert.deepEqual((await s.getRules()).map((r) => r.id), ['a', 'b']);
});

test('saving an existing rule keeps its position', async () => {
  const s = createStorage(createChromeStorage());
  await s.saveRule(rule('a'));
  await s.saveRule(rule('b'));
  await s.saveRule({ ...rule('a'), name: 'renamed' });
  const rules = await s.getRules();
  assert.deepEqual(rules.map((r) => r.id), ['a', 'b']);
  assert.equal(rules[0].name, 'renamed');
});

test('setRuleOrder reorders and deleteRule removes key and order entry', async () => {
  const cs = createChromeStorage();
  const s = createStorage(cs);
  await s.saveRules([rule('a'), rule('b'), rule('c')]);
  await s.setRuleOrder(['c', 'a', 'b']);
  assert.deepEqual((await s.getRules()).map((r) => r.id), ['c', 'a', 'b']);
  await s.deleteRule('a');
  assert.deepEqual((await s.getRules()).map((r) => r.id), ['c', 'b']);
  assert.equal('rule:a' in cs.sync._dump(), false);
});

test('rules missing from ruleOrder are appended oldest first', async () => {
  const cs = createChromeStorage();
  await cs.sync.set({ 'rule:x': rule('x', 50), 'rule:y': rule('y', 10), 'rule:z': rule('z', 30), ruleOrder: ['z'] });
  const s = createStorage(cs);
  assert.deepEqual((await s.getRules()).map((r) => r.id), ['z', 'y', 'x']);
});

test('paused, log, draft and pending round-trip with sane defaults', async () => {
  const s = createStorage(createChromeStorage());
  assert.equal(await s.getPaused(), false);
  await s.setPaused(true);
  assert.equal(await s.getPaused(), true);

  assert.deepEqual(await s.getLog(), []);
  await s.setLog([{ a: 1 }]);
  assert.deepEqual(await s.getLog(), [{ a: 1 }]);

  assert.equal(await s.getDraft(), null);
  await s.setDraft({ editingId: null, fields: { name: 'x' } });
  assert.deepEqual(await s.getDraft(), { editingId: null, fields: { name: 'x' } });
  await s.clearDraft();
  assert.equal(await s.getDraft(), null);

  assert.deepEqual(await s.getPending(), {});
  await s.setPending({ 7: { ruleId: 'r', deadline: 1 } });
  assert.deepEqual(await s.getPending(), { 7: { ruleId: 'r', deadline: 1 } });
});
