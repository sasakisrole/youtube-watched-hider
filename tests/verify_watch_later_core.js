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

console.log('\n[5] Round C: the removal request and its confirmation handshake');
// The payload below is pinned to a real capture (2026-08-08). `params` in particular
// was absent from the design assumption; if these literals drift from what YouTube
// accepts, the delete silently no-ops rather than failing loudly.
const removeBody = Core.buildRemoveOneBody({ client: { clientName: 'WEB' } }, 'SET1');
eq('body targets Watch Later', removeBody.playlistId, 'WL');
eq('body carries the observed params literal', removeBody.params, 'CAFAAQ%3D%3D');
eq('body carries exactly one action', removeBody.actions.length, 1);
eq('the action is a removal', removeBody.actions[0].action, 'ACTION_REMOVE_VIDEO');
eq('the action names the row, not the video', removeBody.actions[0].setVideoId, 'SET1');
check('params is stored already percent-encoded (must not be re-encoded)',
  /%3D%3D$/.test(Core.EDIT_PLAYLIST_PARAMS));
let threw = false;
try { Core.buildRemoveOneBody({}, ''); } catch (_e) { threw = true; }
check('refuses to build a body without a setVideoId', threw);

// Success must be stated, never inferred. Everything that is not an explicit
// STATUS_SUCCEEDED reads as "we do not know that it happened".
check('STATUS_SUCCEEDED is success', Core.isEditPlaylistSuccess({ status: 'STATUS_SUCCEEDED' }));
check('a 200 with no status is not success', !Core.isEditPlaylistSuccess({}));
check('an unknown status is not success', !Core.isEditPlaylistSuccess({ status: 'STATUS_FAILED' }));
check('null is not success', !Core.isEditPlaylistSuccess(null));

const T0 = 1000000;
const scanOk = {
  syncSessionId: 'sess-1',
  scannedAt: T0,
  candidates: [
    { videoId: 'vAAA', setVideoId: 'SET1', title: 'first' },
    { videoId: 'vBBB', setVideoId: 'SET2', title: 'second' },
  ],
};
const confirm1 = { syncSessionId: 'sess-1', videoId: 'vAAA' };
eq('confirmed first candidate is accepted',
  Core.selectConfirmedCandidate(scanOk, confirm1, T0).status, 'ok');
eq('accepted row is the one that was confirmed',
  Core.selectConfirmedCandidate(scanOk, confirm1, T0).row.setVideoId, 'SET1');
// The UI only ever confirms the head of the list; naming any other row means the
// list moved under the user, so nothing is deleted.
eq('a non-head candidate cannot be targeted',
  Core.selectConfirmedCandidate(scanOk, { syncSessionId: 'sess-1', videoId: 'vBBB' }, T0).status,
  'confirmation-mismatch');
eq('an unconfirmed request is refused',
  Core.selectConfirmedCandidate(scanOk, { syncSessionId: 'sess-1' }, T0).status,
  'confirmation-mismatch');
eq('no scan at all', Core.selectConfirmedCandidate(null, confirm1, T0).status, 'no-scan');
eq('a scan with no candidates',
  Core.selectConfirmedCandidate({ ...scanOk, candidates: [] }, confirm1, T0).status, 'no-scan');
// setVideoId goes stale when the list changes elsewhere, so age is a hard gate.
eq('a scan past the age limit is refused',
  Core.selectConfirmedCandidate(scanOk, confirm1, T0 + Core.SCAN_MAX_AGE_MS + 1).status,
  'scan-expired');
eq('a scan exactly at the age limit still works',
  Core.selectConfirmedCandidate(scanOk, confirm1, T0 + Core.SCAN_MAX_AGE_MS).status, 'ok');
eq('a confirmation from a different scan is refused',
  Core.selectConfirmedCandidate(scanOk, { syncSessionId: 'other', videoId: 'vAAA' }, T0).status,
  'stale-scan');
eq('a confirmation with no scan id is refused',
  Core.selectConfirmedCandidate(scanOk, { videoId: 'vAAA' }, T0).status, 'stale-scan');
eq('a candidate with no setVideoId is refused',
  Core.selectConfirmedCandidate(
    { ...scanOk, candidates: [{ videoId: 'vAAA', setVideoId: '' }] }, confirm1, T0).status,
  'no-set-video-id');

console.log('\n[6] source pins (guards that cannot be expressed as pure calls)');
const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
check('background.js loads watch_later_core.js',
  /importScripts\('watch_later_core\.js'\)/.test(src));
// The scan must not reuse the liked-sync habit of collapsing rows by videoId.
const scanStart = src.indexOf('async function scanWatchLater(');
// Slice to the removal function, not to the streaming section: the delete lives
// between them, and folding it into `scanBody` would make the read-only pin below
// assert nothing.
const scanEnd = src.indexOf('\n// Round C: remove exactly ONE row', scanStart);
const scanBody = scanStart === -1 || scanEnd === -1 ? '' : src.slice(scanStart, scanEnd);
check('scanWatchLater exists', scanStart !== -1);
check('scanWatchLater is followed by the Round C section', scanEnd !== -1);
check('scanWatchLater does not dedup rows by videoId',
  scanBody.length > 0 && !/seenFinal/.test(scanBody));
check('scanWatchLater pages with the Watch Later browse id',
  /browseId: Core\.WL_BROWSE_ID/.test(scanBody));
check('scanWatchLater aborts instead of guessing when the DB check fails',
  /db-check-failed/.test(scanBody));
check('scanWatchLater re-checks the pinned account before reporting',
  /sync-session-changed/.test(scanBody));
// The scan itself stays read-only even now that a delete exists in the same file.
check('scanWatchLater issues no playlist edit',
  scanBody.length > 0 && !/EDIT_PLAYLIST|buildRemoveOneBody/.test(scanBody));

// Comment lines are stripped first — these guards are about executable code, and
// the surrounding comments necessarily name the very things being restricted.
const codeOnly = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const contentCodeOnly = contentSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
// The irreversible endpoint exists in exactly one place, with a fixed path.
check('content.js owns the edit_playlist endpoint, hardcoded',
  /youtubei\/v1\/browse\/edit_playlist\?prettyPrint=false/.test(contentCodeOnly));
check('background.js never builds the edit_playlist URL itself',
  !/edit_playlist\?/.test(codeOnly));
check('background.js never hardcodes the removal action (it goes through core)',
  !/ACTION_REMOVE_VIDEO/.test(codeOnly));
// The proxy re-validates the body, so a caller bug cannot widen it into a batch
// delete, a different playlist, or a different action.
check('the proxy refuses anything but one removal from WL',
  /refused-unexpected-edit/.test(contentCodeOnly)
  && /body\.playlistId !== 'WL'/.test(contentCodeOnly)
  && /actions\.length !== 1/.test(contentCodeOnly));

const removeStart = src.indexOf('async function removeOneWatchLaterRow(');
const removeBodySrc = removeStart === -1 ? '' : src.slice(removeStart, src.indexOf('\n// Streaming variant', removeStart));
check('removeOneWatchLaterRow exists', removeStart !== -1);
check('it only ever deletes a confirmed candidate',
  /Core\.selectConfirmedCandidate\(/.test(removeBodySrc));
check('it re-pins the account before deleting',
  /sync-session-changed/.test(removeBodySrc));
check('it treats an unconfirmed response as failure',
  /Core\.isEditPlaylistSuccess\(/.test(removeBodySrc) && /edit-not-confirmed/.test(removeBodySrc));
// After one delete the remaining setVideoIds may have been reassigned, so the scan
// must be dropped — this is what keeps Round C to exactly one row per scan.
check('it discards the scan after a successful delete',
  /lastWatchLaterScan = null;/.test(removeBodySrc));

// The shared extractor now emits setVideoId; the liked path must strip it so a
// Watch-Later-only field never lands in the liked store.
check('liked sync strips setVideoId before persisting',
  /uniqueItems\.map\(\(\{ source, setVideoId, \.\.\.it \}/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
