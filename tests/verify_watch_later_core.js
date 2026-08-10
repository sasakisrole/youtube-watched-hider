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

console.log('\n[6] Round D pre-work: measuring whether an edit reassigns setVideoId');
const beforeRows = Core.normalizeRows([
  { videoId: 'v1', setVideoId: 'S1' },
  { videoId: 'v2', setVideoId: 'S2' },
  { videoId: 'v3', setVideoId: 'S3' },
]);
const sameRows = Core.normalizeRows([
  { videoId: 'v1', setVideoId: 'S1' },
  { videoId: 'v3', setVideoId: 'S3' },
]);
// v2 was deleted; v1/v3 kept their ids -> "an edit does not reassign".
eq('unchanged ids are counted as compared', Core.compareSetVideoIds(beforeRows, sameRows).compared, 2);
eq('unchanged ids report no drift', Core.compareSetVideoIds(beforeRows, sameRows).changed, 0);
const movedRows = Core.normalizeRows([
  { videoId: 'v1', setVideoId: 'S1' },
  { videoId: 'v3', setVideoId: 'S9' },
]);
eq('a reassigned id is detected', Core.compareSetVideoIds(beforeRows, movedRows).changed, 1);
// Rows that vanished, and rows that are new, carry no information about drift.
eq('a removed row is not compared', Core.compareSetVideoIds(beforeRows, sameRows).compared, 2);
const withNew = Core.normalizeRows([
  { videoId: 'v1', setVideoId: 'S1' },
  { videoId: 'v9', setVideoId: 'S9' },
]);
eq('a newly added row is not compared', Core.compareSetVideoIds(beforeRows, withNew).compared, 1);
// A video present twice has two rows and no way to say which one "kept" its id.
const dupBefore = Core.normalizeRows([
  { videoId: 'v1', setVideoId: 'S1' },
  { videoId: 'v1', setVideoId: 'S2' },
  { videoId: 'v2', setVideoId: 'S3' },
]);
const dupAfter = Core.normalizeRows([
  { videoId: 'v1', setVideoId: 'S1' },
  { videoId: 'v1', setVideoId: 'S2' },
  { videoId: 'v2', setVideoId: 'S3' },
]);
eq('a duplicated video is excluded from the comparison',
  Core.compareSetVideoIds(dupBefore, dupAfter).compared, 1);
// A row with no setVideoId has nothing to compare.
eq('a row with no setVideoId is excluded',
  Core.compareSetVideoIds(
    Core.normalizeRows([{ videoId: 'v1', setVideoId: '' }, { videoId: 'v2', setVideoId: 'S2' }]),
    Core.normalizeRows([{ videoId: 'v1', setVideoId: 'S1' }, { videoId: 'v2', setVideoId: 'S2' }])
  ).compared, 1);
eq('empty input compares nothing', Core.compareSetVideoIds([], beforeRows).compared, 0);

// Batch targeting: the approved list is the user's confirmation and is never widened.
const batchCandidates = Core.normalizeRows([
  { videoId: 'b1', setVideoId: 'T1' },
  { videoId: 'b2', setVideoId: 'T2' },
  { videoId: 'b3', setVideoId: 'T3' },
]);
eq('only approved videos are targeted',
  Core.selectBatchTargets(batchCandidates, ['b1', 'b3'], []).targets.length, 2);
eq('targets keep the scan order',
  Core.selectBatchTargets(batchCandidates, ['b1', 'b3'], []).targets[0].videoId, 'b1');
// A video that became watched mid-batch was never shown to the user.
eq('a candidate the user never approved is not targeted',
  Core.selectBatchTargets(batchCandidates, ['b1'], []).targets.some((t) => t.videoId === 'b2'), false);
eq('an already-removed video is not targeted twice',
  Core.selectBatchTargets(batchCandidates, ['b1', 'b2'], ['b1']).targets.length, 1);
// "This video" does not say which of its two entries the user meant.
const dupCandidates = Core.normalizeRows([
  { videoId: 'd1', setVideoId: 'T1' },
  { videoId: 'd1', setVideoId: 'T2' },
  { videoId: 'd2', setVideoId: 'T3' },
]);
eq('a duplicated video is never batch-deleted',
  Core.selectBatchTargets(dupCandidates, ['d1', 'd2'], []).targets.length, 1);
eq('the duplicated rows are reported as skipped',
  Core.selectBatchTargets(dupCandidates, ['d1', 'd2'], []).skipped.ambiguous.length, 2);
eq('a row with no setVideoId is skipped',
  Core.selectBatchTargets(
    Core.normalizeRows([{ videoId: 'e1', setVideoId: '' }]), ['e1'], []).skipped.noSetVideoId.length, 1);

check('a batch stops when ids were reassigned', Core.batchShouldStop({ compared: 10, changed: 1 }));
check('a batch continues when nothing drifted', !Core.batchShouldStop({ compared: 10, changed: 0 }));
// Nothing compared is "no evidence", not "evidence of stability".
check('a drift report with nothing compared does not stop the batch',
  !Core.batchShouldStop({ compared: 0, changed: 0 }));
check('a missing drift report does not stop the batch', !Core.batchShouldStop(null));

console.log('\n[7] source pins (guards that cannot be expressed as pure calls)');
const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
check('background.js loads watch_later_core.js',
  /importScripts\('watch_later_core\.js'\)/.test(src));
// The scan must not reuse the liked-sync habit of collapsing rows by videoId.
const scanStart = src.indexOf('async function scanWatchLater(');
// Slice to the deletion section, not to the streaming section: the deletes live
// between them, and folding them into `scanBody` would make the read-only pin below
// assert nothing.
const DELETE_SECTION = '\n// ---- Watch Later deletion (Round C / D) ----';
const scanEnd = src.indexOf(DELETE_SECTION, scanStart);
const scanBody = scanStart === -1 || scanEnd === -1 ? '' : src.slice(scanStart, scanEnd);
check('scanWatchLater exists', scanStart !== -1);
check('scanWatchLater is followed by the deletion section', scanEnd !== -1);
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

// The single irreversible request is shared, so its guards are pinned once.
const sendStart = src.indexOf('async function sendWatchLaterRemoval(');
const sendBodySrc = sendStart === -1 ? '' : src.slice(sendStart, src.indexOf('\n// Round C:', sendStart));
check('sendWatchLaterRemoval exists', sendStart !== -1);
check('it re-pins the account before deleting', /sync-session-changed/.test(sendBodySrc));
check('it treats an unconfirmed response as failure',
  /Core\.isEditPlaylistSuccess\(/.test(sendBodySrc) && /edit-not-confirmed/.test(sendBodySrc));
check('every delete in the file goes through that one helper',
  (codeOnly.match(/FETCH_INNERTUBE_EDIT_PLAYLIST/g) || []).length === 1);

const removeStart = src.indexOf('async function removeOneWatchLaterRow(');
const removeBodySrc = removeStart === -1 ? '' : src.slice(removeStart, src.indexOf('\n// Round D:', removeStart));
check('removeOneWatchLaterRow exists', removeStart !== -1);
check('it only ever deletes a confirmed candidate',
  /Core\.selectConfirmedCandidate\(/.test(removeBodySrc));
// After one delete the remaining setVideoIds may have been reassigned, so the scan
// must be dropped — this is what keeps Round C to exactly one row per scan.
check('it discards the scan after a successful delete',
  /lastWatchLaterScan = null;/.test(removeBodySrc));
// ...but NOT the fingerprint: it is the only thing that survives to tell the next
// scan whether this delete reassigned anybody else's setVideoId.
check('it keeps the fingerprint so the next scan can measure drift',
  !/lastWatchLaterFingerprint = null;/.test(removeBodySrc));
check('the scan compares drift before overwriting the fingerprint',
  /Core\.compareSetVideoIds\(prevFingerprint, rows\)[\s\S]{0,200}?writeWatchLaterFingerprint\(rows\.map\(/.test(scanBody));
// The measurement spans two scans with a delete between them, so it must survive an
// MV3 service worker eviction — and it must not be written to disk.
check('the fingerprint is mirrored into storage.session, not storage.local',
  /chrome\.storage\.session\.set\(\{ \[WL_FINGERPRINT_KEY\]/.test(src)
  && !/storage\.local[\s\S]{0,80}WL_FINGERPRINT_KEY/.test(src));

const batchStart = src.indexOf('async function runWatchLaterBatch(');
const batchBodySrc = batchStart === -1 ? '' : src.slice(batchStart, src.indexOf('\n// A batch can run', batchStart));
check('runWatchLaterBatch exists', batchStart !== -1);
// The approved list is the user's confirmation. Re-scans inside a batch refresh
// setVideoIds; they must never widen what may be deleted.
check('the batch only targets rows the user approved',
  /Core\.selectBatchTargets\(scan\.candidates, approved, removedIds\)/.test(batchBodySrc));
// Every row is re-gated, so a long run cannot drift past the scan age limit.
check('the batch re-runs the single-row gate for every row',
  /Core\.selectConfirmedCandidate\(/.test(batchBodySrc));
check('the batch stops on the first failed delete',
  /if \(!sent\.ok\) \{ stopped = sent\.reason; break; \}/.test(batchBodySrc));
// The measured premise (our deletes do not reassign ids) is re-checked at every
// chunk boundary rather than assumed to hold for the whole run.
check('the batch re-scans every chunk and stops if ids were reassigned',
  /sinceRescan >= Core\.BATCH_CHUNK/.test(batchBodySrc)
  && /Core\.batchShouldStop\(rescan\.drift\)/.test(batchBodySrc));
check('the batch always ends on a fresh scan',
  /const finalScan = await scanWatchLater\(\{\}\);/.test(batchBodySrc));

// The page and the worker talk over a Port, and nothing in either file fails on its
// own if the two halves disagree: connecting without sending START leaves the UI
// saying "削除中…" forever while the worker waits. That happened (2026-08-08), so the
// contract is pinned here rather than left to whoever reads both files.
const historySrc = fs.readFileSync(path.join(__dirname, '..', 'history.js'), 'utf8');
const portName = (src.match(/port\.name !== '([a-z-]*batch[a-z-]*)'/) || [])[1];
check('background listens on a watch-later batch port', !!portName);
check('history.js connects to that exact port name',
  !!portName && new RegExp(`chrome\\.runtime\\.connect\\(\\{ name: '${portName}' \\}\\)`).test(historySrc));
// Scoped to the batch's own connect..next-connect region. Three other features in
// this file also post `type: 'START'`, so an unscoped search passes even when the
// batch sends nothing at all — which is exactly how the 2026-08-08 bug slipped past.
const batchUiStart = historySrc.indexOf("chrome.runtime.connect({ name: 'watch-later-batch' })");
const nextConnect = historySrc.indexOf('chrome.runtime.connect(', batchUiStart + 1);
const batchUiSrc = batchUiStart === -1
  ? ''
  : historySrc.slice(batchUiStart, nextConnect === -1 ? undefined : nextConnect);
check('the batch UI region was found', batchUiStart !== -1);
check('history.js sends START on the port it just opened (connecting alone does nothing)',
  /port\.postMessage\(\{\s*type: 'START'/.test(batchUiSrc));
// The worker reads these three off the START message; a rename on either side would
// silently delete nothing (missing videoIds) or everything (missing limit).
check('START carries the fields the worker reads',
  /type: 'START',[\s\S]{0,200}?syncSessionId:[\s\S]{0,200}?videoIds:[\s\S]{0,200}?limit,/.test(batchUiSrc));
check('the worker reads exactly those fields',
  /runWatchLaterBatch\(\{ syncSessionId, videoIds, limit \}/.test(src));
// A stuck "削除中…" must not be permanent even if the worker never answers.
check('the page gives up if the worker never answers',
  /setTimeout\(\(\) => \{[\s\S]{0,200}?finish\(/.test(historySrc));

// The shared extractor now emits setVideoId; the liked path must strip it so a
// Watch-Later-only field never lands in the liked store.
check('liked sync strips setVideoId before persisting',
  /uniqueItems\.map\(\(\{ source, setVideoId, \.\.\.it \}/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
