// The credit recheck also stores participants, and never writes composer, lyricist or arranger.
// Run: node tests/verify_recheck_participants.js
const assert = require('assert/strict');
const fs = require('fs');
const CM = require('../credit_corrections.js');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const start = source.indexOf("registerJobPort({\n  portName: 'recheck-credits',");
const block = source.slice(start, source.indexOf('\n});', start) + 4);
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

function load(fetchResults, dbImpl) {
  let config;
  const writes = [];
  new Function('registerJobPort', 'self', 'fetchCreditsFromWatch', 'sendToOffscreenDb', block)(
    c => { config = c; }, { CreditMaintenance: CM },
    async id => fetchResults[id],
    async (op, payload) => { writes.push([op, payload]); return dbImpl ? dbImpl(op, payload) : true; });
  return { config, writes };
}

(async () => {
  await check('participants are saved, roles are never sent', async () => {
    const { config, writes } = load({
      sampleVid01: { videoId: 'sampleVid01', ok: true, participants: [{ name: 'Kenbo', role: 'Drums arrange' }], maintenance: {} },
      sampleVid02: { videoId: 'sampleVid02', ok: true, participants: [], maintenance: {} },
      sampleVid03: { videoId: 'sampleVid03', ok: false, reason: 'timeout' },
    });
    const result = await config.run({ videoIds: ['sampleVid01', 'sampleVid02', 'sampleVid03'] }, () => {}, null);
    assert.deepEqual(writes.map(([op, p]) => [op, p.videoId, Object.keys(p.credits)]),
      [['UPDATE_CREDITS', 'sampleVid01', ['participants']], ['UPDATE_CREDITS', 'sampleVid02', ['participants']]]);
    assert.equal(result.participantsSaved, 1);
    assert.equal(result.processed, 3);
    assert.match(config.finishPatch(result).message, /作曲・作詞・編曲は変更していません。参加を1件保存しました/);
  });
  await check('a failed participant save does not fail the recheck', async () => {
    const { config } = load({ sampleVid01: { videoId: 'sampleVid01', ok: true, participants: [{ name: 'X', role: 'Strings Arrangement' }], maintenance: {} } },
      () => { throw new Error('db down'); });
    const result = await config.run({ videoIds: ['sampleVid01'] }, () => {}, null);
    assert.equal(result.processed, 1);
    assert.equal(result.participantsSaved, 0);
  });
  await check('the maintenance fetch returns participants from the description', () => {
    assert.match(source, /return \{ videoId, ok: true, title, artist, participants: extractParticipantCredits\(desc, title\),/);
  });
  console.log(`${passed} passed`);
})().catch(error => { console.error(error); process.exit(1); });
