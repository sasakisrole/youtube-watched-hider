// watch_later_core.js — pure logic for the Watch Later (WL) bulk cleanup feature.
//
// Round A (scan-only). NOTHING here touches chrome.*, the network or IndexedDB, so
// every rule below is testable from node (tests/verify_watch_later_core.js).
// background.js owns the I/O (Innertube paging, account pinning, DB lookup) and
// calls into this module for every decision that can silently delete the wrong row.
//
// Why a separate file instead of more code in content.js/background.js: deletion from
// Watch Later is irreversible, so the "which rows may be removed" rules must be
// readable and directly testable rather than buried in a fetch loop.
(function (root) {
  'use strict';

  // YouTube uses two different identifiers for the same list:
  //   'WL'   — playlistId, used in edit_playlist actions (Round C).
  //   'VLWL' — browseId, used to page the list through youtubei/v1/browse.
  const WL_PLAYLIST_ID = 'WL';
  const WL_BROWSE_ID = 'VLWL';

  // A WL row is identified for deletion by `setVideoId`, NOT by `videoId`:
  // `setVideoId` is the id of THIS entry in THIS playlist, so the same video added
  // twice yields two rows with two different setVideoIds. Collapsing them by videoId
  // would delete one entry and silently report both as done.
  function normalizeRows(items) {
    const rows = [];
    for (const it of items || []) {
      const videoId = (it && it.videoId) || '';
      if (!videoId) continue;
      rows.push({
        videoId,
        setVideoId: (it && it.setVideoId) || '',
        title: (it && it.title) || '',
        channel: (it && it.channel) || '',
        playlistIndex: (it && it.playlistIndex) || rows.length + 1,
        rowIndex: rows.length,
      });
    }
    return rows;
  }

  // Count how many rows carry each videoId. Used both to flag duplicates and to
  // decide (later, on retry) whether a stale setVideoId can be re-identified at all.
  function countByVideoId(rows) {
    const counts = new Map();
    for (const r of rows || []) counts.set(r.videoId, (counts.get(r.videoId) || 0) + 1);
    return counts;
  }

  // Build the removal plan from scanned rows + the watched lookup result.
  //
  // `watchedMap` is the three-valued DB answer keyed by videoId:
  //   true      -> watched          => candidate
  //   false     -> not watched      => keep
  //   undefined -> could not decide => keep (a DB error must never read as "unwatched";
  //                                   see HANDOFF_2026-07-12.md §8.3 tri-state fix)
  // A key that is absent from the map is treated exactly like `undefined`.
  //
  // Rows without a setVideoId are kept too: without it there is no way to name the
  // row in an edit_playlist action, and guessing by videoId is what this module exists
  // to prevent.
  function buildRemovalPlan(rows, watchedMap) {
    const map = watchedMap || {};
    const counts = countByVideoId(rows);
    const candidates = [];
    const skipped = { notWatched: [], indeterminate: [], noSetVideoId: [] };

    for (const r of rows || []) {
      const state = Object.prototype.hasOwnProperty.call(map, r.videoId) ? map[r.videoId] : undefined;
      if (state === undefined) { skipped.indeterminate.push(r); continue; }
      if (state !== true) { skipped.notWatched.push(r); continue; }
      if (!r.setVideoId) { skipped.noSetVideoId.push(r); continue; }
      // Duplicates stay deletable: each row has its own setVideoId, so removing both
      // entries of a twice-added video is unambiguous. The flag only tells the retry
      // path (Round D) that this row cannot be re-found by videoId alone.
      candidates.push({ ...r, duplicateVideoId: (counts.get(r.videoId) || 0) > 1 });
    }

    return {
      candidates,
      skipped,
      counts: {
        total: (rows || []).length,
        candidates: candidates.length,
        notWatched: skipped.notWatched.length,
        indeterminate: skipped.indeterminate.length,
        noSetVideoId: skipped.noSetVideoId.length,
        duplicateVideoId: candidates.filter((c) => c.duplicateVideoId).length,
      },
    };
  }

  // Re-identify a row after its setVideoId went stale (YouTube reassigns them when the
  // list is edited elsewhere). Returns the row ONLY when exactly one row carries that
  // videoId; 0 matches means the entry is already gone, 2+ means we cannot tell which
  // entry the user meant — both are reported to the caller instead of being guessed.
  function findUniqueRowByVideoId(rows, videoId) {
    if (!videoId) return { status: 'not-found', row: null, matches: 0 };
    const matches = (rows || []).filter((r) => r.videoId === videoId);
    if (matches.length === 0) return { status: 'not-found', row: null, matches: 0 };
    if (matches.length > 1) return { status: 'ambiguous', row: null, matches: matches.length };
    return { status: 'unique', row: matches[0], matches: 1 };
  }

  // ---- Round C: removing exactly one row -------------------------------------
  //
  // Shape observed on the real request (2026-08-08, DevTools capture):
  //   POST /youtubei/v1/browse/edit_playlist?prettyPrint=false
  //   { context, playlistId: 'WL', params: 'CAFAAQ%3D%3D',
  //     actions: [{ setVideoId, action: 'ACTION_REMOVE_VIDEO' }] }
  //   -> { status: 'STATUS_SUCCEEDED', ... }
  //
  // `params` was NOT in the design assumption and would have been missing had the
  // payload been guessed. YouTube sends it percent-encoded inside the JSON body, so
  // the literal is stored already-encoded: do not decode or re-encode it.
  const EDIT_PLAYLIST_PARAMS = 'CAFAAQ%3D%3D';
  const REMOVE_ACTION = 'ACTION_REMOVE_VIDEO';
  const EDIT_PLAYLIST_STATUS_OK = 'STATUS_SUCCEEDED';

  // A scan older than this is refused: YouTube reassigns setVideoId when the list
  // changes, so an old id may now name a different row.
  const SCAN_MAX_AGE_MS = 10 * 60 * 1000;

  function buildRemoveOneBody(context, setVideoId) {
    if (!setVideoId) throw new Error('setVideoId is required');
    return {
      context: context || {},
      playlistId: WL_PLAYLIST_ID,
      params: EDIT_PLAYLIST_PARAMS,
      actions: [{ setVideoId, action: REMOVE_ACTION }],
    };
  }

  // Strict on purpose. A 200 with no status, an unknown status, or a shape we have
  // not seen must read as "the delete did not happen". Claiming a delete that did
  // not occur is the worse error: the user can re-scan and see a failure that was
  // actually a success, but cannot recover a row we wrongly reported as gone.
  function isEditPlaylistSuccess(data) {
    return !!data && data.status === EDIT_PLAYLIST_STATUS_OK;
  }

  // The UI shows the user ONE video by name and asks them to confirm it. This gate
  // re-checks, inside the worker, that the row still first in the candidate list is
  // the same video the user approved — the worker never accepts a setVideoId from
  // the page, and never falls back to "some other candidate" if the list moved.
  function selectConfirmedCandidate(scan, expected, now) {
    const exp = expected || {};
    if (!scan || !Array.isArray(scan.candidates) || !scan.candidates.length) {
      return { status: 'no-scan', row: null };
    }
    const age = now - scan.scannedAt;
    if (typeof scan.scannedAt !== 'number' || !(age >= 0) || age > SCAN_MAX_AGE_MS) {
      return { status: 'scan-expired', row: null };
    }
    if (!exp.syncSessionId || exp.syncSessionId !== scan.syncSessionId) {
      return { status: 'stale-scan', row: null };
    }
    const row = scan.candidates[0];
    if (!row || !row.setVideoId) return { status: 'no-set-video-id', row: null };
    if (!exp.videoId || exp.videoId !== row.videoId) {
      return { status: 'confirmation-mismatch', row: null };
    }
    return { status: 'ok', row };
  }

  // ---- Round D pre-work: does an edit reassign the other rows' setVideoId? ----
  //
  // The handoff asserts that YouTube reassigns setVideoId whenever the list is edited
  // (I-057 / I-081), and Round C is built defensively around that: one delete discards
  // the whole scan. But the claim was inherited, never measured — and it decides the
  // shape of a bulk delete. If the ids survive an edit, one scan can drive many
  // deletions; if they do not, every deletion needs a fresh scan of the whole list.
  //
  // This is measurement only: nothing acts on the result yet.
  //
  // Only videoIds appearing exactly once in BOTH scans are compared. For a video added
  // twice there is no way to say which of its two rows "kept" its id, so counting it
  // either way would invent a result.
  function compareSetVideoIds(before, after) {
    const uniqueMap = (rows) => {
      const counts = countByVideoId(rows);
      const m = new Map();
      for (const r of rows || []) {
        if (r && r.setVideoId && (counts.get(r.videoId) || 0) === 1) m.set(r.videoId, r.setVideoId);
      }
      return m;
    };
    const a = uniqueMap(before);
    const b = uniqueMap(after);
    let compared = 0;
    let changed = 0;
    for (const [videoId, setVideoId] of a) {
      if (!b.has(videoId)) continue;
      compared += 1;
      if (b.get(videoId) !== setVideoId) changed += 1;
    }
    return { compared, changed };
  }

  const api = {
    WL_PLAYLIST_ID,
    WL_BROWSE_ID,
    EDIT_PLAYLIST_PARAMS,
    REMOVE_ACTION,
    SCAN_MAX_AGE_MS,
    normalizeRows,
    countByVideoId,
    buildRemovalPlan,
    findUniqueRowByVideoId,
    buildRemoveOneBody,
    isEditPlaylistSuccess,
    selectConfirmedCandidate,
    compareSetVideoIds,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WatchLaterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : null);
