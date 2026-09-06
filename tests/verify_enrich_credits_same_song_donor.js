// Synthetic verification for same-song credit donors (enrich_credits.js).
// Run: node tests/verify_enrich_credits_same_song_donor.js
const fs = require('fs');
const path = require('path');

let src = fs.readFileSync(path.join(__dirname, '..', 'enrich_credits.js'), 'utf8');
// Mutate only the evaluated source so the production file never needs restoring.
if (process.argv.includes('--disable-transfers')) {
  const signature = 'function collectSameSongDonorCandidates(records, donorIndex) {';
  if (!src.includes(signature)) throw new Error('transfer mutation target missing');
  src = src.replace(signature, `${signature}\n    return [];`);
}
const CreditTarget = require(path.join(__dirname, '..', 'credit_target.js'));
const win = { CreditTarget };
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

function collectFor(taker, donors) {
  const records = [...donors, taker];
  return H.collectSameSongDonorCandidates(records, H.createSameSongDonorIndex(records))
    .filter((entry) => entry.record === taker);
}

console.log('donor-only eligibility');
{
  const donor = record('full-donor', {
    composer: 'Donor Composer', lyricist: 'Donor Lyricist', arranger: 'Donor Arranger',
  });
  for (const creditsRaw of ['', undefined, '   ']) {
    const taker = record('rawless-taker', { creditsRaw });
    const before = JSON.stringify([donor, taker]);
    const candidates = collectFor(taker, [donor]);
    check(`GATE-1 empty creditsRaw collects a donor candidate (${JSON.stringify(creditsRaw)})`,
      candidates.length === 1 && candidates[0].candidate.composer === 'Donor Composer');
    check('collection leaves input records unchanged', JSON.stringify([donor, taker]) === before);
    check('default enrichment gate still requires creditsRaw', !H.needsCreditEnrichment(taker));
  }
  check('fully filled records are excluded from collection', collectFor(donor, [donor]).length === 0);
}
{
  const taker = record('no-donor', { creditsRaw: '' });
  check('GATE-2 empty creditsRaw without a matching donor yields no candidate',
    collectFor(taker, [record('other-song', { title: 'Other Song', composer: 'Other Composer' })]).length === 0);
}
{
  const taker = record('conflict-collection', { creditsRaw: '' });
  const candidates = collectFor(taker, [
    record('conflict-a', { composer: 'Alice', lyricist: 'Shared Lyricist' }),
    record('conflict-b', { composer: 'Bob', lyricist: 'Shared Lyricist' }),
  ]);
  check('GATE-3 conflicting role is excluded while an unambiguous role transfers',
    candidates.length === 1 && candidates[0].candidate.composer === ''
      && candidates[0].candidate.lyricist === 'Shared Lyricist');
}
{
  const taker = record('duration-collection', { creditsRaw: '' });
  check('GATE-4 duration difference over 10% is excluded from collection',
    collectFor(taker, [record('long-donor', { durationSec: 223, composer: 'Alice' })]).length === 0);
}

async function exerciseGeneration(records, { rules = [], limit = null, onCandidate, abortBeforePass = false } = {}) {
  const calls = { config: 0, mb: [], queries: [], lookups: [], confirmation: null };
  const window = {
    CreditTarget: {
      ...CreditTarget,
      shouldQueryMb(video, options) {
        calls.queries.push({ videoId: video.videoId, missingRoles: [...options.missingRoles] });
        return true;
      },
    },
  };
  const chrome = { runtime: {
    lastError: null,
    sendMessage(message, callback) {
      if (message.type !== 'getEnrichCreditsConfig') throw new Error(`unexpected runtime message: ${message.type}`);
      calls.config++;
      callback({ success: true, rateLimitMs: 1000 });
    },
  } };
  new Function('window', 'document', 'chrome', src)(window, doc, chrome);
  const controller = window.EnrichCredits.create({
    getRecords: () => records, beginMaintenance: () => true, endMaintenance() {},
  });
  controller.confirmGeneration = async (preCount, rateLimitMs, groups, _rules, _load, _records, sameSongCount) => {
    calls.confirmation = { preCount, groups, sameSongCount };
    return { limit };
  };
  controller.loadRules = async () => {
    if (abortBeforePass) controller.abortRequested = true;
    return rules;
  };
  controller.fetchMb = async (channel, title) => {
    calls.mb.push({ channel, title });
    return { success: true, candidate: {
      mbTitle: title, composer: 'MB Composer', lyricist: 'MB Lyricist', arranger: 'MB Arranger',
      sim: 1, stage: 'strict', autoEligible: true, requiresManualReview: false, versionMatch: true,
    } };
  };
  controller.recordMbLookup = async (videoId, details) => {
    calls.lookups.push({ videoId, ...details });
    return true;
  };
  if (onCandidate) {
    const addCandidate = controller.addCandidate.bind(controller);
    controller.addCandidate = (candidate) => {
      const added = addCandidate(candidate);
      onCandidate(controller, candidate, added);
      return added;
    };
  }
  await controller.generateCandidates();
  check('generation completes without errors', controller.errors.length === 0 && !controller.generating);
  return { controller, calls, candidates: controller.getAllCandidates() };
}

async function runGenerationCases() {
  console.log('real generation prepass and waterfall');
  const donor = record('generation-donor', {
    composer: 'Donor Composer', lyricist: 'Donor Lyricist', arranger: 'Donor Arranger',
  });
  const rawless = record('rawless-generation', { creditsRaw: '' });
  const local = await exerciseGeneration([donor, rawless]);
  check('GATE-1 empty creditsRaw generates a same-song candidate with no Tier A groups',
    local.candidates.length === 1 && local.candidates[0].source === 'same-song'
      && local.candidates[0].videoId === rawless.videoId
      && local.controller.groupUnassigned([donor, rawless]).size === 0);
  check('rawless donor-only generation performs no MusicBrainz lookup or stamp',
    local.calls.mb.length === 0 && local.calls.lookups.length === 0);
  const noDonor = await exerciseGeneration([record('unmatched', { creditsRaw: '' })]);
  check('GATE-2 no donor and no raw hint skips confirmation and network work',
    noDonor.candidates.length === 0 && noDonor.calls.config === 0 && noDonor.calls.mb.length === 0);

  const tierA = record('tier-a', { creditsRaw: 'credit hint', lyricist: 'Donor Lyricist' });
  const partialDonor = { ...donor, arranger: '' };
  const partial = await exerciseGeneration([partialDonor, tierA]);
  const transferred = partial.candidates.find((candidate) => candidate.source === 'same-song');
  const mb = partial.candidates.find((candidate) => candidate.source === 'mb');
  check('GATE-5 transferred roles never reach MusicBrainz',
    partial.calls.queries.length === 1
      && JSON.stringify(partial.calls.queries[0].missingRoles) === '["arranger"]'
      && JSON.stringify(partial.calls.lookups[0].missingRoles) === '["arranger"]'
      && transferred && transferred.composer === 'Donor Composer'
      && mb && mb.composer === '' && mb.lyricist === '' && mb.arranger === 'MB Arranger');
  const complete = await exerciseGeneration([donor, tierA]);
  check('GATE-5 fully covered Tier A video skips MusicBrainz entirely',
    complete.calls.mb.length === 0 && complete.calls.queries.length === 0
      && complete.candidates.some((candidate) => candidate.source === 'same-song'));

  const ruled = await exerciseGeneration([partialDonor, { ...tierA, lyricist: '' }], {
    rules: [{ channel: tierA.channel, composer: 'Rule Composer' }],
  });
  check('rule then donor then MusicBrainz each fills only its remaining role',
    JSON.stringify(ruled.candidates.map((candidate) => [candidate.source, candidate.composer, candidate.lyricist, candidate.arranger]))
      === JSON.stringify([
        ['rule', 'Rule Composer', '', ''], ['same-song', '', 'Donor Lyricist', ''], ['mb', '', '', 'MB Arranger'],
      ]));

  const rejected = await exerciseGeneration([donor, {
    ...rawless, creditReviewRejections: { composer: '["Donor Composer"]' },
  }]);
  check('prepass filters rejected values and keeps other donor roles',
    rejected.candidates.length === 1 && rejected.candidates[0].composer === ''
      && rejected.candidates[0].lyricist === 'Donor Lyricist');
  const rejectedTierA = await exerciseGeneration([partialDonor, {
    ...tierA, creditReviewRejections: { composer: '["Donor Composer"]' },
  }]);
  check('rejected donor role remains available to MusicBrainz',
    JSON.stringify(rejectedTierA.calls.queries[0].missingRoles) === '["composer","arranger"]'
      && rejectedTierA.candidates.every((candidate) => candidate.composer !== 'Donor Composer'));

  const networkRecords = Array.from({ length: 12 }, (_, i) => record(`network-${i}`, {
    title: `Unique Song ${i}`, channel: 'Network Channel', creditsRaw: 'credit hint',
  }));
  const donorTargets = Array.from({ length: 11 }, (_, i) => record(`local-${i}`, { creditsRaw: '' }));
  const outsideLimit = record('outside-limit', { creditsRaw: 'credit hint' });
  const limited = await exerciseGeneration([...networkRecords, donor, ...donorTargets, outsideLimit], { limit: 10 });
  check('limit 10 caps MusicBrainz while all 12 donor targets still transfer',
    limited.calls.mb.length === 10 && limited.calls.queries.every((query) => query.videoId.startsWith('network-'))
      && limited.candidates.filter((candidate) => candidate.source === 'same-song').length === 12
      && limited.candidates.some((candidate) => candidate.videoId === outsideLimit.videoId));
  check('confirmation receives donor count separately from the gated video count',
    limited.calls.confirmation.sameSongCount === 12 && limited.calls.confirmation.preCount.videoCount === 13);
  check('all donor candidates are registered before the first channel lookup',
    limited.candidates.slice(0, 12).every((candidate) => candidate.source === 'same-song'));

  const aborted = await exerciseGeneration([donor, ...donorTargets, tierA], {
    onCandidate(controller, candidate) {
      if (candidate.source === 'same-song') controller.abortRequested = true;
    },
  });
  check('prepass stops on an abort between donor candidates',
    aborted.candidates.length === 1 && aborted.calls.mb.length === 0);
  const abortedBefore = await exerciseGeneration([donor, rawless], { abortBeforePass: true });
  check('prepass respects an abort before its first candidate',
    abortedBefore.candidates.length === 0 && abortedBefore.calls.mb.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

runGenerationCases().catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 1;
});
