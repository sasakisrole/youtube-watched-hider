const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const block = source.slice(source.indexOf('function getEnrichMbUserAgent'), source.indexOf('// Generate backup filename'))
  .replace(/async function mbGet\(path, params\) \{[\s\S]*?\n\}(?=\n\nfunction collectMbRole)/,
    'async function mbGet(path, params) { return mock(path, params); }');
const recording = (id, title = 'Morning', artist = 'Example Artist', score = 100) => ({
  id, title, score, 'artist-credit': [{ name: artist, artist: { name: artist } }],
});
const role = (type, name) => ({ type, artist: { name } });
async function lookup(records, details, title = 'Morning', titleOnly = []) {
  const calls = [];
  const mock = async (url, params) => {
    calls.push(url);
    if (url === 'recording/') return { recordings: params.query.includes('artist:') ? records : titleOnly };
    if (details[url] instanceof Error) throw details[url];
    return details[url] || { relations: [] };
  };
  const run = new Function('self', 'chrome', 'mock', block + '\nreturn enrichCreditsLookupMb;')(
    { CreditTarget: require(path.join(root, 'credit_target.js')) },
    { runtime: { getManifest: () => ({ version: 'test' }) } }, mock);
  return { result: await run('Example Artist', title), calls };
}
let passed = 0;
let failed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
(async () => {
  await check('second exact recording supplies a manual composer candidate', async () => {
    const { result, calls } = await lookup([recording('empty'), recording('second')], {
      'recording/second': { relations: [role('composer', 'Composer B'), role('lyricist', 'Writer B'), role('arranger', 'Other Arrangement')] },
    });
    assert.equal(result.candidate.composer, 'Composer B');
    assert.equal(result.candidate.lyricist, 'Writer B');
    assert.equal(result.candidate.arranger, '');
    assert.equal(result.candidate.autoEligible, false);
    assert.equal(result.candidate.requiresManualReview, true);
    assert.match(result.candidate.manualReviewReason, /alternate-recording/);
    assert.equal(result.candidate.mbid, 'second');
    assert.deepEqual(calls, ['recording/', 'recording/empty', 'recording/second']);
  });
  await check('first recording with credits keeps existing behavior and stops', async () => {
    const { result, calls } = await lookup([recording('first'), recording('second')], {
      'recording/first': { relations: [role('composer', 'Composer A'), role('arranger', 'Arranger A')] },
    });
    assert.equal(result.candidate.arranger, 'Arranger A');
    assert.equal(result.candidate.autoEligible, true);
    assert.equal(calls.length, 2);
  });
  await check('arranger-only alternate is skipped; third work supplies composer', async () => {
    const { result } = await lookup([recording('first'), recording('second'), recording('third')], {
      'recording/second': { relations: [role('arranger', 'Other Arrangement')] },
      'recording/third': { relations: [{ type: 'performance', work: { id: 'work' } }] },
      'work/work': { relations: [role('composer', 'Work Composer')] },
    });
    assert.equal(result.candidate.composer, 'Work Composer');
    assert.equal(result.candidate.arranger, '');
  });
  await check('different artist, title, version and low score are not alternates', async () => {
    const candidates = [recording('first'), recording('other', 'Morning', 'Other Artist'), recording('title', 'Evening'), recording('live', 'Morning (Live)'), recording('weak', 'Morning', 'Example Artist', 70)];
    const { result, calls } = await lookup(candidates, {});
    assert.equal(result.candidate, null);
    assert.deepEqual(calls, ['recording/', 'recording/first']);
  });
  await check('duplicate IDs do not consume the three-recording budget', async () => {
    const { result, calls } = await lookup([recording('first'), recording('first'), recording('second')], {
      'recording/second': { relations: [role('composer', 'Composer B')] },
    });
    assert.equal(result.candidate.mbid, 'second');
    assert.equal(calls.filter(x => x === 'recording/first').length, 1);
  });
  await check('three-recording limit bounds requests to thirteen including works', async () => {
    const details = {};
    for (const id of ['one', 'two', 'three', 'four']) details['recording/' + id] = {
      relations: [1, 2, 3].map(n => ({ work: { id: id + n } })),
    };
    const { result, calls } = await lookup(['one', 'two', 'three', 'four'].map(id => recording(id)), details);
    assert.equal(result.reason, 'no-roles');
    assert.equal(calls.length, 13);
    assert.equal(calls.includes('recording/four'), false);
  });
  await check('alternate HTTP failure stays an error, not a negative result', async () => {
    await assert.rejects(() => lookup([recording('one'), recording('two')], {
      'recording/two': new Error('HTTP 503'),
    }), /HTTP 503/);
  });
  await check('fuzzy path retains its single recording and manual review', async () => {
    const { result, calls } = await lookup([], {
      'recording/fuzzy': { relations: [role('composer', 'Composer A')] },
    }, 'Morning', [recording('fuzzy', 'Morning', 'Example Artist', 88), recording('second', 'Morning', 'Example Artist', 80)]);
    assert.equal(result.candidate.autoEligible, false);
    assert.equal(result.candidate.stage, 'fuzzy');
    assert.equal(calls.length, 3);
  });
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
