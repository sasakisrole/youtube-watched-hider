// Synthetic verification for role-unit credit enrichment (enrich_credits.js).
// Covers HANDOFF §3.1/§3.2/§3.3 + DESIGN Part B-1/B-3/B-5/B-6:
//   - partial records (composer filled, arranger blank) become enrichment targets
//   - a channel rule that only fills the composer no longer blocks later sources
//   - each source only fills still-missing roles; remaining roles flow onward
//   - existing values are never counted as "to fill"
// Loads the IIFE with stubbed globals and exercises window.EnrichCreditsTestHooks.
// Run: node verify_enrich_credits_roles.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'enrich_credits.js'), 'utf8');

// enrich_credits.js is a browser IIFE that only sets window.* at load time (the
// controller constructor runs lazily via create(), not at load). So evaluating
// it with minimal stubs is enough to reach the pure test hooks.
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
if (!H) { console.error('EnrichCreditsTestHooks not exported'); process.exit(1); }

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- getMissingCreditRoles -------------------------------------------------
console.log('getMissingCreditRoles');
check('all blank -> all 3 missing',
  eq(H.getMissingCreditRoles({ composer: '', lyricist: '', arranger: '' }), ['composer', 'lyricist', 'arranger']));
check('composer filled -> lyricist+arranger missing',
  eq(H.getMissingCreditRoles({ composer: 'Ayase', lyricist: '', arranger: '' }), ['lyricist', 'arranger']));
check('all filled -> none missing',
  eq(H.getMissingCreditRoles({ composer: 'A', lyricist: 'B', arranger: 'C' }), []));
check('whitespace value counts as blank',
  eq(H.getMissingCreditRoles({ composer: '   ', lyricist: 'B', arranger: 'C' }), ['composer']));
check('undefined fields count as missing',
  eq(H.getMissingCreditRoles({}), ['composer', 'lyricist', 'arranger']));

// --- needsCreditEnrichment (role-unit gate) --------------------------------
console.log('needsCreditEnrichment');
const partial = { composer: 'Ayase', lyricist: '', arranger: '', creditsRaw: 'Ayase · X' };
// Core regression: the OLD gate (isUnassignedCreditRecord) EXCLUDES a partial
// record; the NEW gate INCLUDES it. Both assertions must hold or the fix is moot.
check('REGRESSION old gate excludes partial record',
  H.isUnassignedCreditRecord(partial) === false);
check('REGRESSION new gate includes partial record',
  H.needsCreditEnrichment(partial) === true);
check('fully-assigned record is not a target',
  H.needsCreditEnrichment({ composer: 'A', lyricist: 'B', arranger: 'C', creditsRaw: 'x' }) === false);
check('missing roles but no creditsRaw -> excluded by default (requireRawHint)',
  H.needsCreditEnrichment({ composer: '', lyricist: '', arranger: '', creditsRaw: '' }) === false);
check('missing roles, no creditsRaw, requireRawHint:false -> included',
  H.needsCreditEnrichment({ composer: '', lyricist: '', arranger: '' }, { requireRawHint: false }) === true);
check('null record -> false', H.needsCreditEnrichment(null) === false);

// --- coveredNeededRoles -----------------------------------------------------
console.log('coveredNeededRoles');
check('candidate fills only roles that are still missing',
  eq(H.coveredNeededRoles({ composer: 'A', lyricist: 'B', arranger: '' }, new Set(['lyricist', 'arranger'])), ['lyricist']));
check('candidate with no needed roles -> []',
  eq(H.coveredNeededRoles({ composer: 'A' }, new Set(['lyricist'])), []));
check('accepts array form of missing',
  eq(H.coveredNeededRoles({ arranger: 'Z' }, ['arranger']), ['arranger']));
check('blank candidate value is not counted',
  eq(H.coveredNeededRoles({ composer: '  ' }, new Set(['composer'])), []));

// --- limitCandidateToRoles (Blocker fix: candidate carries only its roles) --
console.log('limitCandidateToRoles');
check('blanks roles not accepted (keeps only lyricist)',
  eq(H.limitCandidateToRoles({ composer: 'B', lyricist: 'C', arranger: 'D' }, ['lyricist']),
    { composer: '', lyricist: 'C', arranger: '' }));
{
  const lim = H.limitCandidateToRoles({ videoId: 'v1', source: 'utanet', sim: 0.9, composer: 'B', arranger: '' }, ['composer']);
  check('preserves non-role fields, normalizes all roles (blank lyricist added)',
    lim.videoId === 'v1' && lim.source === 'utanet' && lim.sim === 0.9
    && lim.composer === 'B' && lim.lyricist === '' && lim.arranger === '');
}

// --- waterfallAccept (pure reference for the live 3-source loop) ------------
console.log('waterfallAccept');

// REGRESSION (Codex Blocker): a source accepted for lyricist must NOT keep its
// composer value, otherwise commit's force-write would overwrite the composer a
// prior source already supplied. The accepted candidate must be role-limited.
{
  const res = H.waterfallAccept(['composer', 'lyricist', 'arranger'], [
    { id: 'rule', candidate: { composer: 'A' } },
    { id: 'utanet', candidate: { composer: 'B', lyricist: 'C' } },
  ]);
  const utanet = res.accepted.find((a) => a.id === 'utanet');
  check('REGRESSION accepted utanet candidate does not carry composer',
    !!utanet && utanet.candidate.composer === '' && utanet.candidate.lyricist === 'C');
  const rule = res.accepted.find((a) => a.id === 'rule');
  check('REGRESSION rule keeps its composer, arranger still remaining',
    !!rule && rule.candidate.composer === 'A' && eq(res.remaining, ['arranger']));
}

// §3.2: rule fills composer only; uta-net fills lyricist; MB fills arranger.
// The rule must NOT short-circuit the remaining roles.
{
  const res = H.waterfallAccept(['composer', 'lyricist', 'arranger'], [
    { id: 'rule', candidate: { composer: 'Ayase' } },
    { id: 'utanet', candidate: { lyricist: 'ikura', composer: 'Ayase' } },
    { id: 'mb', candidate: { arranger: 'Ayase' } },
  ]);
  check('§3.2 rule(composer)->utanet(lyricist)->mb(arranger) all consulted',
    eq(res.accepted.map((a) => [a.id, a.roles]), [
      ['rule', ['composer']],
      ['utanet', ['lyricist']],
      ['mb', ['arranger']],
    ]));
  check('§3.2 nothing remaining at the end', eq(res.remaining, []));
}

// Stops early once every role is filled (MB never needed).
{
  const res = H.waterfallAccept(['composer', 'lyricist', 'arranger'], [
    { id: 'rule', candidate: { composer: 'A', lyricist: 'B', arranger: 'C' } },
    { id: 'mb', candidate: { composer: 'X' } },
  ]);
  check('waterfall stops after roles filled (mb skipped)',
    eq(res.accepted.map((a) => a.id), ['rule']) && eq(res.remaining, []));
}

// Existing value protected: composer already filled in record -> not "needed",
// so a source offering composer is ignored, but it still fills the blank arranger.
{
  const res = H.waterfallAccept(['arranger'], [
    { id: 'utanet', candidate: { composer: 'someone-else', arranger: 'RealArr' } },
  ]);
  check('existing value protected: only blank arranger accepted',
    eq(res.accepted.map((a) => [a.id, a.roles]), [['utanet', ['arranger']]]) && eq(res.remaining, []));
}

// A source that only re-offers an already-filled role adds nothing and does not
// consume the source slot's coverage; remaining still flows to the next source.
{
  const res = H.waterfallAccept(['lyricist'], [
    { id: 'rule', candidate: { composer: 'A' } },       // no needed role -> skipped
    { id: 'utanet', candidate: { lyricist: 'B' } },
  ]);
  check('§3.3 useless rule candidate does not block next source',
    eq(res.accepted.map((a) => a.id), ['utanet']) && eq(res.remaining, []));
}

// Null candidate entries (a source that returned nothing) are skipped safely.
{
  const res = H.waterfallAccept(['composer'], [
    { id: 'utanet', candidate: null },
    { id: 'mb', candidate: { composer: 'A' } },
  ]);
  check('null source candidate skipped, next source still runs',
    eq(res.accepted.map((a) => a.id), ['mb']) && eq(res.remaining, []));
}

// Unresolved role remains reported so the UI can surface it.
{
  const res = H.waterfallAccept(['composer', 'arranger'], [
    { id: 'rule', candidate: { composer: 'A' } },
  ]);
  check('unresolved role reported in remaining', eq(res.remaining, ['arranger']));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
