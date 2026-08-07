// Verification for the Watch Later bulk-cleanup feature, Round A/B (scan only).
// Run: node verify_watch_later_core.js
//
// Two layers:
//   1. watch_later_core.js is required directly (it is pure by construction).
//   2. background.js's shared extractor is sliced out and eval'd the same way
//      verify_liked_sync_robustness.js does, so the setVideoId harvesting and the
//      Watch-Later-scoped continuation rules are exercised against real source.
//
// The fixture is SYNTHETIC (fixtures/watch_later_browse.json). It pins the rules we
// decided — never collapse duplicate videoIds, never take a row or a token from a
// recommendation shelf, never treat an unknown DB answer as "not watched" — but it
// does NOT prove the 2026 live renderer layout. Replace it with a real capture
// before trusting the scan's absolute counts (HANDOFF I-093).
const fs = require('fs');
const path = require('path');

const Core = require('../watch_later_core.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'watch_later_browse.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Slice the real extractor out of background.js -------------------------
// extractFn slices to the next top-level `function`, so the findFirstSetVideoId
// slice carries the LL_PRIMARY_RENDERERS / LL_CONTINUATION_ENVELOPES consts.
function extractFn(name) {
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('fn not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}
const harness = extractFn('findFirstContinuationToken') + '\n'
  + extractFn('findFirstSetVideoId') + '\n'
  + extractFn('extractItemsAndContinuation');
// eslint-disable-next-line no-eval
const evaluated = eval('(function(){ ' + harness
  + '\n return { extractItemsAndContinuation, findFirstSetVideoId }; })()');
const extractItemsAndContinuation = evaluated.extractItemsAndContinuation;
const findFirstSetVideoId = evaluated.findFirstSetVideoId;

console.log('\n[1] extraction from a VLWL-shaped response');
const ext = extractItemsAndContinuation(fixture);
const scoped = ext.items.filter((it) => it.source !== 'loose');
const loose = ext.items.filter((it) => it.source === 'loose');

eq('scoped rows = 4 (the Watch Later body)', scoped.length, 4);
// I-074: the recommendation shelf shares the response. Its video must be visible to
// the extractor as `loose` and dropped by the caller — not silently absent, because
// "absent" would also be the symptom of the extractor failing to walk the shelf.
eq('shelf video is seen but marked loose', loose.length, 1);
eq('shelf video is vREC', loose[0] && loose[0].videoId, 'vREC');
check('shelf video is not in the scoped rows', !scoped.some((r) => r.videoId === 'vREC'));

// I-072: setVideoId comes from the row, for both renderer shapes.
eq('playlistVideoRenderer setVideoId', scoped[0].setVideoId, 'setA');
eq('lockupViewModel setVideoId (from its edit menu)', scoped[1].setVideoId, 'setB');
eq('second entry of the same video keeps its own setVideoId', scoped[2].setVideoId, 'setC');
eq('row with no setVideoId yields empty string, not a neighbour\'s', scoped[3].setVideoId, '');

// I-073: two rows, same videoId, different setVideoId — never collapsed.
eq('duplicate videoId kept as two rows', scoped.filter((r) => r.videoId === 'vAAA').length, 2);
check('the two vAAA rows carry different setVideoIds',
  scoped[0].setVideoId !== scoped[2].setVideoId);

// I-075: pagination follows only the token co-located with the Watch Later rows.
eq('continuation token is the playlist body token', ext.continuation, 'WL_TOKEN');
check('continuation is marked scoped (safe to paginate)', ext.continuationScoped === true);
check('the shelf token was rejected, and the rejection is reported',
  ext.rejectedTokenCount >= 1, 'rejectedTokenCount=' + ext.rejectedTokenCount);

console.log('\n[2] setVideoId never leaks between sibling rows');
// findFirstSetVideoId is always called on ONE item node. Feeding it the row that has
// no setVideoId must return '' even though its siblings in the same response do.
const bodyContents = fixture.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer
  .content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0]
  .playlistVideoListRenderer.contents;
eq('row D alone -> no setVideoId', findFirstSetVideoId(bodyContents[3].playlistVideoRenderer), '');
eq('row B alone -> its own setVideoId', findFirstSetVideoId(bodyContents[1].lockupViewModel), 'setB');

console.log('\n[3] removal plan: three-valued watched lookup (I-076)');
const rows = Core.normalizeRows(scoped);
eq('normalizeRows keeps every scanned row', rows.length, 4);

const plan = Core.buildRemovalPlan(rows, { vAAA: true, vDDD: true });
eq('candidates', plan.counts.candidates, 2);
eq('both vAAA entries are candidates',
  plan.candidates.filter((c) => c.videoId === 'vAAA').length, 2);
eq('candidates are addressed by setVideoId',
  plan.candidates.map((c) => c.setVideoId).join(','), 'setA,setC');
// vBBB is absent from the map: unknown, not "unwatched".
eq('missing DB answer counts as indeterminate', plan.counts.indeterminate, 1);
eq('indeterminate row is vBBB', plan.skipped.indeterminate[0].videoId, 'vBBB');
// vDDD is watched but has no setVideoId — deleting it would require guessing.
eq('watched row with no setVideoId is skipped', plan.counts.noSetVideoId, 1);
eq('skipped-for-no-setVideoId row is vDDD', plan.skipped.noSetVideoId[0].videoId, 'vDDD');
eq('duplicate flag is surfaced', plan.counts.duplicateVideoId, 2);

const triState = Core.normalizeRows([
  { videoId: 'w1', setVideoId: 's1' },
  { videoId: 'w2', setVideoId: 's2' },
  { videoId: 'w3', setVideoId: 's3' },
]);
const triPlan = Core.buildRemovalPlan(triState, { w1: true, w2: false, w3: undefined });
eq('true -> candidate', triPlan.candidates.length, 1);
eq('true -> the right row', triPlan.candidates[0].videoId, 'w1');
eq('false -> kept as not watched', triPlan.counts.notWatched, 1);
eq('undefined -> kept as indeterminate', triPlan.counts.indeterminate, 1);
check('an undefined answer never becomes a candidate',
  !triPlan.candidates.some((c) => c.videoId === 'w3'));

// A DB that answers nothing at all must produce zero candidates, not "everything is
// unwatched" and not "everything is watched".
const blindPlan = Core.buildRemovalPlan(rows, {});
eq('empty lookup result -> no candidates', blindPlan.counts.candidates, 0);
eq('empty lookup result -> all indeterminate', blindPlan.counts.indeterminate, 4);

console.log('\n[4] re-identification refuses to guess (I-057 / I-081)');
eq('unique videoId re-identifies', Core.findUniqueRowByVideoId(rows, 'vBBB').status, 'unique');
eq('duplicated videoId is ambiguous', Core.findUniqueRowByVideoId(rows, 'vAAA').status, 'ambiguous');
check('ambiguous returns no row', Core.findUniqueRowByVideoId(rows, 'vAAA').row === null);
eq('already-removed videoId', Core.findUniqueRowByVideoId(rows, 'vZZZ').status, 'not-found');

console.log('\n[5] source pins (guards that cannot be expressed as pure calls)');
check('background.js loads watch_later_core.js',
  /importScripts\('watch_later_core\.js'\)/.test(src));
// The scan must not reuse the liked-sync habit of collapsing rows by videoId.
const scanStart = src.indexOf('async function scanWatchLater(');
const scanBody = scanStart === -1 ? '' : src.slice(scanStart, src.indexOf('\n// Streaming variant', scanStart));
check('scanWatchLater exists', scanStart !== -1);
check('scanWatchLater does not dedup rows by videoId',
  scanBody.length > 0 && !/seenFinal/.test(scanBody));
check('scanWatchLater pages with the Watch Later browse id',
  /browseId: Core\.WL_BROWSE_ID/.test(scanBody));
check('scanWatchLater aborts instead of guessing when the DB check fails',
  /db-check-failed/.test(scanBody));
check('scanWatchLater re-checks the pinned account before reporting',
  /sync-session-changed/.test(scanBody));
// Round B is read-only: no edit_playlist call may exist yet. Comment lines are
// stripped first — the guard is about executable code, and the scan's own comments
// necessarily talk about the deletion step it deliberately does not perform.
const codeOnly = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check('no playlist edit action is issued anywhere yet (Round B is read-only)',
  !/edit_playlist|ACTION_REMOVE_VIDEO/.test(codeOnly));
// The shared extractor now emits setVideoId; the liked path must strip it so a
// Watch-Later-only field never lands in the liked store.
check('liked sync strips setVideoId before persisting',
  /uniqueItems\.map\(\(\{ source, setVideoId, \.\.\.it \}/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
