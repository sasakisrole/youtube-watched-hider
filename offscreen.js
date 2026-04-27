// Offscreen document DB owner for YouTube Watched Hider.
// Keeps IndexedDB on the extension origin instead of youtube.com.

async function handleDbRpc(message) {
  switch (message.op) {
    case 'GET_STATS':
      return WatchedDB.getStats();
    case 'GET_ALL_IDS':
      return WatchedDB.getAllIds();
    case 'CHECK_MULTIPLE':
      return WatchedDB.checkMultiple(message.videoIds || []);
    case 'ADD_WATCHED':
      return WatchedDB.addWatched(message.videoId, message.title || '', message.source || 'self', message.channel || '');
    case 'UPDATE_TITLE_CHANNEL':
      return WatchedDB.updateTitleAndChannel(message.videoId, message.title || '', message.channel || '', !!message.force);
    case 'EXPORT_DATA':
      return WatchedDB.exportAll();
    case 'IMPORT_DATA':
      return WatchedDB.importData(WatchedDB.unwrapImport(message.data) || message.data || []);
    case 'MERGE_IMPORT':
      return WatchedDB.mergeImport(WatchedDB.unwrapImport(message.data) || message.data || []);
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
