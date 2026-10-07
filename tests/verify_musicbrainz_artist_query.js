const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const block = source.slice(source.indexOf('function getEnrichMbUserAgent'), source.indexOf('// Generate backup filename'))
  .replace(/async function mbGet\(path, params\) \{[\s\S]*?\n\}(?=\n\nfunction collectMbRole)/,
    'async function mbGet(path, params) { return mock(path, params); }');
const makeRecording = (id, artist, title = 'Morning') => ({ id, title, score: 100,
  'artist-credit': [{ name: artist, artist: { name: artist } }],
});
function runLookup(artist, answer) {
  const calls = [];
  const mock = async (url, params) => { calls.push({ url, query: params.query }); return answer(url, params); };
  const run = new Function('self', 'chrome', 'mock', block + '\nreturn enrichCreditsLookupMb;')(
    { CreditTarget: require(path.join(root, 'credit_target.js')) },
    { runtime: { getManifest: () => ({ version: 'test' }) } }, mock);
  return run(artist, 'Morning').then(result => ({ result, calls }));
}
const credit = { relations: [{ type: 'composer', artist: { name: 'Composer' } }] };
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
(async () => {
  for (const [channel, artist] of [
    ['Example Official YouTube Channel', 'Example'],
    ['Example YouTube OFFICIAL CHANNEL', 'Example'],
    ['Example Official', 'Example'],
    ['Example Channel', 'Example'],
    ['Example | official channel', 'Example'],
    ['Example Official YouTube', 'Example'],
    ['音楽家 公式チャンネル', '音楽家'],
    ['音楽家チャンネル', '音楽家'],
    ['【公式】音楽家', '音楽家'],
  ]) await check('retry decorated channel ' + channel, async () => {
    const { result, calls } = await runLookup(channel, (url, params) => url === 'recording/'
      ? { recordings: params.query === `artist:"${artist}" AND recording:"Morning"` ? [makeRecording('match', artist)] : [] }
      : credit);
    assert.equal(result.candidate.composer, 'Composer');
    assert.equal(result.candidate.autoEligible, false);
    assert.equal(result.candidate.requiresManualReview, true);
    assert.match(result.candidate.manualReviewReason, /artist-name-cleanup/);
    assert.equal(calls[0].query, `artist:"${channel}" AND recording:"Morning"`);
    assert.equal(calls.length, 3);
  });
  await check('original exact artist remains first and automatically eligible', async () => {
    const { result, calls } = await runLookup('Example Official', url => url === 'recording/'
      ? { recordings: [makeRecording('original', 'Example Official')] } : credit);
    assert.equal(result.candidate.autoEligible, true);
    assert.equal(calls.length, 2);
  });
  for (const channel of ['Official HIGE BAND', 'Channel Orange', 'ExampleOfficial', 'Official', '公式', 'TV Artist']) {
    await check('preserve ambiguous or non-suffix name ' + channel, async () => {
      const { result, calls } = await runLookup(channel, () => ({ recordings: [] }));
      assert.equal(result.reason, 'no-recording');
      assert.equal(calls.length, 2);
    });
  }
  await check('cleaned query still rejects other artists', async () => {
    const { result } = await runLookup('Example Official', url => url === 'recording/'
      ? { recordings: [makeRecording('wrong', 'Other Artist')] } : credit);
    assert.equal(result.candidate, null);
  });
  await check('same artist with another title is not a strict match after cleanup', async () => {
    const { result, calls } = await runLookup('Example Official', (url, params) => url === 'recording/'
      ? { recordings: params.query.includes('artist:') ? [makeRecording('wrong-title', 'Example', 'Evening')] : [] }
      : credit);
    assert.equal(result.candidate, null);
    assert.equal(calls.length, 3);
    assert.equal(calls.some(call => call.url === 'recording/wrong-title'), false);
  });
  await check('cleanup failure propagates as an error', async () => {
    await assert.rejects(() => runLookup('Example Official', (_url, params) => {
      if (params.query.includes('artist:"Example"')) throw new Error('HTTP 503');
      return { recordings: [] };
    }), /HTTP 503/);
  });
  await check('cleanup plus three recordings fits fourteen-request bound', async () => {
    const { result, calls } = await runLookup('Example Official', (url, params) => {
      if (url === 'recording/') return { recordings: params.query.includes('artist:"Example"')
        ? ['one', 'two', 'three', 'four'].map(id => makeRecording(id, 'Example')) : [] };
      if (url.startsWith('recording/')) return { relations: [1, 2, 3].map(n => ({ work: { id: url.split('/')[1] + n } })) };
      return { relations: [] };
    });
    assert.equal(result.reason, 'no-roles');
    assert.equal(calls.length, 14);
  });
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
