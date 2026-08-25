// Synthetic verification for same-song credit donors (enrich_credits.js).
// Run: node tests/verify_enrich_credits_same_song_donor.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'enrich_credits.js'), 'utf8');
const win = {};
const doc = {
  getElementById: () => null,
  addEventListener: () => {},
  querySelectorAll: () => [],
  createElement: () => ({ appendChild() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} }, style: {} }),
  createDocumentFragment: () => ({ appendChild() {} }),
  body: { classList: { add() {}, remove() {} } },
};
const chromeStub = { runtime: { getURL: () => '', getManifest: () => ({ version: 'test' }), sendMessage: () => {}, lastError: null } };
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'chrome', src)(win, doc, chromeStub);
const H = win.EnrichCreditsTestHooks;

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function record(videoId, overrides = {}) {
  return {
    videoId,
    title: 'Blue Sky',
    channel: 'Example Artist',
    durationSec: 200,
    composer: '',
    lyricist: '',
    arranger: '',
    ...overrides,
  };
}

function candidateFor(taker, donors) {
  return H.createSameSongDonorCandidate(taker, H.createSameSongDonorIndex([...donors, taker]));
}

console.log('same-song donor generation');
{
  const taker = record('taker', { composer: 'Existing Composer', durationSec: 209 });
  const donor = record('donor', {
    title: 'BLUE SKY (Official Music Video)',
    channel: 'Example Artist - Topic',
    durationSec: 200,
    composer: 'Donor Composer',
    lyricist: 'Donor Lyricist',
    arranger: 'Donor Arranger',
  });
  const candidate = candidateFor(taker, [donor]);
  check('REQ-1 same key, single donor, and duration within 10% fills blank roles',
    candidate && candidate.lyricist === 'Donor Lyricist' && candidate.arranger === 'Donor Arranger');
  check('REQ-1 candidate records same-song source and donor video',
    candidate && candidate.source === 'same-song' && candidate.sourceDetail.includes('lyricist:donor'));
  check('REQ-1 same-song candidate eliminates the external-request minimum',
    H.getMinimumEnrichmentRequestCount(
      new Map([[taker.channel, [taker]]]), [], new Map(), [donor, taker]) === 0);
  check('REQ-1 persisted source value has a display label',
    H.CREDIT_SOURCE_LABELS['enrich:same-song'] === '同一楽曲の別動画');
  check('REQ-4 existing role is not overwritten',
    candidate && candidate.composer === '' && taker.composer === 'Existing Composer');
}

{
  const taker = record('conflict-taker');
  const candidate = candidateFor(taker, [
    record('donor-a', { composer: 'Alice' }),
    record('donor-b', { composer: 'Bob' }),
  ]);
  check('REQ-2 conflicting donor values produce no candidate', candidate === null);
}

console.log('duration guard');
{
  const taker = record('far-taker', { durationSec: 200 });
  const candidate = candidateFor(taker, [record('far-donor', { durationSec: 223, composer: 'Alice' })]);
  check('REQ-3 duration difference over 10% produces no candidate', candidate === null);
}
{
  const taker = record('unknown-taker', { durationSec: null });
  const candidate = candidateFor(taker, [record('known-donor', { composer: 'Alice' })]);
  check('REQ-3 unknown taker duration produces no candidate', candidate === null);
}
{
  const taker = record('known-taker');
  const candidate = candidateFor(taker, [record('unknown-donor', { durationSec: undefined, composer: 'Alice' })]);
  check('REQ-3 unknown donor duration produces no candidate', candidate === null);
}

console.log('normalization');
check('REQ-5 bracketed title content is removed',
  H.normalizeSameSongTitle('Blue Sky (Official MV) [HD]【Lyrics】（Live）') === 'bluesky');
check('REQ-5 trailing Topic channel suffix is removed',
  H.normalizeSameSongChannel('Example Artist - Topic') === H.normalizeSameSongChannel('Example Artist'));
check('REQ-5 title decorators are removed at word boundaries',
  H.normalizeSameSongTitle('Official Blue Sky Music Video 4K Remastered') === 'bluesky');
check('REQ-5 empty normalized key is excluded',
  H.sameSongGroupKey(record('empty', { title: 'Official MV', channel: ' - Topic' })) === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
