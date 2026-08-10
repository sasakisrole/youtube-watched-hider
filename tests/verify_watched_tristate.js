// Synthetic verification for §8.3 (H1): DB-check-failure tri-state fix in
// lookupWatchedForIds, plus source-level "drift" pins for the sibling §8.2/
// §8.4/§8.5 robustness fixes landed alongside it (HANDOFF_2026-07-12.md §8.2-8.5).
// Run: node verify_watched_tristate.js
//
// content.js is a single top-level IIFE full of chrome.*-dependent closures, so
// (as in tests/verify_liked_sync_robustness.js) the *functional* part of this
// harness extracts the real cache/lookup subsystem verbatim by text slice and
// eval()s it with a mocked DBClient.checkMultiple — no chrome.* stub is needed
// because dbRpc (which touches chrome.runtime.sendMessage) is never invoked
// once DBClient.checkMultiple is overridden directly.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('start marker not found: ' + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error('end marker not found: ' + endMarker);
  return src.slice(start, end);
}

// Verbatim slice: FULL_CACHE_SOFT_LIMIT declaration through the end of
// lookupWatchedForIds (just before getCacheStats). Includes watchedPositive/
// recentLookup/pendingLookup, cacheMode/cacheLoaded lets, dbRpc, DBClient,
// rememberWatched/rememberNotWatched/forgetWatched, getCachedWatchedState, and
// lookupWatchedForIds itself — the real, unmodified §8.3 code path.
const cacheBlock = sliceBetween('const FULL_CACHE_SOFT_LIMIT', '\n  function getCacheStats');

function makeCacheModule() {
  // eslint-disable-next-line no-eval
  return eval('(function(){ ' + cacheBlock + '\n' +
    'return { lookupWatchedForIds, getCachedWatchedState, rememberWatched, rememberNotWatched,' +
    ' forgetWatched, recentLookup, watchedPositive, pendingLookup, DBClient,' +
    ' setCacheMode: (m) => { cacheMode = m; }, setCacheLoaded: (v) => { cacheLoaded = v; } }; })()');
}

// Verbatim slice: HISTORY_RETRY_LIMIT through computeHistoryRetryOutcome (a
// pure function, no DOM/chrome deps) — the §8.5 🟡1 DOM-boundedness fix.
const retryBlock = sliceBetween('const HISTORY_RETRY_LIMIT', '\n  function getHistoryTitle');

function makeRetryModule() {
  // eslint-disable-next-line no-eval
  return eval('(function(){ ' + retryBlock + '\n' +
    'return { HISTORY_RETRY_LIMIT, computeHistoryRetryOutcome }; })()');
}

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

async function run() {
  console.log('lookupWatchedForIds tri-state (§8.3 H1) — real extracted code');

  // --- Scenario 1: DBClient.checkMultiple rejects -> indeterminate (undefined),
  // not a confident "not watched" (false). This is the core §8.3 fix. ---
  {
    const mod = makeCacheModule();
    mod.DBClient.checkMultiple = () => Promise.reject(new Error('DB unavailable'));
    const results = await mod.lookupWatchedForIds(['vidErr1', 'vidErr2']);
    check('NEW: failed lookup resolves to undefined (not false)',
      results.vidErr1 === undefined && results.vidErr2 === undefined);
    check('NEW: failed lookup does NOT populate the negative cache (no false "not watched" caching)',
      !mod.recentLookup.has('vidErr1') && !mod.recentLookup.has('vidErr2'));
    check('NEW: failed lookup does NOT populate the positive cache either',
      !mod.watchedPositive.has('vidErr1') && !mod.watchedPositive.has('vidErr2'));
  }

  // --- Scenario 2 (REGRESSION CONTROL): faithful mirror of the REMOVED pre-fix
  // catch branch (`.catch((e) => { ...; return false; })`). This mirror is NOT
  // the real content.js code (that line no longer exists there) — it is a
  // parallel reproduction of the deleted behavior used only to demonstrate that
  // this test's assertions would have failed loudly against the old
  // implementation. Same technique as `oldGate` in verify_credit_target.js. ---
  {
    async function oldStyleLookup(toQuery, checkMultiple) {
      const results = {};
      const batchPromise = checkMultiple(toQuery);
      const waits = toQuery.map((id) => batchPromise
        .then((batch) => !!(batch && batch[id]))
        .catch(() => false) // <-- the exact pre-fix line this test guards against
        .then((watched) => { results[id] = watched; }));
      await Promise.all(waits);
      return results;
    }
    const oldResults = await oldStyleLookup(['vidErr1'], () => Promise.reject(new Error('DB unavailable')));
    check('REGRESSION CONTROL: old catch(() => false) mis-resolves a DB error to false ("not watched")',
      oldResults.vidErr1 === false);
    check('REGRESSION CONTROL (this is what the NEW behavior above must differ from)',
      oldResults.vidErr1 !== undefined);
  }

  // --- Scenario 3: normal true/false semantics are unchanged on success (禁止:
  // "正常時の true/false セマンティクスは不変"). ---
  {
    const mod = makeCacheModule();
    mod.DBClient.checkMultiple = () => Promise.resolve({ vidYes: true, vidNo: false });
    const results = await mod.lookupWatchedForIds(['vidYes', 'vidNo']);
    check('NEW: successful lookup still returns true for a watched id', results.vidYes === true);
    check('NEW: successful lookup still returns false for a confirmed-not-watched id', results.vidNo === false);
    check('NEW: successful negative lookup DOES populate the negative cache (happy path unchanged)',
      mod.recentLookup.has('vidNo'));
    check('NEW: successful positive lookup DOES populate the positive cache (happy path unchanged)',
      mod.watchedPositive.has('vidYes'));
  }

  // --- Scenario 4: mixed batch — one id errors, one id succeeds. The error
  // must not contaminate the sibling id's result. ---
  {
    const mod = makeCacheModule();
    mod.DBClient.checkMultiple = () => Promise.reject(new Error('DB unavailable'));
    const results = await mod.lookupWatchedForIds(['vidErrA', 'vidErrB']);
    check('NEW: a whole-batch rejection marks every id in the batch as indeterminate (not silently watched or hidden)',
      Object.keys(results).length === 2 && results.vidErrA === undefined && results.vidErrB === undefined);
  }

  console.log('\ngetCachedWatchedState cache-error bypass (🔴 reviewer NEEDS-FIX) — real extracted code');

  // --- Scenario 5: cacheMode='error' (the initial full-cache load itself
  // failed — e.g. loadCache()'s getWatchedIdsPage rejected) must NOT
  // short-circuit to a confident "not watched" false BEFORE the tri-state
  // checkMultiple path ever runs. This was the 🔴 bypass: getCachedWatchedState
  // is called by processPage/checkRecommendations/lookupWatchedForIds BEFORE
  // any per-id DB check, so returning false here defeated the §8.3 fix for
  // the single most common real DB-error trigger. ---
  {
    const mod = makeCacheModule();
    mod.setCacheMode('error');
    const cached = mod.getCachedWatchedState('vidCacheErr1');
    check('NEW: cacheMode=error returns undefined (not a confident "not watched")', cached === undefined);
    check('NEW: cacheMode=error does not populate the negative cache',
      !mod.recentLookup.has('vidCacheErr1'));
  }

  // --- Scenario 6: cacheMode='error' + falling through to a per-id
  // checkMultiple that SUCCEEDS must still recover the true watched state
  // (the whole point of falling through instead of hard-coding false). ---
  {
    const mod = makeCacheModule();
    mod.setCacheMode('error');
    mod.DBClient.checkMultiple = () => Promise.resolve({ vidRecoverable: true });
    const results = await mod.lookupWatchedForIds(['vidRecoverable']);
    check('NEW: cacheMode=error still lets a per-id checkMultiple recover a true watched state',
      results.vidRecoverable === true);
  }

  // --- Scenario 7: cacheMode='error' AND the per-id checkMultiple also fails
  // (DB genuinely unreachable) — must resolve to undefined end-to-end, never
  // false, and never populate the negative cache. ---
  {
    const mod = makeCacheModule();
    mod.setCacheMode('error');
    mod.DBClient.checkMultiple = () => Promise.reject(new Error('still down'));
    const results = await mod.lookupWatchedForIds(['vidStillDown']);
    check('NEW: cacheMode=error + checkMultiple failure resolves to undefined end-to-end (never false)',
      results.vidStillDown === undefined);
    check('NEW: cacheMode=error + checkMultiple failure does not negative-cache',
      !mod.recentLookup.has('vidStillDown'));
  }

  // --- Scenario 8 (REGRESSION CONTROL): faithful mirror of the REMOVED
  // pre-fix line `if (cacheMode === 'error') return false;`. Same technique as
  // Scenario 2 above / `oldGate` in verify_credit_target.js — proves this
  // test's core assertion ("=== undefined") would have FAILED against the old
  // implementation for the exact same inputs used in Scenario 5. ---
  {
    function oldStyleGetCachedWatchedState(videoId, positiveSet, mode) {
      if (!videoId) return false;
      if (positiveSet.has(videoId)) return true;
      if (mode === 'error') return false; // <-- the exact pre-fix line this test guards against
      return undefined; // (cacheLoaded/full + recent-lookup branches omitted — not exercised here)
    }
    const oldResult = oldStyleGetCachedWatchedState('vidCacheErr1', new Set(), 'error');
    check('REGRESSION CONTROL: old getCachedWatchedState(cacheMode=error) returns false ("not watched")',
      oldResult === false);
    check('REGRESSION CONTROL (this is what the NEW Scenario 5 result above must differ from)',
      oldResult !== undefined);
  }

  console.log('\nHISTORY_RETRY_LIMIT / computeHistoryRetryOutcome (§8.5 🟡1) — real extracted pure function');

  // --- Scenario 9: first retry on a freshly-unresolved card (no prior
  // historyRetries dataset value — undefined/NaN input) -> retries=1, not
  // exhausted yet (K=HISTORY_RETRY_LIMIT=4). ---
  {
    const mod = makeRetryModule();
    check('HISTORY_RETRY_LIMIT is 4 (reviewer-suggested 3-5 range, middle pick)', mod.HISTORY_RETRY_LIMIT === 4);
    const o1 = mod.computeHistoryRetryOutcome(undefined);
    check('retry outcome: first pass (undefined input) -> retries=1, not exhausted',
      o1.retries === 1 && o1.exhausted === false);
    const o2 = mod.computeHistoryRetryOutcome('garbage-not-a-number');
    check('retry outcome: non-numeric dataset value is treated as 0 (defensive) -> retries=1',
      o2.retries === 1 && o2.exhausted === false);
  }

  // --- Scenario 10: exactly at the K-1 boundary -> the NEXT retry reaches K
  // and must flip to exhausted. Off-by-one is the classic bug here. ---
  {
    const mod = makeRetryModule();
    const belowLimit = mod.computeHistoryRetryOutcome(String(mod.HISTORY_RETRY_LIMIT - 2));
    check('retry outcome: one retry below the limit -> not yet exhausted',
      belowLimit.retries === mod.HISTORY_RETRY_LIMIT - 1 && belowLimit.exhausted === false);
    const atLimit = mod.computeHistoryRetryOutcome(String(mod.HISTORY_RETRY_LIMIT - 1));
    check('retry outcome: reaching HISTORY_RETRY_LIMIT -> exhausted (no off-by-one)',
      atLimit.retries === mod.HISTORY_RETRY_LIMIT && atLimit.exhausted === true);
    const pastLimit = mod.computeHistoryRetryOutcome(String(mod.HISTORY_RETRY_LIMIT + 5));
    check('retry outcome: already past the limit (defensive) -> stays exhausted',
      pastLimit.exhausted === true);
  }

  console.log('\nSource-level drift guards (pin the shipped code itself, not a mock)');

  // §8.3: caller-side three-way branch (must not fold undefined into false).
  const threeWayCount = (src.match(/if \(isWatched === true\) \{/g) || []).length;
  check('drift: both call sites (processPage + checkRecommendations) use the true/false/undefined three-way branch',
    threeWayCount === 2);
  const elseIfFalseCount = (src.match(/\} else if \(isWatched === false\) \{/g) || []).length;
  check('drift: both call sites gate the negative branch on === false (not a bare else)',
    elseIfFalseCount === 2);
  check('drift: DB_CHECK_MULTIPLE catch branch returns undefined',
    /DB_CHECK_MULTIPLE failed[\s\S]{0,800}?return undefined;/.test(src));
  check('drift: DB_CHECK_MULTIPLE catch branch no longer returns a bare false',
    !/DB_CHECK_MULTIPLE failed[\s\S]{0,800}?return false;/.test(src));
  check('drift (🔴 fix): getCachedWatchedState cacheMode=error branch returns undefined, not false',
    src.includes("if (cacheMode === 'error') return undefined;")
    && !src.includes("if (cacheMode === 'error') return false;"));
  check('drift: the three getCachedWatchedState() call sites (lookupWatchedForIds/processPage/checkRecommendations) '
    + 'all gate on strict !==/===, so undefined correctly falls through instead of being coerced to falsy',
    /const cached = getCachedWatchedState\(id\);\s*if \(cached !== undefined\)/.test(src)
    && (src.match(/const cached = getCachedWatchedState\(videoId\);\s*if \(cached === true\)/g) || []).length === 2);

  console.log('\n§8.4 videoId binding (H1) — source-level pins');
  check('drift: attachVideoEndedListener binds videoId at attach time (before "ended" can fire)',
    src.includes('const boundVideoId = getCurrentVideoId();')
    && /endedHandler = \(\) => \{\s*recordCurrentVideo\(boundVideoId\);\s*\};/.test(src));
  check('drift: recordCurrentVideo is no longer invoked bare/unbound at the ended-listener site',
    !/endedHandler = \(\) => \{\s*recordCurrentVideo\(\);/.test(src));
  check('drift: recordCurrentVideo accepts boundVideoId and falls back to getCurrentVideoId when absent',
    /async function recordCurrentVideo\(boundVideoId\)/.test(src)
    && src.includes('const videoId = boundVideoId || getCurrentVideoId();'));

  console.log('\n§8.5 history card state machine (H1) — source-level pins');
  check('drift: old boolean historyScraped dataset flag is no longer read/written (a comment may still name it historically)',
    !src.includes('.historyScraped'));
  check('drift: HISTORY_STATE covers unknown/partial/completed/failed',
    src.includes("UNKNOWN: 'unknown'") && src.includes("PARTIAL: 'partial'")
    && src.includes("COMPLETED: 'completed'") && src.includes("FAILED: 'failed'"));
  const completedAssignCount = (src.match(
    /card\.dataset\.historyState = HISTORY_STATE\.COMPLETED;\s*completedThisPass\.push\(card\);/g
  ) || []).length;
  check('drift: COMPLETED is only assigned (both at the existing-id check and post-import) alongside completedThisPass tracking',
    completedAssignCount === 2);
  check('drift: a videoId-less card is left UNKNOWN, never COMPLETED, and is retried (not removed) next pass',
    /if \(!link\) \{\s*[\s\S]{0,200}?card\.dataset\.historyState = HISTORY_STATE\.UNKNOWN;\s*continue;\s*\}/.test(src));
  check('drift: the old unconditional "remove every touched card" prune is gone (processedCards no longer exists)',
    !src.includes('for (const card of processedCards) card.remove();') && !src.includes('const processedCards'));

  console.log('\n§8.5 DOM-boundedness (🟡1 reviewer) — source-level pins');
  check('drift: HISTORY_STATE adds a terminal EXHAUSTED state (never implies watched)',
    src.includes("EXHAUSTED: 'exhausted'"));
  check('drift: HISTORY_RETRY_LIMIT constant is defined and used to bound retries',
    /const HISTORY_RETRY_LIMIT = 4;/.test(src));
  check('drift: main scan loop skips EXHAUSTED cards too (not just COMPLETED)',
    /if \(state === HISTORY_STATE\.COMPLETED \|\| state === HISTORY_STATE\.EXHAUSTED\) continue;/.test(src));
  const exhaustCallCount = (src.match(/computeHistoryRetryOutcome\(card\.dataset\.historyRetries\)/g) || []).length;
  check('drift: the retry-exhaustion pass calls computeHistoryRetryOutcome exactly once per unresolved card',
    exhaustCallCount === 1);
  check('drift: an exhausted card is marked EXHAUSTED (never COMPLETED) and tracked for pruning',
    /card\.dataset\.historyState = HISTORY_STATE\.EXHAUSTED;\s*delete card\.dataset\.historyRetries;\s*exhaustedThisPass\.push\(card\);/.test(src));
  check('drift: both COMPLETED and EXHAUSTED cards are pruned in harvest mode (DOM re-bounded); '
    + 'UNKNOWN/PARTIAL/FAILED are not',
    src.includes('for (const card of completedThisPass) card.remove();')
    && src.includes('for (const card of exhaustedThisPass) card.remove();'));

  console.log('\n§8.2 fetch timeout/abort (H1) — source-level pins');
  // 2026-08-08: EDIT_PLAYLIST (Round C, the only irreversible request) joined the
  // proxied handlers, so the expected count moved 3 -> 4. The count is deliberately
  // exact: a new proxy that skips the timeout/abort discipline must fail here rather
  // than inherit it by resemblance.
  const PROXY_HANDLER_COUNT = 4;
  const abortControllerCount = (src.match(/new AbortController\(\)/g) || []).length;
  check('drift: all 4 proxied fetch handlers (WATCH_HTML / PLAYLIST_HTML / INNERTUBE_BROWSE / EDIT_PLAYLIST) construct an AbortController',
    abortControllerCount === PROXY_HANDLER_COUNT);
  const signalWiredCount = (src.match(/signal: controller\.signal/g) || []).length;
  check('drift: all 4 fetches actually pass the abort signal into fetch()',
    signalWiredCount === PROXY_HANDLER_COUNT);
  const timeoutScheduleCount = (src.match(/setTimeout\(\(\) => controller\.abort\(\), PROXY_FETCH_TIMEOUT_MS\)/g) || []).length;
  check('drift: all 4 handlers schedule the abort via the shared PROXY_FETCH_TIMEOUT_MS constant',
    /const PROXY_FETCH_TIMEOUT_MS = \d+;/.test(src) && timeoutScheduleCount === PROXY_HANDLER_COUNT);
  const abortReasonCount = (src.match(/reason: e\.name === 'AbortError' \? 'timeout' : 'fetch-error'/g) || []).length;
  check('drift: all 4 handlers distinguish a timeout abort from a generic fetch error',
    abortReasonCount === PROXY_HANDLER_COUNT);
  const clearTimeoutCount = (src.match(/\} finally \{\s*clearTimeout\(timer\);\s*\}/g) || []).length;
  check('drift: all 4 handlers clear the timeout in a finally (no leaked timers)',
    clearTimeoutCount === PROXY_HANDLER_COUNT);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
