// Machine-readable companion to Node's spec reporter (Node 24+ in CI).
export default async function* reporter(events) {
  let coverage;
  let tests;
  for await (const { type, data } of events) {
    if (type === 'test:coverage') coverage = data.summary.totals;
    if (type === 'test:summary' && !data.file) tests = { ...data.counts, success: data.success };
  }
  if (!coverage || !tests) throw new Error('Incomplete test/coverage report.');
  yield JSON.stringify({ coverage, tests }) + '\n';
}
