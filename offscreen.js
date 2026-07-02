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
  const likedCount = parsed.likedVideos.length
    ? await WatchedDB.importLikedData(parsed.likedVideos)
    : 0;
  return {
    count: merge ? watched.total : watched.count,
    added: merge ? watched.added : undefined,
    skipped: merge ? watched.skipped : undefined,
    total: merge ? watched.total : parsed.watchedVideos.length,
    watchedIds,
    watched,
    liked: { imported: likedCount },
    likedSyncMeta: parsed.likedSyncMeta,
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
    case 'DELETE_VIDEO':
      return WatchedDB.deleteOne(message.videoId);
    case 'CLEAR_DATA':
      return WatchedDB.clearAll();
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
