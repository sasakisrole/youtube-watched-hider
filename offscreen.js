// Offscreen document DB owner for YouTube Watched Hider.
// Keeps IndexedDB on the extension origin instead of youtube.com.

const exportBlobUrls = new Map();

function createRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'export-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function createExportBlobUrl(envelope) {
  if (!envelope || envelope.schemaVersion !== 2 || !Array.isArray(envelope.watchedVideos)) {
    throw new Error('Invalid export envelope');
  }
  const requestId = createRequestId();
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);
  exportBlobUrls.set(requestId, blobUrl);
  return {
    requestId,
    blobUrl,
    counts: envelope.counts || { watchedVideos: envelope.watchedVideos.length, likedVideos: 0 },
    // u1ps (Codex B1 VERIFY blocker 1): report meta presence so a records-empty
    // but meta-present state is NOT treated as "no_data" and skipped during a
    // pre-destructive safety backup.
    hasLikedSyncMeta: !!envelope.likedSyncMeta,
    exportedAt: envelope.exportedAt,
  };
}

function revokeExportBlobUrl(message) {
  const blobUrl = message.blobUrl || (message.requestId && exportBlobUrls.get(message.requestId));
  if (!blobUrl) return { revoked: false };
  URL.revokeObjectURL(blobUrl);
  if (message.requestId) exportBlobUrls.delete(message.requestId);
  for (const [id, url] of exportBlobUrls.entries()) {
    if (url === blobUrl) exportBlobUrls.delete(id);
  }
  return { revoked: true };
}

async function importPayload(message, merge) {
  const parsed = WatchedDB.parseImportData(message.data);
  const watchedIds = parsed.watchedVideos
    .map((record) => record && record.videoId)
    .filter((videoId) => typeof videoId === 'string' && videoId);
  const watched = merge
    ? await WatchedDB.mergeImport(parsed.watchedVideos)
    : { count: await WatchedDB.importData(parsed.watchedVideos) };
  // u1ps §7.3 (Codex B2 VERIFY blocker 1): "安全に統合" (merge) must keep current
  // liked records (add-only); "backup優先で統合" (non-merge) overwrites (put).
  let likedCount = 0;
  let likedError = null;
  if (parsed.likedVideos.length) {
    try {
      if (merge) {
        likedCount = (await WatchedDB.mergeLikedData(parsed.likedVideos)).added;
      } else {
        likedCount = await WatchedDB.importLikedData(parsed.likedVideos);
      }
    } catch (error) {
      // Watched records have already committed. Report a visible partial success
      // instead of turning the whole response into an apparently total failure.
      likedError = error && error.message ? error.message : String(error);
    }
  }
  return {
    count: merge ? watched.total : watched.count,
    added: merge ? watched.added : undefined,
    skipped: merge ? watched.skipped : undefined,
    total: merge ? watched.total : parsed.watchedVideos.length,
    // M3: corrupt records dropped during parse (rest were restored).
    dropped: {
      watched: parsed.droppedWatched || 0,
      liked: parsed.droppedLiked || 0,
      // u1ps (Codex B1 VERIFY minor 2): non-array likedVideos block skipped whole.
      likedStructural: !!parsed.likedStructuralError,
      likedMetaStructural: !!parsed.likedMetaStructuralError,
    },
    watchedIds,
    watched,
    partialSuccess: likedError !== null,
    liked: { imported: likedCount, failed: likedError !== null, error: likedError || undefined },
    likedSyncMeta: parsed.likedSyncMeta,
  };
}

// u1ps §7.3: read-only dry-run diff of an import backup vs the current DB.
async function importDiff(message) {
  const parsed = WatchedDB.parseImportData(message.data);
  const currentWatchedIds = await WatchedDB.getAllIds();
  const currentLikedRows = await WatchedDB.getAllLiked();
  const currentLikedIds = currentLikedRows
    .map((r) => r && r.videoId)
    .filter((v) => typeof v === 'string' && v);
  return { diff: WatchedDB.diffImport(parsed, currentWatchedIds, currentLikedIds) };
}

// u1ps §7.3: apply a "置換 (replace)" import. Final state = the backup's records.
// Race-safe like CLEAR_ALL: the caller passes the ids captured in the pre-replace
// backup SNAPSHOT (message.snapshotWatchedIds/snapshotLikedIds). We delete only
// (snapshot \ new) — records added AFTER the snapshot are in neither list, so
// they survive instead of being deleted-without-backup — then put the new
// records (backup wins on overlap). Meta is returned for a FAITHFUL set by the
// caller (including null -> clear; Codex B1 VERIFY blocker 3).
async function replaceApply(message) {
  const parsed = WatchedDB.parseImportData(message.data);
  const newWatched = new Set(parsed.watchedVideos.map((r) => r.videoId));
  const newLiked = new Set(parsed.likedVideos.map((r) => r.videoId));
  const snapW = Array.isArray(message.snapshotWatchedIds) ? message.snapshotWatchedIds : [];
  const snapL = Array.isArray(message.snapshotLikedIds) ? message.snapshotLikedIds : [];
  const delWatched = snapW.filter((id) => !newWatched.has(id));
  const delLiked = snapL.filter((id) => !newLiked.has(id));
  // u1ps §7.3 (Codex B2 VERIFY blocker 3): ONE atomic transaction — delete
  // snapshot-only + put the new records — so a mid-way failure leaves the DB
  // unchanged rather than half-replaced.
  const res = await WatchedDB.replaceRecords(delWatched, delLiked, parsed.watchedVideos, parsed.likedVideos);
  const watchedIds = parsed.watchedVideos
    .map((r) => r && r.videoId)
    .filter((v) => typeof v === 'string' && v);
  return {
    replaced: true,
    count: res.importedWatched,
    removed: { watched: res.deletedWatched, liked: res.deletedLiked },
    dropped: {
      watched: parsed.droppedWatched || 0,
      liked: parsed.droppedLiked || 0,
      likedStructural: !!parsed.likedStructuralError,
      likedMetaStructural: !!parsed.likedMetaStructuralError,
    },
    watchedIds,
    liked: { imported: res.importedLiked },
    // Faithful replace: caller sets meta to exactly this (null clears). Replace
    // intentionally imposes the backup's meta (it is a "restore to this backup"),
    // unlike CLEAR_ALL which uses compare-and-set — see the REPLACE_IMPORT handler.
    likedSyncMeta: parsed.likedSyncMeta,
    metaFaithful: true,
  };
}

async function handleDbRpc(message) {
  switch (message.op) {
    case 'GET_STATS':
      return WatchedDB.getStats();
    case 'GET_ALL_IDS':
      return WatchedDB.getAllIds();
    case 'GET_WATCHED_IDS_PAGE':
    case 'DB_GET_WATCHED_IDS_PAGE':
      return WatchedDB.getWatchedIdsPage(message.cursor || null, message.limit || 8000);
    case 'CHECK_MULTIPLE':
    case 'DB_CHECK_MULTIPLE':
      return WatchedDB.checkMultiple(message.videoIds || []);
    case 'ADD_WATCHED':
    case 'DB_ADD_WATCHED':
      return WatchedDB.addWatched(message.videoId, message.title || '', message.source || 'self', message.channel || '', message.durationSec, message.category || '');
    case 'UPDATE_DURATION':
      return WatchedDB.updateDuration(message.videoId, message.durationSec);
    case 'MARK_DURATION_FAILED':
      return WatchedDB.markDurationFailed(message.videoId, message.reason || 'unknown');
    case 'MARK_DURATION_LIVE':
      return WatchedDB.markDurationLive(message.videoId);
    case 'UPDATE_TITLE_CHANNEL':
      return WatchedDB.updateTitleAndChannel(message.videoId, message.title || '', message.channel || '', !!message.force);
    case 'EXPORT_DATA':
      return WatchedDB.exportAll({ source: message.source || 'manual', likedSyncMeta: message.likedSyncMeta || null, appVersion: message.appVersion });
    case 'OFFSCREEN_CREATE_EXPORT_BLOB': {
      const envelope = message.envelope || await WatchedDB.exportAll({
        source: message.source || 'manual',
        likedSyncMeta: message.likedSyncMeta || null,
        appVersion: message.appVersion,
      });
      return createExportBlobUrl(envelope);
    }
    case 'OFFSCREEN_REVOKE_BLOB':
      return revokeExportBlobUrl(message);
    case 'IMPORT_DATA':
      return importPayload(message, false);
    case 'MERGE_IMPORT':
      return importPayload(message, true);
    case 'IMPORT_DIFF':
      // u1ps §7.3: read-only dry-run diff (no mutation).
      return importDiff(message);
    case 'REPLACE_APPLY':
      // u1ps §7.3: destructive replace (delete snapshot-only + import backup).
      return replaceApply(message);
    case 'DELETE_VIDEO':
      return WatchedDB.deleteOne(message.videoId);
    case 'CLEAR_DATA':
      return WatchedDB.clearAll();
    case 'DELETE_SNAPSHOT':
      // u1ps §7.4 (Codex B1 VERIFY blocker 2, freeze-free): delete exactly the
      // record IDs captured in the pre-reset backup snapshot. Records written
      // AFTER the snapshot are absent from these lists, so they survive rather
      // than being deleted-without-backup — no lock/freeze needed.
      return WatchedDB.deleteManyRecords(message.watchedIds || [], message.likedIds || []);
    case 'UPSERT_LIKED':
      return WatchedDB.upsertLiked(message.items || [], message.accountId || '');
    case 'GET_LIKED':
      return WatchedDB.getAllLiked();
    case 'GET_LIKED_STATS':
      return WatchedDB.getLikedStats();
    case 'CLEAR_LIKED':
      return WatchedDB.clearLikedByAccount(message.accountId || '');
    case 'IMPORT_LIKED_DATA':
      return WatchedDB.importLikedData(message.records || []);
    case 'IMPORT_LEGACY_V135': {
      const watched = WatchedDB.unwrapImport(message.watched) || message.watched || [];
      const liked = Array.isArray(message.liked) ? message.liked : [];
      const watchedCount = await WatchedDB.importData(watched);
      const likedCount = await WatchedDB.importLikedData(liked);
      return { watched: watchedCount, liked: likedCount };
    }
    case 'MARK_CREDITS_CHECKED':
      return WatchedDB.markCreditsChecked(message.videoId);
    case 'MARK_CREDITS_FAILED':
      return WatchedDB.markCreditsFailed(message.videoId, message.reason || 'unknown');
    case 'UPDATE_CREDITS':
      return WatchedDB.updateCredits(message.videoId, message.credits || {}, !!message.force, message.creditsSource || '');
    case 'GET_CREDITS_FOR_VIDEO_IDS':
      return WatchedDB.getCreditsForVideoIds(message.videoIds || []);
    case 'SET_MANUAL_CREDIT_ROLE': {
      const args = {
        videoId: message.videoId,
        role: message.role,
        value: message.value,
        expectedCurrent: message.expectedCurrent,
        expectedSource: message.expectedSource,
      };
      if (Object.prototype.hasOwnProperty.call(message, 'restoreRoleSource')) {
        args.restoreRoleSource = message.restoreRoleSource;
      }
      return WatchedDB.setManualCreditRole(args);
    }
    case 'CLEAN_ALL_CREDITS':
      return WatchedDB.cleanAllCredits();
    default:
      throw new Error('Unknown DB op: ' + message.op);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen-db') return false;

  handleDbRpc(message)
    .then((result) => sendResponse({ success: true, result }))
    .catch((error) => {
      sendResponse({
        success: false,
        error: error && error.message ? error.message : String(error),
      });
    });
  return true;
});
