// Content script for YouTube Watched Hider
// Safe to re-inject: cleans up previous instance before initializing

// Clean up previous instance if re-injected
if (window._ytWatchedHider) {
  try {
    window._ytWatchedHider.cleanup();
  } catch (e) {
    // ignore cleanup errors
  }
}

window._ytWatchedHider = (() => {
  // Selectors for video card containers (update these if YouTube changes DOM)
  const SELECTORS = {
    // Video card containers (old + new UI)
    richItem: 'ytd-rich-item-renderer',           // Home page grid
    videoRenderer: 'ytd-video-renderer',           // Search results
    compactVideo: 'ytd-compact-video-renderer',    // Sidebar (old UI)
    lockup: 'yt-lockup-view-model',               // Recommendations (new UI)

    // Link containing video ID
    videoLink: 'a[href*="/watch?v="]',

    // YouTube's own watched indicator (red progress bar on thumbnail)
    seekbar: '#progress',
    resumeOverlay: 'ytd-thumbnail-overlay-resume-playback-renderer',
    // New YouTube UI progress bar
    progressBarNew: '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment',
  };

  const ALL_CARD_SELECTORS = [
    SELECTORS.richItem,
    SELECTORS.videoRenderer,
    SELECTORS.compactVideo,
    SELECTORS.lockup,
  ].join(', ');

  let enabled = true;
  let recordWhileOff = false;
  let harvestMode = false;
  const harvest = { running: false, added: 0, scanned: 0, noNewStreak: 0, timer: null, ui: null, styleEl: null };

  // Extension context lifecycle (also extracted by the regression harness).
  let contextInvalidated = false;
  let contextReady = false;
  const contextTimers = new Set();
  const reloadNoticeId = '__yt_watched_hider_reload_notice';

  // Own only this content script's timers so invalidation can cancel every retry.
  function setTimeout(callback, delay) {
    if (contextInvalidated) return null;
    const timer = window.setTimeout(() => {
      contextTimers.delete(timer);
      if (!contextInvalidated) callback();
    }, delay);
    contextTimers.add(timer);
    return timer;
  }

  function clearTimeout(timer) {
    contextTimers.delete(timer);
    window.clearTimeout(timer);
  }

  function showReloadNotice() {
    if (document.getElementById(reloadNoticeId)) return;
    const el = document.createElement('div');
    el.id = reloadNoticeId;
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
      'max-width:calc(100vw - 40px)', 'box-sizing:border-box',
      'background:rgba(30,30,30,0.96)', 'color:#fff', 'padding:12px 16px',
      'border-radius:8px', 'font:500 14px/1.5 system-ui,sans-serif',
      'box-shadow:0 4px 12px rgba(0,0,0,0.3)'
    ].join(';');
    const message = document.createElement('span');
    message.textContent = 'YT-Watched-Hider が更新されました。このページを再読み込みしてください';
    el.appendChild(message);
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = '再読み込み';
    reload.style.cssText = 'margin:8px 0 0 12px;padding:6px 12px;cursor:pointer;background:#1a73e8;color:#fff;border:0;border-radius:4px;font:inherit';
    reload.addEventListener('click', () => location.reload());
    el.appendChild(reload);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '閉じる';
    close.style.cssText = 'margin-left:8px;padding:6px 12px;cursor:pointer;background:#444;color:#fff;border:0;border-radius:4px;font:inherit';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
    (document.body || document.documentElement).appendChild(el);
  }

  function detectContextInvalidation(error) {
    if (contextInvalidated) return true;
    // CONTEXT_INVALIDATION_PREDICATE: the control test disables only this check.
    const invalidated = !chrome.runtime?.id || String(error?.message || error || '').includes('Extension context invalidated');
    if (!invalidated) return false;
    contextInvalidated = true;
    for (const timer of contextTimers) window.clearTimeout(timer);
    contextTimers.clear();
    if (contextReady) cleanup(true);
    console.warn('[YT-Watched-Hider] 拡張が更新されました。このページを再読み込みしてください');
    showReloadNotice();
    return true;
  }

  function sendRuntimeMessage(message, callback) {
    const finish = (response, error) => {
      if (detectContextInvalidation(error)) {
        error = Object.assign(new Error('Extension context invalidated'), { contextInvalidated: true });
        response = undefined;
      }
      callback(response, error);
    };
    if (detectContextInvalidation()) {
      finish();
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime?.lastError;
        finish(response, error ? new Error(error.message) : undefined);
      });
    } catch (error) {
      finish(undefined, error);
    }
  }
  // End extension context lifecycle.

  // Import toast: shows "+N件 取り込み" when new records are added to DB.
  // Accumulates count during rapid imports and auto-dismisses after idle.
  const toastState = { el: null, count: 0, timer: null };
  function showImportToast(n) {
    if (contextInvalidated || !n || n <= 0) return;
    toastState.count += n;
    if (!toastState.el) {
      const el = document.createElement('div');
      el.id = '__yt_watched_hider_toast';
      el.style.cssText = [
        'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
        'background:rgba(30,30,30,0.92)', 'color:#fff', 'padding:10px 16px',
        'border-radius:8px', 'font:500 13px/1.4 system-ui,sans-serif',
        'box-shadow:0 4px 12px rgba(0,0,0,0.3)', 'pointer-events:none',
        'transition:opacity 0.3s', 'opacity:0'
      ].join(';');
      document.body.appendChild(el);
      toastState.el = el;
      requestAnimationFrame(() => { if (toastState.el) toastState.el.style.opacity = '1'; });
    }
    toastState.el.textContent = `+${toastState.count}件 視聴済みに取り込み`;
    clearTimeout(toastState.timer);
    toastState.timer = setTimeout(() => {
      if (!toastState.el) return;
      toastState.el.style.opacity = '0';
      setTimeout(() => {
        if (toastState.el) { toastState.el.remove(); toastState.el = null; }
        toastState.count = 0;
      }, 350);
    }, 3000);
  }
  let hideShorts = false;
  let hideMovies = false;

  // Selectors for Shorts content
  const SHORTS_SELECTORS = {
    shortsLink: 'a[href*="/shorts/"]',
    reelShelf: 'ytd-reel-shelf-renderer',         // Shorts shelf on home
    richShelf: 'ytd-rich-shelf-renderer',          // Rich shelf (may contain Shorts)
  };
  let processQueued = false;
  let processRunning = false;
  let currentVideoElement = null;
  let endedHandler = null;

  // Three-layer cache for large watched histories. Full preload is kept up to
  // 200k IDs; above that we retain positives already loaded and fall back to
  // paged/negative LRU lookups instead of discarding the cache.
  const FULL_CACHE_SOFT_LIMIT = 120000; // warn only: current DB can still preload
  const FULL_CACHE_HARD_LIMIT = 200000; // switch to partial mode beyond this
  const RECENT_LOOKUP_MAX = 20000;
  const RECENT_NEGATIVE_TTL_MS = 10 * 60 * 1000;
  const PAGED_LOAD_CHUNK = 8000; // DB_GET_WATCHED_IDS_PAGE transfer size
  const watchedPositive = new Set();
  const recentLookup = new Map();
  const pendingLookup = new Map();
  let cacheLoaded = false;
  let cacheLoadTime = 0;
  let cacheLoadedPages = 0;
  let cacheMode = 'full'; // 'full' | 'partial' | 'error'
  let dbStatus = 'loading'; // 'loading' | 'ready' | 'error'
  let cacheLoadSeq = 0;

  function dbRpc(op, payload = {}) {
    return new Promise((resolve, reject) => {
      try {
        sendRuntimeMessage({ type: 'DB_RPC', op, ...payload }, (response, error) => {
          if (error) {
            reject(error);
            return;
          }
          if (!response || !response.success) {
            const error = new Error((response && response.error) || 'DB RPC failed');
            if (detectContextInvalidation(error)) error.contextInvalidated = true;
            reject(error);
            return;
          }
          resolve(response.result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  const DBClient = {
    get contextInvalidated() { return contextInvalidated; },
    getAllIds: () => dbRpc('GET_ALL_IDS'),
    getWatchedIdsPage: (cursor, limit) => dbRpc('DB_GET_WATCHED_IDS_PAGE', { cursor, limit }),
    checkMultiple: (videoIds) => dbRpc('DB_CHECK_MULTIPLE', { videoIds }),
    addWatched: (videoId, title = '', source = 'self', channel = '', durationSec = null, category = '') =>
      dbRpc('DB_ADD_WATCHED', { videoId, title, source, channel, durationSec, category }),
    updateTitleAndChannel: (videoId, title, channel, force = false) =>
      dbRpc('UPDATE_TITLE_CHANNEL', { videoId, title, channel, force }),
    importData: (data) => dbRpc('IMPORT_DATA', { data }),
  };

  function trimRecentLookup() {
    while (recentLookup.size > RECENT_LOOKUP_MAX) {
      const firstKey = recentLookup.keys().next().value;
      if (firstKey === undefined) break;
      recentLookup.delete(firstKey);
    }
  }

  function setRecentLookup(videoId, watched) {
    if (!videoId) return;
    recentLookup.delete(videoId);
    const entry = { watched: !!watched };
    if (!watched) entry.expiresAt = Date.now() + RECENT_NEGATIVE_TTL_MS;
    recentLookup.set(videoId, entry);
    trimRecentLookup();
  }

  function getRecentLookup(videoId) {
    const entry = recentLookup.get(videoId);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      recentLookup.delete(videoId);
      return undefined;
    }
    recentLookup.delete(videoId);
    recentLookup.set(videoId, entry);
    return !!entry.watched;
  }

  function rememberWatched(videoId) {
    if (!videoId) return;
    watchedPositive.add(videoId);
    setRecentLookup(videoId, true);
  }

  function rememberNotWatched(videoId) {
    if (!videoId || watchedPositive.has(videoId)) return;
    setRecentLookup(videoId, false);
  }

  function forgetWatched(videoId) {
    if (!videoId) return;
    watchedPositive.delete(videoId);
    recentLookup.delete(videoId);
    pendingLookup.delete(videoId);
  }

  function recordSeekbarWatched(card, videoId, title, channel, durationSec) {
    if (DBClient.contextInvalidated) return;
    hideCard(card, videoId);
    rememberWatched(videoId);
    return DBClient.addWatched(videoId, title, 'seekbar', channel, durationSec).then((res) => {
      if (res && res.isNew) showImportToast(1);
      return res;
    }).catch((e) => {
      forgetWatched(videoId);
      if (card.dataset.watchedHidden === 'true' && card.dataset.watchedVideoId === videoId) {
        card.style.display = '';
        delete card.dataset.watchedHidden;
        delete card.dataset.watchedVideoId;
      }
      if (!e.contextInvalidated) console.error('[YT-Watched-Hider] Error recording seekbar video:', e);
    });
  }

  function getCachedWatchedState(videoId) {
    if (!videoId) return false;
    if (watchedPositive.has(videoId)) return true;
    // §8.3 (H1, reviewer-flagged bypass): a failed initial full-cache load
    // (cacheMode='error') is a DB-confirmation failure, not evidence of "not
    // watched" — returning false here used to let every lookup short-circuit
    // to a confident negative BEFORE it ever reached lookupWatchedForIds'
    // three-valued checkMultiple path, permanently hiding the tri-state fix
    // for the single most common real-world DB-error trigger (cache load
    // failure on startup). undefined falls through to the caller's batch path
    // (cardMap / unchecked -> lookupWatchedForIds -> DBClient.checkMultiple),
    // which can still recover per-id if the DB is actually reachable, and
    // otherwise resolves to undefined (indeterminate) without negative-caching.
    if (cacheMode === 'error') return undefined;
    if (cacheLoaded && cacheMode === 'full') {
      rememberNotWatched(videoId);
      return false;
    }
    const recent = getRecentLookup(videoId);
    return recent === undefined ? undefined : recent;
  }

  async function lookupWatchedForIds(videoIds) {
    const results = {};
    const uniqueIds = [];
    const seen = new Set();
    for (const id of videoIds || []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      uniqueIds.push(id);
    }

    const waits = [];
    const toQuery = [];
    for (const id of uniqueIds) {
      const cached = getCachedWatchedState(id);
      if (cached !== undefined) {
        results[id] = cached;
        continue;
      }
      const pending = pendingLookup.get(id);
      if (pending) {
        waits.push(pending.then((watched) => { results[id] = watched; }));
        continue;
      }
      toQuery.push(id);
    }

    if (toQuery.length > 0) {
      const batchPromise = DBClient.checkMultiple(toQuery);
      let errorLogged = false;
      for (const id of toQuery) {
        let lookupPromise;
        lookupPromise = batchPromise
          .then((batch) => {
            const watched = !!(batch && batch[id]);
            if (watched) {
              rememberWatched(id);
            } else {
              rememberNotWatched(id);
            }
            return watched;
          })
          .catch((e) => {
            if (!errorLogged) {
              errorLogged = true;
              if (!e.contextInvalidated) console.warn('[YT-Watched-Hider] DB_CHECK_MULTIPLE failed:', e);
            }
            // §8.3 (H1): "confirmation failed" is NOT "not watched". Returning
            // false here used to get cached and surfaced downstream as a
            // confident negative, hiding a false "not watched" state instead of
            // a real one. `undefined` is the three-valued "indeterminate"
            // signal — callers must not fold it into the negative case, and we
            // must not call rememberNotWatched(id) for it (no negative caching
            // on error; the id gets re-queried on the next lookup instead).
            return undefined;
          })
          .finally(() => {
            if (pendingLookup.get(id) === lookupPromise) pendingLookup.delete(id);
          });
        pendingLookup.set(id, lookupPromise);
        waits.push(lookupPromise.then((watched) => { results[id] = watched; }));
      }
    }

    if (waits.length > 0) await Promise.all(waits);
    return results;
  }

  function getCacheStats() {
    return {
      cacheMode,
      positiveCacheSize: watchedPositive.size,
      recentCacheSize: recentLookup.size,
      cacheLoadTime,
      cacheLoadedPages,
      cacheSize: watchedPositive.size,
      cacheLoaded,
      dbStatus,
    };
  }

  // Load watched IDs into the positive cache in pages to avoid one huge RPC.
  async function loadCache() {
    const seq = ++cacheLoadSeq;
    const t0 = performance.now();
    watchedPositive.clear();
    recentLookup.clear();
    pendingLookup.clear();
    cacheLoaded = false;
    cacheLoadedPages = 0;
    cacheMode = 'full';
    dbStatus = 'loading';
    try {
      let cursor = null;
      let hardLimitHit = false;
      while (true) {
        const page = await DBClient.getWatchedIdsPage(cursor, PAGED_LOAD_CHUNK);
        if (seq !== cacheLoadSeq) return;
        const ids = Array.isArray(page && page.ids) ? page.ids : [];
        cacheLoadedPages++;
        for (const id of ids) {
          if (watchedPositive.size >= FULL_CACHE_HARD_LIMIT) {
            hardLimitHit = true;
            break;
          }
          watchedPositive.add(id);
        }
        if (!hardLimitHit && watchedPositive.size >= FULL_CACHE_HARD_LIMIT && page && page.nextCursor) {
          hardLimitHit = true;
        }
        if (hardLimitHit) break;
        cursor = page && page.nextCursor ? page.nextCursor : null;
        if (!cursor) break;
      }
      cacheLoaded = true;
      cacheLoadTime = Math.round(performance.now() - t0);
      cacheMode = hardLimitHit ? 'partial' : 'full';
      dbStatus = 'ready';
      if (watchedPositive.size > FULL_CACHE_SOFT_LIMIT) {
        console.warn(`[YT-Watched-Hider] Positive cache above soft limit (${watchedPositive.size}/${FULL_CACHE_SOFT_LIMIT})`);
      }
      if (hardLimitHit) {
        console.warn(`[YT-Watched-Hider] Cache hard limit reached at ${watchedPositive.size}; continuing in partial mode`);
      }
      console.log(`[YT-Watched-Hider] DB ready: ${watchedPositive.size} positives, mode=${cacheMode}, pages=${cacheLoadedPages}, ${cacheLoadTime}ms`);
      // Cache is now ready — run a full pass to catch anything missed during phase 1
      if (enabled) processPage();
    } catch (e) {
      if (seq !== cacheLoadSeq) return;
      cacheLoadTime = Math.round(performance.now() - t0);
      cacheLoadedPages = 0;
      cacheMode = 'error';
      dbStatus = 'error';
      if (!e.contextInvalidated) console.error(`[YT-Watched-Hider] DB load failed (${cacheLoadTime}ms):`, e);
      cacheLoaded = false;
    }
  }
  loadCache();

  function readLegacyStore(db, storeName) {
    if (!db.objectStoreNames.contains(storeName)) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (event) => reject(event.target.error);
    });
  }

  function openLegacyDbForMigration() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open('YouTubeWatchedDB');
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error('legacy IndexedDB open timed out'));
      }, 5000);
      req.onupgradeneeded = () => {
        // New users may not have an old youtube.com DB. Leave the empty DB as-is.
      };
      req.onsuccess = (event) => {
        clearTimeout(timer);
        const db = event.target.result;
        if (settled) {
          try { db.close(); } catch (_) {}
          return;
        }
        settled = true;
        db.onversionchange = () => {
          try { db.close(); } catch (_) {}
        };
        resolve(db);
      };
      req.onerror = (event) => {
        clearTimeout(timer);
        settled = true;
        reject(event.target.error);
      };
      req.onblocked = () => {
        console.warn('[YT-Watched-Hider] Legacy DB migration open blocked');
      };
    });
  }

  async function exportLegacyV135Data() {
    let db = null;
    try {
      db = await openLegacyDbForMigration();
      const watched = await readLegacyStore(db, 'watchedVideos');
      const liked = await readLegacyStore(db, 'likedVideos');
      return { success: true, watched, liked, counts: { watched: watched.length, liked: liked.length } };
    } finally {
      if (db) {
        try { db.close(); } catch (_) {}
      }
    }
  }

  function maybeRunV135Migration() {
    if (location.hostname !== 'www.youtube.com' && location.hostname !== 'youtube.com') return;
    sendRuntimeMessage({ type: 'V135_CONTENT_READY' }, async (response, error) => {
      if (error || !response || !response.run) return;
      let payload;
      try {
        payload = await exportLegacyV135Data();
        console.info('[YT-Watched-Hider] v1.35 migration export:', payload.counts);
      } catch (e) {
        payload = { success: false, error: e.message };
      }
      sendRuntimeMessage({ type: 'V135_LEGACY_EXPORT', payload }, (result, error) => {
        if (error || !result || !result.success) return;
        const count = (result.watched || 0) + (result.liked || 0);
        if (count > 0) {
          watchedPositive.clear();
          recentLookup.clear();
          pendingLookup.clear();
          cacheLoaded = false;
          loadCache();
        }
      });
    });
  }
  maybeRunV135Migration();

  // Load settings — start seekbar-only processing immediately (no DB needed)
  if (!contextInvalidated) chrome.storage.local.get({ enabled: true, recordWhileOff: false, hideShorts: false, hideMovies: false, harvestMode: false }, (result) => {
    if (detectContextInvalidation()) return;
    enabled = result.enabled;
    recordWhileOff = result.recordWhileOff;
    hideShorts = result.hideShorts;
    hideMovies = result.hideMovies;
    harvestMode = result.harvestMode;
    if (enabled) processPage(); // phase 1: seekbar detection works even without cache
    if (harvestMode && isHistoryPage()) ensureHarvestUI();
  });

  // Returns true if the card is a playlist/mix/show container, not a single video card.
  // These should never be hidden even if they contain /watch?v= links.
  function isPlaylistCard(card) {
    return !!(
      card.querySelector('ytd-grid-playlist-renderer, ytd-playlist-renderer, ytd-radio-renderer') ||
      card.querySelector('[overlay-style="PLAYLIST"], [overlay-style="MIX"], [overlay-style="SHOW"]') ||
      card.querySelector('yt-thumbnail-overlay-side-panel-renderer, #overlays .thumbnail-overlay-badge-shape[aria-label]')
    );
  }

  // Extract video ID from href
  function getVideoIdFromHref(href) {
    try {
      const url = new URL(href, location.origin);
      return url.searchParams.get('v');
    } catch {
      return null;
    }
  }

  // Get title from a video card element
  function getTitleFromCard(card) {
    const titleEl = card.querySelector(
      '#video-title, ' +
      'a#video-title-link, ' +
      'span#video-title, ' +
      'yt-formatted-string#video-title, ' +
      'h3 a'
    );
    return titleEl ? titleEl.textContent.trim() : '';
  }

  // Get channel name from a video card element
  function getChannelFromCard(card) {
    const channelEl = card.querySelector(
      'ytd-channel-name #text-container yt-formatted-string a, ' +
      'ytd-channel-name #text-container yt-formatted-string, ' +
      'ytd-channel-name yt-formatted-string a, ' +
      'ytd-channel-name yt-formatted-string, ' +
      '#channel-name yt-formatted-string a, ' +
      '#channel-name a, ' +
      '.yt-lockup-metadata-view-model__metadata a'
    );
    return channelEl ? channelEl.textContent.trim() : '';
  }

  // Minimum progress percentage to consider a video "watched"
  const WATCHED_THRESHOLD = 95;

  // Check if a card has YouTube's seekbar indicating >= 95% watched
  function hasYouTubeSeekbar(card) {
    // Old UI: resume playback overlay (YouTube only shows this for completed videos)
    const resume = card.querySelector(SELECTORS.resumeOverlay);
    if (resume) return true;

    // Old UI: #progress element with width
    const progress = card.querySelector(SELECTORS.seekbar);
    if (progress && progress.style && parseFloat(progress.style.width) >= WATCHED_THRESHOLD) return true;

    // New UI: progress bar segment with width percentage
    const segment = card.querySelector(SELECTORS.progressBarNew);
    if (segment && segment.style && parseFloat(segment.style.width) >= WATCHED_THRESHOLD) return true;

    return false;
  }

  // Get current video ID from URL (for the page being watched)
  function getCurrentVideoId() {
    return getVideoIdFromHref(location.href);
  }

  // Get title from watch page
  function getWatchPageTitle() {
    const titleEl = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, ' +
      '#title h1 yt-formatted-string, ' +
      'ytd-watch-metadata h1 yt-formatted-string'
    );
    return titleEl ? titleEl.textContent.trim() : '';
  }

  // Get channel name from watch page.
  // IMPORTANT: Scope strictly to the primary watch metadata area.
  // Broad fallbacks like '#channel-name ...' can match sidebar/recommendation
  // items when ytd-watch-metadata hasn't rendered yet, causing wrong channel.
  function getWatchPageChannel() {
    const root =
      document.querySelector('ytd-watch-metadata') ||
      document.querySelector('#owner');
    if (!root) return '';
    const channelEl = root.querySelector(
      'ytd-channel-name yt-formatted-string a, ' +
      'ytd-video-owner-renderer ytd-channel-name a, ' +
      'ytd-channel-name a'
    );
    return channelEl ? channelEl.textContent.trim() : '';
  }

  function parseDurationText(text) {
    if (!text) return null;
    const raw = String(text).trim();
    if (!raw || /live|ライブ/i.test(raw)) return -1;
    if (!/^\d+(?::\d+){1,2}$/.test(raw)) return null;
    const parts = raw.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return null;
    return parts.reduce((sum, n) => sum * 60 + n, 0);
  }

  function getDurationFromCard(card) {
    const el = card.querySelector(
      'ytd-thumbnail-overlay-time-status-renderer #text, ' +
      'ytd-thumbnail-overlay-time-status-renderer, ' +
      '.badge-shape-wiz__text, ' +
      '.yt-badge-shape__text'
    );
    return parseDurationText(el ? el.textContent : '');
  }

  function normalizeDurationValue(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  function durationFromPlayerResponse(playerResponse) {
    const details = playerResponse && playerResponse.videoDetails;
    if (!details) return null;
    if (details.isLiveContent === true) return -1;
    return normalizeDurationValue(details.lengthSeconds);
  }

  function extractBalancedJson(text, startIndex) {
    const p = text.indexOf('{', startIndex);
    if (p === -1) return '';
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = p; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (c === '\\') escape = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(p, i + 1);
      }
    }
    return '';
  }

  // Duration for the CURRENT video from ytInitialPlayerResponse. H1 sibling
  // (PENDING id:8v48): identical staleness risk to getCurrentVideoCategory — a
  // stale ytInitialPlayerResponse script from a prior SPA page can linger in
  // document.scripts, so without a videoId check we could save the PREVIOUS
  // video's length (silently polluting the duration distribution / length-based
  // taste). When expectedVideoId is supplied we only trust a response that
  // POSITIVELY matches it; an unattributable response (missing or different id)
  // is treated as stale and skipped (caller then falls back to meta / <video>).
  function getInitialPlayerResponseDurationSec(expectedVideoId) {
    const accept = (playerResponse) => {
      const durationSec = durationFromPlayerResponse(playerResponse);
      if (durationSec == null) return null;
      if (expectedVideoId
          && videoIdFromPlayerResponse(playerResponse) !== expectedVideoId) {
        return null;
      }
      return durationSec;
    };

    try {
      const direct = accept(window.ytInitialPlayerResponse);
      if (direct != null) return direct;
    } catch (_e) { /* isolated world usually cannot see page globals */ }

    const markers = ['ytInitialPlayerResponse =', 'ytInitialPlayerResponse='];
    for (const script of document.scripts) {
      const text = script.textContent || '';
      if (!text.includes('ytInitialPlayerResponse')) continue;
      for (const marker of markers) {
        const idx = text.indexOf(marker);
        if (idx === -1) continue;
        const json = extractBalancedJson(text, idx + marker.length);
        if (!json) continue;
        try {
          const parsed = JSON.parse(json);
          const durationSec = accept(parsed);
          if (durationSec != null) return durationSec;
        } catch (_e) { /* try the next script */ }
      }
    }
    return null;
  }

  // microformat category ("Music" / "Gaming" / "Education" / "Comedy" ...).
  // Captured as a forward-only evidence field (PENDING L98): the analyzer uses
  // category != "Music" as NEGATIVE evidence for music, never as positive proof
  // (教則/機材/替え歌 all report "Music"). Missing -> '' -> analyzer falls back.
  // Value is trimmed at capture (L1: tolerate stray whitespace so the analyzer's
  // exact-match veto isn't tripped by " Music ").
  function categoryFromPlayerResponse(playerResponse) {
    const mf = playerResponse && playerResponse.microformat
      && playerResponse.microformat.playerMicroformatRenderer;
    const cat = mf && mf.category;
    return typeof cat === 'string' && cat.trim() ? cat.trim() : '';
  }

  // videoId carried by a player response, if any. Used to confirm the response
  // actually belongs to the video we are recording (see getCurrentVideoCategory).
  function videoIdFromPlayerResponse(playerResponse) {
    const vd = playerResponse && playerResponse.videoDetails;
    const vid = vd && vd.videoId;
    return typeof vid === 'string' && vid ? vid : '';
  }

  // Category for the CURRENT video. H1 (Codex wrapup-review_4): a stale
  // ytInitialPlayerResponse script from a prior SPA page can linger in
  // document.scripts; without verifying its videoId we could attach the
  // PREVIOUS video's category (flipping a music-titled video to non-music via
  // the analyzer's negative-evidence veto). When expectedVideoId is supplied we
  // only trust a response that POSITIVELY matches it; an unattributable response
  // (missing or different id) is treated as stale and skipped.
  function getCurrentVideoCategory(expectedVideoId) {
    const accept = (playerResponse) => {
      const cat = categoryFromPlayerResponse(playerResponse);
      if (!cat) return '';
      if (expectedVideoId
          && videoIdFromPlayerResponse(playerResponse) !== expectedVideoId) {
        return '';
      }
      return cat;
    };

    try {
      const direct = accept(window.ytInitialPlayerResponse);
      if (direct) return direct;
    } catch (_e) { /* isolated world usually cannot see page globals */ }

    const markers = ['ytInitialPlayerResponse =', 'ytInitialPlayerResponse='];
    for (const script of document.scripts) {
      const text = script.textContent || '';
      if (!text.includes('ytInitialPlayerResponse')) continue;
      for (const marker of markers) {
        const idx = text.indexOf(marker);
        if (idx === -1) continue;
        const json = extractBalancedJson(text, idx + marker.length);
        if (!json) continue;
        try {
          const parsed = JSON.parse(json);
          const cat = accept(parsed);
          if (cat) return cat;
        } catch (_e) { /* try the next script */ }
      }
    }
    return '';
  }

  function parseIso8601Duration(text) {
    if (!text) return null;
    const m = String(text).trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
    if (!m) return null;
    const days = Number(m[1] || 0);
    const hours = Number(m[2] || 0);
    const minutes = Number(m[3] || 0);
    const seconds = Number(m[4] || 0);
    const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    return total > 0 ? total : null;
  }

  // expectedVideoId gates the ytInitialPlayerResponse path against SPA-stale
  // scripts (see getInitialPlayerResponseDurationSec / H1 sibling id:8v48). The
  // meta / <video> / seekbar fallbacks read the live DOM/player, so they stay
  // unguarded — the caller only invokes this once watchMetadataMatches(videoId)
  // is true, so the current-DOM sources already reflect the right video.
  function getCurrentVideoDurationSec(expectedVideoId) {
    const fromPlayer = getInitialPlayerResponseDurationSec(expectedVideoId);
    if (fromPlayer != null) return fromPlayer;
    const meta = document.querySelector('meta[itemprop="duration"]');
    const fromMeta = parseIso8601Duration(meta ? meta.content : '');
    if (fromMeta != null) return fromMeta;
    const video = document.querySelector('video');
    if (video) {
      // ライブ配信は video.duration が Infinity になる。Number.isFinite で弾く前に
      // 判定する必要がある（L1: review 2026-05-12）。
      if (video.duration === Infinity) return -1;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        return Math.round(video.duration);
      }
    }
    const durationEl = document.querySelector('.ytp-time-duration');
    return parseDurationText(durationEl ? durationEl.textContent : '');
  }

  // Verify the watch-metadata DOM currently reflects the given videoId.
  // Returns true if we can confirm the match, false if uncertain.
  function watchMetadataMatches(videoId) {
    if (!videoId) return false;
    const root = document.querySelector('ytd-watch-metadata');
    if (!root) return false;
    // The title link points to /watch?v=<id>
    const link = root.querySelector('a[href*="/watch?v="]');
    if (link) {
      const id = getVideoIdFromHref(link.href);
      if (id) return id === videoId;
    }
    return false;
  }

  // Poll ytd-watch-metadata until it matches the given videoId, then
  // backfill title/channel. Falls back to oEmbed (via background) after
  // timeout so we never leave an entry with empty fields.
  function backfillTitleChannel(videoId) {
    if (DBClient.contextInvalidated) return;
    if (!videoId) return;
    const deadline = Date.now() + 12000; // 12s window
    const INTERVAL = 500;

    const tick = () => {
      if (watchMetadataMatches(videoId)) {
        const title = getWatchPageTitle();
        const channel = getWatchPageChannel();
        if (title || channel) {
          DBClient.updateTitleAndChannel(videoId, title, channel).catch((e) => {
            if (!e.contextInvalidated) console.error('[YT-Watched-Hider] Error updating video metadata:', videoId, e);
          });
          return;
        }
      }
      if (Date.now() < deadline) {
        setTimeout(tick, INTERVAL);
      } else {
        // Last resort: ask background to fetch via oEmbed.
        try {
          sendRuntimeMessage({
            type: 'FIX_CHANNELS',
            videoIds: [videoId],
            force: false
          }, () => { /* ignore */ });
        } catch (_e) { /* ignore */ }
      }
    };
    tick();
  }

  // Record current video as watched (source: 'self')
  // §8.4 (H1): boundVideoId lets the caller pin the videoId captured when the
  // <video> ended-listener was attached (playback start), instead of re-reading
  // location.href at fire time. Without this, a fast SPA autoplay transition
  // between "ended" firing and this function running could already have moved
  // the URL to the NEXT video, silently recording the wrong one as watched.
  async function recordCurrentVideo(boundVideoId) {
    if (DBClient.contextInvalidated) return;
    if (!enabled && !recordWhileOff) return;

    const videoId = boundVideoId || getCurrentVideoId();
    if (!videoId) return;

    try {
      // Guard against SPA race: on autoplay, URL may already point to the
      // next video while ytd-watch-metadata still shows the previous one
      // (or vice versa). Only trust title/channel if the DOM agrees with
      // the URL's videoId. Otherwise save id only and schedule a backfill.
      const domAgrees = watchMetadataMatches(videoId);
      const title = domAgrees ? getWatchPageTitle() : '';
      const channel = domAgrees ? getWatchPageChannel() : '';
      // Pass videoId so a stale ytInitialPlayerResponse (SPA leftover) can't
      // attach the previous video's duration (H1 sibling / id:8v48).
      const durationSec = domAgrees ? getCurrentVideoDurationSec(videoId) : null;
      // category is only reliable on the watch page; seekbar-card paths omit it.
      // Pass videoId so a stale ytInitialPlayerResponse (SPA leftover) can't
      // attach the previous video's category (H1).
      const category = domAgrees ? getCurrentVideoCategory(videoId) : '';
      await DBClient.addWatched(videoId, title, 'self', channel, durationSec, category);
      rememberWatched(videoId);
      console.log(`[YT-Watched-Hider] Recorded: ${title || videoId}${domAgrees ? '' : ' (id only, scheduling backfill)'}`);

      if (!domAgrees || !title || !channel) {
        backfillTitleChannel(videoId);
      }
    } catch (e) {
      if (!e.contextInvalidated) console.error('[YT-Watched-Hider] Error recording video:', e);
    }
  }

  // Attach ended listener to the <video> element
  let videoRetryCount = 0;
  const VIDEO_RETRY_MAX = 10;

  function attachVideoEndedListener() {
    if (DBClient.contextInvalidated) return;
    // Clean up previous listener
    if (currentVideoElement && endedHandler) {
      currentVideoElement.removeEventListener('ended', endedHandler);
      currentVideoElement = null;
      endedHandler = null;
    }

    const video = document.querySelector('video');
    if (!video) {
      if (videoRetryCount < VIDEO_RETRY_MAX) {
        videoRetryCount++;
        setTimeout(attachVideoEndedListener, 1000);
      }
      return;
    }
    videoRetryCount = 0;

    currentVideoElement = video;
    // §8.4 (H1): bind the videoId NOW (at listener-attach / playback-start time),
    // not when 'ended' fires. On a fast SPA autoplay transition, the URL can
    // already point at the NEXT video by the time 'ended' fires for this one —
    // reading getCurrentVideoId() inside the handler would then record the wrong
    // video. The bound id is passed through so recordCurrentVideo always records
    // the video this listener was actually attached to.
    const boundVideoId = getCurrentVideoId();
    endedHandler = () => {
      recordCurrentVideo(boundVideoId);
    };

    video.addEventListener('ended', endedHandler);

    // Also update title/channel in DB if we already have the record (from seekbar detection).
    // Use the robust polling backfill (handles slow DOM + oEmbed fallback).
    setTimeout(() => {
      const videoId = getCurrentVideoId();
      if (videoId) backfillTitleChannel(videoId);
    }, 1500);
  }

  // Find the card element for a given video ID
  function findCardByVideoId(videoId) {
    const cards = document.querySelectorAll(ALL_CARD_SELECTORS);
    for (const card of cards) {
      const link = card.querySelector(SELECTORS.videoLink);
      if (link && getVideoIdFromHref(link.href) === videoId) return card;
    }
    return null;
  }

  // Process all visible video cards (with queue to avoid lost updates)
  async function processPage() {
    if (DBClient.contextInvalidated) return;
    if (!enabled) return;
    if (processRunning) {
      processQueued = true; // will re-run after current finishes
      return;
    }
    processRunning = true;
    processQueued = false;

    try {
      // Hide Shorts and Movies first (independent of watched state)
      hideShortsCards();
      hideMovieCards();

      const cards = document.querySelectorAll(ALL_CARD_SELECTORS);
      if (cards.length === 0) {
        processRunning = false;
        return;
      }

      let hiddenBySeekbar = 0;
      let hiddenByCache = 0;
      let hiddenByDb = 0;

      // Collect video IDs from cards
      const cardMap = new Map(); // videoId -> [card elements]
      for (const card of cards) {
        // Skip playlist/mix cards — they contain /watch?v= links but are not single videos
        if (isPlaylistCard(card)) continue;

        const link = card.querySelector(SELECTORS.videoLink);
        if (!link) continue;

        const videoId = getVideoIdFromHref(link.href);
        if (!videoId) continue;

        if (card.dataset.watchedHidden === 'true') {
          if (card.dataset.watchedVideoId === videoId) continue;
          card.style.display = '';
          delete card.dataset.watchedHidden;
          delete card.dataset.watchedVideoId;
        }

        if (card.dataset.watchedCheckedId) {
          if (card.dataset.watchedCheckedId === videoId) continue;
          delete card.dataset.watchedCheckedId;
        }

        // Don't hide the currently playing video's card
        if (videoId === getCurrentVideoId()) continue;

        // Check YouTube seekbar first (no DB needed)
        if (hasYouTubeSeekbar(card)) {
          const title = getTitleFromCard(card);
          const channel = getChannelFromCard(card);
          const durationSec = getDurationFromCard(card);
          recordSeekbarWatched(card, videoId, title, channel, durationSec);
          // If we couldn't extract title or channel from the card (some
          // layout variants expose neither), schedule an oEmbed backfill
          // so the entry doesn't stay blank forever.
          if (!title || !channel) {
            try {
              sendRuntimeMessage({
                type: 'FIX_CHANNELS',
                videoIds: [videoId],
                force: false
              }, () => { /* ignore */ });
            } catch (_e) { /* ignore */ }
          }
          hiddenBySeekbar++;
          continue;
        }

        // Check positive/full/recent cache first (fast path)
        const cached = getCachedWatchedState(videoId);
        if (cached === true) {
          hideCard(card, videoId);
          hiddenByCache++;
          continue;
        }
        if (cached === false) {
          card.dataset.watchedCheckedId = videoId;
          continue;
        }

        if (!cardMap.has(videoId)) {
          cardMap.set(videoId, []);
        }
        cardMap.get(videoId).push(card);
      }

      // Batch check remaining IDs against IndexedDB (only uncached ones)
      const videoIds = Array.from(cardMap.keys());
      if (videoIds.length > 0) {
        const results = await lookupWatchedForIds(videoIds);
        for (const [videoId, isWatched] of Object.entries(results)) {
          const matchingCards = cardMap.get(videoId) || [];
          if (isWatched === true) {
            rememberWatched(videoId);
            for (const card of matchingCards) {
              hideCard(card, videoId);
              hiddenByDb++;
            }
          } else if (isWatched === false) {
            rememberNotWatched(videoId);
            // Mark as checked with the specific videoId so sidebar polling skips these
            for (const card of matchingCards) {
              card.dataset.watchedCheckedId = videoId;
            }
          }
          // isWatched === undefined (§8.3 H1): DB lookup failed / indeterminate.
          // Leave the card untouched — not hidden, not marked checked — so it
          // is retried on the next processPage() pass instead of being cached
          // as a false "not watched".
        }
      }

      const totalHidden = hiddenBySeekbar + hiddenByCache + hiddenByDb;
      if (totalHidden > 0) {
        console.log(`[YT-Watched-Hider] Hidden ${totalHidden} videos (seekbar: ${hiddenBySeekbar}, cache: ${hiddenByCache}, db: ${hiddenByDb})`);
      }
    } catch (e) {
      if (!e.contextInvalidated) console.error('[YT-Watched-Hider] Error processing page:', e);
    }

    processRunning = false;
    // If another processPage() was requested while we were running, do it now
    if (processQueued) {
      processQueued = false;
      processPage();
    }
  }

  function hideCard(card, videoId) {
    card.style.display = 'none';
    card.dataset.watchedHidden = 'true';
    card.dataset.watchedVideoId = videoId;
  }

  function showAllCards() {
    const hidden = document.querySelectorAll('[data-watched-hidden="true"]');
    for (const card of hidden) {
      card.style.display = '';
      delete card.dataset.watchedHidden;
      delete card.dataset.watchedVideoId;
    }
    const checked = document.querySelectorAll('[data-watched-checked-id]');
    for (const card of checked) {
      delete card.dataset.watchedCheckedId;
    }
  }

  function showCardsForVideoIds(videoIds) {
    const ids = new Set((videoIds || []).filter(Boolean));
    if (ids.size === 0) return;
    const hidden = document.querySelectorAll('[data-watched-hidden="true"]');
    for (const card of hidden) {
      if (!ids.has(card.dataset.watchedVideoId)) continue;
      card.style.display = '';
      delete card.dataset.watchedHidden;
      delete card.dataset.watchedVideoId;
    }
    const checked = document.querySelectorAll('[data-watched-checked-id]');
    for (const card of checked) {
      if (ids.has(card.dataset.watchedCheckedId)) delete card.dataset.watchedCheckedId;
    }
  }

  // --- Shorts hiding ---

  function isCardShorts(card) {
    // Method 1: card contains a /shorts/ link
    if (card.querySelector(SHORTS_SELECTORS.shortsLink)) return true;

    // Method 2: badge text says "ショート" (sidebar uses /watch links for Shorts)
    const badges = card.querySelectorAll('badge-shape');
    for (const badge of badges) {
      const text = badge.textContent.trim();
      if (text === 'ショート' || text === 'SHORTS' || text === 'Shorts') return true;
    }

    // Method 3: overlay-style="SHORTS" attribute
    if (card.querySelector('[overlay-style="SHORTS"]')) return true;

    return false;
  }

  function hideShortsCards() {
    if (!hideShorts) return;

    // Hide Shorts shelves (entire row)
    const reelShelves = document.querySelectorAll(SHORTS_SELECTORS.reelShelf);
    for (const shelf of reelShelves) {
      if (shelf.dataset.shortsHidden !== 'true') {
        shelf.style.display = 'none';
        shelf.dataset.shortsHidden = 'true';
      }
    }

    // Hide rich shelves that contain Shorts
    const richShelves = document.querySelectorAll(SHORTS_SELECTORS.richShelf);
    for (const shelf of richShelves) {
      if (shelf.dataset.shortsHidden === 'true') continue;
      if (shelf.querySelector(SHORTS_SELECTORS.shortsLink) || shelf.querySelector('[overlay-style="SHORTS"]')) {
        shelf.style.display = 'none';
        shelf.dataset.shortsHidden = 'true';
      }
    }

    // Hide individual cards that link to Shorts
    const cards = document.querySelectorAll(ALL_CARD_SELECTORS);
    for (const card of cards) {
      if (card.dataset.shortsHidden === 'true') continue;
      if (isCardShorts(card)) {
        card.style.display = 'none';
        card.dataset.shortsHidden = 'true';
      }
    }
  }

  function showAllShorts() {
    const hidden = document.querySelectorAll('[data-shorts-hidden="true"]');
    for (const el of hidden) {
      el.style.display = '';
      delete el.dataset.shortsHidden;
    }
  }

  // --- Movie/Show hiding ---

  // Rating badges that indicate movie/show content
  const MOVIE_RATING_BADGES = new Set(['G', 'PG', 'PG-12', 'PG12', 'R', 'R-15', 'R15', 'R-18', 'R18', 'NC-17']);

  function isCardMovie(card) {
    const badges = card.querySelectorAll('badge-shape');
    let hasRating = false;
    let hasFreeOrPaid = false;
    for (const badge of badges) {
      const text = badge.textContent.trim();
      if (MOVIE_RATING_BADGES.has(text)) hasRating = true;
      if (text === '無料' || text === 'Free' || text === '有料') hasFreeOrPaid = true;
    }
    // Must have rating OR "無料/有料" badge (movies always have at least one)
    return hasRating || hasFreeOrPaid;
  }

  function hideMovieCards() {
    if (!hideMovies) return;

    const cards = document.querySelectorAll(ALL_CARD_SELECTORS);
    for (const card of cards) {
      if (card.dataset.movieHidden === 'true') continue;
      if (isCardMovie(card)) {
        card.style.display = 'none';
        card.dataset.movieHidden = 'true';
      }
    }
  }

  function showAllMovies() {
    const hidden = document.querySelectorAll('[data-movie-hidden="true"]');
    for (const el of hidden) {
      el.style.display = '';
      delete el.dataset.movieHidden;
    }
  }

  // --- History page scraping ---
  const HISTORY_CARD_SELECTOR = 'yt-lockup-view-model, ytd-video-renderer';

  // §8.5 (H1): per-card scrape state. The old boolean `historyScraped` flag
  // marked a card "done" the instant it was first looked at — even before its
  // video link/videoId had rendered or its progress bar had drawn. Once set,
  // the card was skipped forever (and, in harvest mode with removeProcessed,
  // removed from the DOM outright), so a card that only revealed its videoId
  // or reached >=95% progress on a LATER render pass was never re-checked.
  // `completed` is now only set once a videoId AND its watched-completion
  // state are both positively confirmed; every other state is retried on the
  // next scrapeHistoryPage() call instead of being written off after one look.
  const HISTORY_STATE = {
    UNKNOWN: 'unknown',     // no video link / videoId resolvable yet
    PARTIAL: 'partial',     // videoId confirmed but progress < 95% (or bar not drawn yet)
    COMPLETED: 'completed', // confirmed watched (>=95%) and registered/verified in DB
    FAILED: 'failed',       // DB check/import failed this pass — retry next pass
    // §8.5 (🟡1, reviewer): terminal "gave up" state. NEVER implies watched —
    // it only stops further re-examination/removal bookkeeping once a card has
    // been retried HISTORY_RETRY_LIMIT times without becoming COMPLETED. This
    // is what re-bounds the DOM in harvest mode (see HISTORY_RETRY_LIMIT).
    EXHAUSTED: 'exhausted',
  };

  // §8.5 (🟡1, reviewer): K = consecutive re-examine passes a card may stay
  // UNKNOWN/PARTIAL/FAILED before being marked EXHAUSTED (and, in harvest mode,
  // pruned from the DOM). Without this cap, removeProcessed only ever prunes
  // COMPLETED cards, so a page with many genuinely <95%-watched entries (which
  // are correctly PARTIAL forever — that fact never changes) would accumulate
  // in the DOM without bound across a long harvest scroll, risking memory
  // growth / tab slowdown. Picked from the middle of the reviewer-suggested
  // 3-5 range: harvestTick re-scrapes on a ~1.3s cadence (900ms render-settle
  // wait + a 400ms retry timer), so K=4 gives an UNKNOWN/PARTIAL card ~4
  // passes (~4-5s) to resolve once its videoId/progress bar actually renders —
  // comfortably more than the typical 1-2 passes that takes — while still
  // capping worst-case DOM growth per still-unresolved card to a small,
  // constant number of retries instead of "forever".
  const HISTORY_RETRY_LIMIT = 4;

  // Pure state-transition helper (no DOM/chrome deps) so it can be unit-tested
  // directly: given the card's current historyRetries dataset value (a string,
  // or undefined/NaN for a card seen for the first time this pass), returns the
  // next retry count and whether this card has now exhausted its retries.
  function computeHistoryRetryOutcome(currentRetriesRaw) {
    const retries = (parseInt(currentRetriesRaw, 10) || 0) + 1;
    return { retries, exhausted: retries >= HISTORY_RETRY_LIMIT };
  }

  function getHistoryTitle(card) {
    const el = card.querySelector('h3, #video-title, yt-formatted-string#video-title');
    return el ? el.textContent.trim() : getTitleFromCard(card);
  }

  function getHistoryChannel(card) {
    const el = card.querySelector(
      '.yt-content-metadata-view-model-wiz__metadata-text, ' +
      'ytd-channel-name yt-formatted-string a, ' +
      'ytd-channel-name yt-formatted-string'
    );
    return el ? el.textContent.trim() : getChannelFromCard(card);
  }

  // Extract date from the nearest history section header (e.g. "今日", "昨日", "4月14日")
  function getHistorySectionDate(card) {
    // Walk up to find the section renderer, then look for the header
    const section = card.closest('ytd-item-section-renderer');
    if (!section) return null;
    const header = section.querySelector('#title, .ytd-item-section-header-renderer');
    if (!header) return null;
    const text = header.textContent.trim();
    if (!text) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // "今日" / "Today"
    if (/^今日$/i.test(text) || /^today$/i.test(text)) return today.getTime();
    // "昨日" / "Yesterday"
    if (/^昨日$/i.test(text) || /^yesterday$/i.test(text)) return today.getTime() - 86400000;

    // "4月14日" pattern (Japanese)
    const jaMatch = text.match(/(\d{1,2})月(\d{1,2})日/);
    if (jaMatch) {
      const m = parseInt(jaMatch[1], 10) - 1;
      const d = parseInt(jaMatch[2], 10);
      let year = now.getFullYear();
      const candidate = new Date(year, m, d);
      if (candidate > now) year--;
      return new Date(year, m, d).getTime();
    }

    // "Apr 14" / "April 14" pattern (English)
    const enMatch = text.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
    if (enMatch) {
      const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
      const mKey = enMatch[1].slice(0, 3).toLowerCase();
      if (mKey in months) {
        const m = months[mKey];
        const d = parseInt(enMatch[2], 10);
        let year = now.getFullYear();
        const candidate = new Date(year, m, d);
        if (candidate > now) year--;
        return new Date(year, m, d).getTime();
      }
    }

    return null;
  }

  function getHistoryVideoLink(card) {
    return card.querySelector('a[href*="watch"], a[href*="/watch?v="]');
  }

  // Check if a history card's video was watched to completion (>= 95%)
  function isHistoryCardCompleted(card) {
    // Old UI: resume playback overlay
    if (card.querySelector(SELECTORS.resumeOverlay)) return true;

    // Old UI: #progress element with width
    const progress = card.querySelector(SELECTORS.seekbar);
    if (progress && progress.style && parseFloat(progress.style.width) >= WATCHED_THRESHOLD) return true;

    // New UI: progress bar segment with width percentage
    const segment = card.querySelector(SELECTORS.progressBarNew);
    if (segment && segment.style && parseFloat(segment.style.width) >= WATCHED_THRESHOLD) return true;

    return false;
  }

  async function scrapeHistoryPage(options = {}) {
    if (DBClient.contextInvalidated) return { added: 0, scanned: 0 };
    const { removeProcessed = false } = options;
    const cards = document.querySelectorAll(HISTORY_CARD_SELECTOR);
    console.log(`[YT-Watched-Hider] History scrape: found ${cards.length} cards`);

    const candidates = []; // { card, videoId } — confirmed >=95%, awaiting DB check
    let newlySeen = 0; // cards examined for the first time this pass (harvest stall detection)

    for (const card of cards) {
      const state = card.dataset.historyState;
      // COMPLETED: resolved, nothing left to do. EXHAUSTED (§8.5 🟡1): gave up
      // after HISTORY_RETRY_LIMIT retries — never implies watched, just stops
      // re-examining a card that has had ample chances to resolve.
      if (state === HISTORY_STATE.COMPLETED || state === HISTORY_STATE.EXHAUSTED) continue;

      if (!state) newlySeen++;

      const link = getHistoryVideoLink(card);
      if (!link) {
        // Link not rendered yet — leave UNKNOWN so a later pass re-checks it,
        // instead of writing the card off permanently.
        card.dataset.historyState = HISTORY_STATE.UNKNOWN;
        continue;
      }

      const videoId = getVideoIdFromHref(link.href);
      if (!videoId) {
        card.dataset.historyState = HISTORY_STATE.UNKNOWN;
        continue;
      }

      // Skip partially watched videos — only register >= 95% progress. A false
      // here can mean "genuinely watched <95%" OR "progress bar hasn't drawn
      // yet"; either way we don't yet have grounds to call it completed, so it
      // stays retriable rather than being written off after one look.
      if (!isHistoryCardCompleted(card)) {
        card.dataset.historyState = HISTORY_STATE.PARTIAL;
        continue;
      }

      candidates.push({ card, videoId });
    }
    console.log(`[YT-Watched-Hider] Candidates: ${candidates.length}`);

    let added = 0;
    const completedThisPass = [];
    if (candidates.length > 0) {
      const videoIds = candidates.map(c => c.videoId);
      let existing = null;
      try {
        existing = await DBClient.checkMultiple(videoIds);
      } catch (e) {
        if (e.contextInvalidated) return { added: 0, scanned: newlySeen };
        console.error('[YT-Watched-Hider] History checkMultiple failed:', e);
        // Confirmation-unable — do not mark completed, retry these next pass.
        for (const { card } of candidates) card.dataset.historyState = HISTORY_STATE.FAILED;
      }

      if (existing) {
        const newEntries = []; // { card, videoId, record }
        for (const { card, videoId } of candidates) {
          if (existing[videoId]) {
            card.dataset.historyState = HISTORY_STATE.COMPLETED;
            completedThisPass.push(card);
            continue;
          }

          const title = getHistoryTitle(card);
          const channel = getHistoryChannel(card);
          const sectionDate = getHistorySectionDate(card) || Date.now();
          newEntries.push({
            card,
            videoId,
            record: {
              videoId,
              title,
              channel: channel || '',
              watchedAt: sectionDate,
              firstWatchedAt: sectionDate,
              playCount: 0,
              source: 'history',
            },
          });
        }

        if (newEntries.length > 0) {
          try {
            await DBClient.importData(newEntries.map((e) => e.record));
            for (const { card, videoId } of newEntries) {
              rememberWatched(videoId);
              card.dataset.historyState = HISTORY_STATE.COMPLETED;
              completedThisPass.push(card);
            }
            showImportToast(newEntries.length);
            added = newEntries.length;
            console.log(`[YT-Watched-Hider] Imported ${added} new videos from history`);
          } catch (e) {
            if (e.contextInvalidated) return { added: 0, scanned: newlySeen };
            console.error('[YT-Watched-Hider] History batch import failed:', e);
            // Import unconfirmed — leave retriable rather than assuming completed.
            for (const { card } of newEntries) card.dataset.historyState = HISTORY_STATE.FAILED;
          }
        }
      }
    }

    // §8.5 (🟡1, reviewer): bound the DOM by retiring cards that have been
    // examined HISTORY_RETRY_LIMIT times without becoming COMPLETED. Only
    // cards actually touched this pass (state set above, or left over as
    // FAILED from a prior DB error) are counted — COMPLETED/EXHAUSTED cards
    // were already skipped by the `continue` above and are untouched here.
    const exhaustedThisPass = [];
    for (const card of cards) {
      const state = card.dataset.historyState;
      if (state === HISTORY_STATE.COMPLETED || state === HISTORY_STATE.EXHAUSTED) continue;
      if (!state) continue; // not examined at all this pass (defensive; shouldn't happen)

      const outcome = computeHistoryRetryOutcome(card.dataset.historyRetries);
      if (outcome.exhausted) {
        card.dataset.historyState = HISTORY_STATE.EXHAUSTED;
        delete card.dataset.historyRetries;
        exhaustedThisPass.push(card);
      } else {
        card.dataset.historyRetries = String(outcome.retries);
      }
    }

    // Prune cards that reached a terminal state this pass: COMPLETED (resolved
    // watched) or EXHAUSTED (gave up after HISTORY_RETRY_LIMIT retries, §8.5
    // 🟡1 DOM-boundedness fix). Anything still UNKNOWN/PARTIAL/FAILED stays in
    // the DOM so the next scrapeHistoryPage() call (mutation observer /
    // harvest tick / SPA nav) can re-examine it.
    if (removeProcessed) {
      for (const card of completedThisPass) card.remove();
      for (const card of exhaustedThisPass) card.remove();
    }

    return { added, scanned: newlySeen };
  }

  // ---- History Harvest ----

  function injectHarvestStyle() {
    if (harvest.styleEl) return;
    const s = document.createElement('style');
    s.id = '__yt_watched_hider_harvest_style';
    // Hide thumbnail images but keep the red progress bar (used for 95% detection)
    s.textContent = `
      ytd-browse[page-subtype="history"] ytd-thumbnail img,
      ytd-browse[page-subtype="history"] yt-image img,
      ytd-browse[page-subtype="history"] img.yt-core-image,
      ytd-browse[page-subtype="history"] yt-lockup-view-model img { visibility: hidden !important; }
    `;
    document.head.appendChild(s);
    harvest.styleEl = s;
  }

  function removeHarvestStyle() {
    if (harvest.styleEl) { harvest.styleEl.remove(); harvest.styleEl = null; }
  }

  function renderHarvestStatus() {
    if (!harvest.ui) return;
    const btn = harvest.ui.querySelector('.yt-hv-btn');
    const stat = harvest.ui.querySelector('.yt-hv-stat');
    const dot = harvest.ui.querySelector('.yt-hv-dot');
    const banner = harvest.ui.querySelector('.yt-hv-banner');
    btn.textContent = harvest.running ? '■ Stop' : '▶ Start Harvest';
    btn.style.background = harvest.running ? '#d32f2f' : '#1a73e8';
    dot.style.background = harvest.running ? '#ff5252' : '#666';
    dot.style.animation = harvest.running ? 'ythvPulse 1s infinite' : 'none';

    if (harvest.running) {
      const streakHint = harvest.noNewStreak > 0 ? ` · idle ${harvest.noNewStreak}/6` : '';
      stat.textContent = `Running · +${harvest.added} / ${harvest.scanned}${streakHint}`;
      banner.style.display = 'none';
    } else if (harvest.scanned > 0) {
      stat.textContent = `+${harvest.added} / ${harvest.scanned}`;
      banner.textContent = harvest.endReason === 'auto'
        ? `✅ 完了（履歴末尾） 取込 +${harvest.added} / 走査 ${harvest.scanned}`
        : `⏸ 停止 取込 +${harvest.added} / 走査 ${harvest.scanned}`;
      banner.style.background = harvest.endReason === 'auto' ? '#2e7d32' : '#616161';
      banner.style.display = 'block';
    } else {
      stat.textContent = 'Idle';
      banner.style.display = 'none';
    }
  }

  function ensureHarvestUI() {
    if (harvest.ui || !isHistoryPage() || !harvestMode) return;
    if (!document.getElementById('__yt_watched_hider_harvest_anim')) {
      const anim = document.createElement('style');
      anim.id = '__yt_watched_hider_harvest_anim';
      anim.textContent = '@keyframes ythvPulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }';
      document.head.appendChild(anim);
    }
    const wrap = document.createElement('div');
    wrap.id = '__yt_watched_hider_harvest';
    wrap.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;background:#212121;color:#fff;padding:10px 12px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);font:12px/1.4 Roboto,sans-serif;display:flex;flex-direction:column;gap:6px;min-width:220px;';
    wrap.innerHTML = `
      <div style="font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="yt-hv-dot" style="width:8px;height:8px;border-radius:50%;background:#666;display:inline-block;"></span>
          YT Harvest
        </span>
        <span class="yt-hv-stat" style="font-weight:400;opacity:0.85;"></span>
      </div>
      <button class="yt-hv-btn" style="background:#1a73e8;color:#fff;border:0;padding:6px 10px;border-radius:4px;cursor:pointer;font-size:12px;"></button>
      <div class="yt-hv-banner" style="display:none;padding:6px 8px;border-radius:4px;font-size:11px;font-weight:600;text-align:center;"></div>
      <div style="font-size:10px;opacity:0.6;">サムネ非表示＋自動スクロール＋DOM間引き</div>
    `;
    document.body.appendChild(wrap);
    harvest.ui = wrap;
    wrap.querySelector('.yt-hv-btn').addEventListener('click', () => {
      if (harvest.running) stopHarvest('user'); else startHarvest();
    });
    renderHarvestStatus();
  }

  function removeHarvestUI() {
    stopHarvest();
    if (harvest.ui) { harvest.ui.remove(); harvest.ui = null; }
    removeHarvestStyle();
  }

  function startHarvest() {
    if (contextInvalidated) return;
    if (harvest.running || !isHistoryPage()) return;
    harvest.running = true;
    harvest.added = 0;
    harvest.scanned = 0;
    harvest.noNewStreak = 0;
    harvest.endReason = null;
    injectHarvestStyle();
    renderHarvestStatus();
    harvestTick();
  }

  function stopHarvest(reason = 'user') {
    if (!harvest.running && !harvest.timer) {
      // Already stopped — only clean up style/UI
      removeHarvestStyle();
      renderHarvestStatus();
      return;
    }
    harvest.running = false;
    harvest.endReason = reason;
    if (harvest.timer) { clearTimeout(harvest.timer); harvest.timer = null; }
    removeHarvestStyle();
    renderHarvestStatus();
  }

  async function harvestTick() {
    if (!harvest.running) return;

    // Scroll to bottom to trigger YouTube's infinite scroll
    window.scrollTo(0, document.documentElement.scrollHeight);

    // Wait for new cards to render
    await new Promise(r => setTimeout(r, 900));
    if (!harvest.running) return;

    const { added, scanned } = await scrapeHistoryPage({ removeProcessed: true });
    if (!harvest.running) return;
    harvest.added += added;
    harvest.scanned += scanned;
    if (scanned === 0) {
      harvest.noNewStreak++;
    } else {
      harvest.noNewStreak = 0;
    }
    renderHarvestStatus();

    // Stop after 6 consecutive empty iterations (~10s of no new content)
    if (harvest.noNewStreak >= 6) {
      console.log('[YT-Watched-Hider] Harvest: no new content, stopping');
      stopHarvest('auto');
      return;
    }

    harvest.timer = setTimeout(harvestTick, 400);
  }

  function isHistoryPage() {
    return location.pathname === '/feed/history';
  }

  // Observe DOM mutations for dynamically loaded content
  const SHORTS_SHELF_SELECTORS = `${SHORTS_SELECTORS.reelShelf}, ${SHORTS_SELECTORS.richShelf}`;

  const observer = new MutationObserver((mutations) => {
    if (contextInvalidated) return;
    let hasRelevantChange = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches?.(ALL_CARD_SELECTORS) || node.querySelector?.(ALL_CARD_SELECTORS) ||
              node.matches?.(HISTORY_CARD_SELECTOR) || node.querySelector?.(HISTORY_CARD_SELECTOR) ||
              node.matches?.(SHORTS_SHELF_SELECTORS) || node.querySelector?.(SHORTS_SHELF_SELECTORS)) {
            hasRelevantChange = true;
            break;
          }
        }
      }
      if (hasRelevantChange) break;
    }

    if (hasRelevantChange) {
      clearTimeout(observer._debounceTimer);
      if (isHistoryPage()) {
        observer._debounceTimer = setTimeout(scrapeHistoryPage, 300);
      } else if (enabled) {
        observer._debounceTimer = setTimeout(() => { processPage(); ensureQueueAllButton(); ensureWatchLaterButton(); }, 300);
      } else if (hideShorts || hideMovies) {
        // Even if main hiding is off, still hide Shorts/Movies if those settings are on
        observer._debounceTimer = setTimeout(() => { hideShortsCards(); hideMovieCards(); ensureQueueAllButton(); ensureWatchLaterButton(); }, 300);
      } else {
        observer._debounceTimer = setTimeout(() => { ensureQueueAllButton(); ensureWatchLaterButton(); }, 300);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Listen for YouTube SPA navigation
  function onNavigateFinish() {
    if (contextInvalidated) return;
    if (location.pathname === '/watch') {
      attachVideoEndedListener();
      startRecoPolling();
    } else {
      stopRecoPolling();
    }
    ensureQueueAllButton();
    ensureWatchLaterButton();
    // Reset flags on navigation (sidebar content changes)
    for (const card of document.querySelectorAll('[data-watched-hidden="true"]')) {
      card.style.display = '';
      delete card.dataset.watchedHidden;
      delete card.dataset.watchedVideoId;
    }
    for (const card of document.querySelectorAll('[data-watched-checked-id]')) {
      delete card.dataset.watchedCheckedId;
    }
    setTimeout(ensureQueueAllButton, 600);
    setTimeout(ensureWatchLaterButton, 600);
    if (isHistoryPage()) {
      setTimeout(scrapeHistoryPage, 500);
      if (harvestMode) setTimeout(ensureHarvestUI, 300);
    } else {
      removeHarvestUI();
      if (enabled) setTimeout(processPage, 500);
    }
  }

  document.addEventListener('yt-navigate-finish', onNavigateFinish);

  // Recommendation check: polls for video cards across the entire page.
  // Covers both normal sidebar (#secondary) AND theater mode (below player).
  // YouTube often reuses card DOM elements, changing href/content without
  // creating new nodes — MutationObserver misses this, so we poll.
  let recoInterval = null;
  let recoChecking = false;

  // Get the videoId from a card's link, returns null if not found
  function getCardVideoId(card) {
    const link = card.querySelector(SELECTORS.videoLink);
    return link ? getVideoIdFromHref(link.href) : null;
  }

  async function checkRecommendations() {
    if (DBClient.contextInvalidated) return;
    if (!enabled || location.pathname !== '/watch') return;
    if (document.hidden) return; // skip while tab is not visible
    if (recoChecking) return; // prevent overlap
    recoChecking = true;

    try {
      // Hide Shorts and Movies in recommendations too
      hideShortsCards();
      hideMovieCards();

      // Search entire document — covers sidebar, below-player (theater), end screen
      const cards = document.querySelectorAll(ALL_CARD_SELECTORS);
      if (cards.length === 0) return;

      const unchecked = [];
      const currentVid = getCurrentVideoId();

      for (const card of cards) {
        if (isPlaylistCard(card)) continue;

        const videoId = getCardVideoId(card);
        if (!videoId) continue;
        if (videoId === currentVid) continue;

        // Detect recycled DOM: if the card was hidden/checked for a DIFFERENT video,
        // reset it because YouTube reused this DOM element for new content
        if (card.dataset.watchedHidden === 'true') {
          if (card.dataset.watchedVideoId === videoId) continue; // still same video, stay hidden
          // DOM recycled — un-hide and re-check
          card.style.display = '';
          delete card.dataset.watchedHidden;
          delete card.dataset.watchedVideoId;
        }

        if (card.dataset.watchedCheckedId) {
          if (card.dataset.watchedCheckedId === videoId) continue; // already checked this exact video
          delete card.dataset.watchedCheckedId;
        }
        // Check YouTube seekbar first (hide immediately, no DB lookup needed)
        if (hasYouTubeSeekbar(card)) {
          const title = getTitleFromCard(card);
          const channel = getChannelFromCard(card);
          const durationSec = getDurationFromCard(card);
          recordSeekbarWatched(card, videoId, title, channel, durationSec);
          // If we couldn't extract title or channel from the card (some
          // layout variants expose neither), schedule an oEmbed backfill
          // so the entry doesn't stay blank forever.
          if (!title || !channel) {
            try {
              sendRuntimeMessage({
                type: 'FIX_CHANNELS',
                videoIds: [videoId],
                force: false
              }, () => { /* ignore */ });
            } catch (_e) { /* ignore */ }
          }
          continue;
        }

        // Check positive/full/recent cache (fast path, no DB access)
        const cached = getCachedWatchedState(videoId);
        if (cached === true) {
          hideCard(card, videoId);
          continue;
        }
        if (cached === false) {
          card.dataset.watchedCheckedId = videoId;
          continue;
        }

        unchecked.push({ card, videoId });
      }

      if (unchecked.length === 0) return;

      const ids = unchecked.map(c => c.videoId);
      const results = await lookupWatchedForIds(ids);
      for (const { card, videoId } of unchecked) {
        const isWatched = results[videoId];
        if (isWatched === true) {
          rememberWatched(videoId);
          hideCard(card, videoId);
        } else if (isWatched === false) {
          rememberNotWatched(videoId);
          // Store the checked videoId so we can detect recycling
          card.dataset.watchedCheckedId = videoId;
        }
        // isWatched === undefined (§8.3 H1): indeterminate (DB lookup failed) —
        // leave untouched so it's retried on the next recommendation poll
        // instead of being cached as a false "not watched".
      }
    } catch (e) {
      // DB error, will retry on next poll
    } finally {
      recoChecking = false;
    }
  }

  // Shared selector for related video cards on watch pages (Queue All / Watch Later)
  const RELATED_CARD_SELECTORS =
    '#related ytd-compact-video-renderer, ' +
    '#related yt-lockup-view-model, ' +
    'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer, ' +
    'ytd-watch-next-secondary-results-renderer yt-lockup-view-model';
  const CHANNEL_GRID_CARD_SELECTOR = 'ytd-rich-grid-renderer ytd-rich-item-renderer';
  const BULK_LARGE_COUNT_THRESHOLD = 50;

  function isChannelVideosPath() {
    const path = location.pathname.replace(/\/+$/, '');
    return /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/videos$/.test(path);
  }

  function isChannelVideosPage() {
    return isChannelVideosPath() && !!document.querySelector('ytd-rich-grid-renderer');
  }

  function getBulkPageContext() {
    if (location.pathname === '/watch') return 'watch';
    if (isChannelVideosPage()) return 'channel';
    return null;
  }

  function hasLiveBadge(card) {
    const liveBadge = card.querySelector(
      '.badge-style-type-live-now, ' +
      '[aria-label*="ライブ"], ' +
      '[aria-label*="LIVE"]'
    );
    if (liveBadge) return true;

    const badges = card.querySelectorAll('badge-shape, .badge-shape-wiz__text, .yt-badge-shape__text');
    for (const badge of badges) {
      const text = (badge.textContent || '').trim();
      if (/ライブ|live/i.test(text)) return true;
    }
    return false;
  }

  function isChannelBulkActionCard(card) {
    if (card.style.display === 'none') return false;
    if (card.offsetParent === null) return false;
    if (card.dataset.watchedHidden === 'true') return false;
    if (card.dataset.shortsHidden === 'true') return false;
    if (card.dataset.movieHidden === 'true') return false;
    if (isPlaylistCard(card)) return false;
    if (isCardShorts(card)) return false;
    if (hasLiveBadge(card)) return false;

    const link = card.querySelector('a[href*="/watch?v="]');
    if (!link) return false;
    return !!getVideoIdFromHref(link.href);
  }

  function findChannelBulkActionCards() {
    const cards = document.querySelectorAll(CHANNEL_GRID_CARD_SELECTOR);
    const out = [];
    for (const card of cards) {
      if (isChannelBulkActionCard(card)) out.push(card);
    }
    return out;
  }

  function buildBulkConfirmMessage(kind, count, context) {
    if (kind === 'queue') {
      if (context === 'watch') {
        return `${count}件の関連動画をキューに追加します。\n処理中YouTubeのメニューが順次開閉します。続行しますか？`;
      }
      let message = `${count}件の表示中動画をキューに追加します。\n処理中YouTubeのメニューが順次開閉します。続行しますか？`;
      if (count > BULK_LARGE_COUNT_THRESHOLD) {
        const minutes = Math.max(1, Math.ceil((count * 0.6) / 60));
        message += `\n\n件数が多いため、完了まで約${minutes}分以上かかる可能性があります。途中で中止する場合は処理中のボタンをクリックしてください。`;
      }
      return message;
    }

    if (context === 'watch') {
      return `${count}件の動画を「後で見る」に追加します。\nメニューが順次開閉します。続行しますか？`;
    }
    let message = `${count}件の表示中動画を「後で見る」に追加します。\nメニューが順次開閉します。続行しますか？`;
    if (count > BULK_LARGE_COUNT_THRESHOLD) {
      const minutes = Math.max(1, Math.ceil((count * 0.65) / 60));
      message += `\n\n件数が多いため、完了まで約${minutes}分以上かかる可能性があります。途中で中止する場合は処理中のボタンをクリックしてください。`;
    }
    return message;
  }

  // ===== Queue All feature =====
  // Adds a button on watch pages to bulk-enqueue all visible related videos.
  // Works by programmatically clicking each card's kebab menu, then "Add to queue".
  let queueAllBtn = null;
  let queueInProgress = false;
  let queueAbort = false;
  let queueBtnObserver = null;
  let queueButtonContext = null;
  let bulkButtonBar = null;

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function removeBulkButtonBarIfEmpty() {
    if (bulkButtonBar && (!bulkButtonBar.isConnected || bulkButtonBar.children.length === 0)) {
      bulkButtonBar.remove();
      bulkButtonBar = null;
    }
  }

  function removeQueueAllButton() {
    if (queueBtnObserver) { queueBtnObserver.disconnect(); queueBtnObserver = null; }
    if (queueAllBtn) { queueAllBtn.remove(); queueAllBtn = null; }
    queueButtonContext = null;
    removeBulkButtonBarIfEmpty();
  }

  function getBulkButtonStyle(kind, context) {
    const isQueue = kind === 'queue';
    const margin = context === 'channel' ? '0' : (isQueue ? '8px 12px 12px' : '8px 8px 12px 0');
    return [
      'display:inline-block',
      'box-sizing:border-box',
      `margin:${margin}`,
      'padding:8px 14px',
      `background:${isQueue ? '#ff4444' : '#1565c0'}`,
      'color:#fff',
      'border:none',
      'border-radius:18px',
      'cursor:pointer',
      'font-size:13px',
      'font-weight:500',
      'font-family:Roboto, Arial, sans-serif',
      'line-height:1.2',
      'width:auto',
      'height:auto',
      'max-height:40px',
      'min-height:32px',
      'max-width:calc(100% - 24px)',
      'flex:0 0 auto',
      'align-self:flex-start',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
      // YouTubeの関連動画/チャンネルグリッドが display:grid のときに
      // 0px のimplicit cellへ押し込まれて見えなくなるのを防ぐ。
      'grid-column:1 / -1'
    ].join(';') + ';';
  }

  function isChipBarHost(el) {
    return !!el && (el.tagName === 'CHIP-BAR-VIEW-MODEL' ||
      el.tagName === 'YTD-FEED-FILTER-CHIP-BAR-RENDERER');
  }

  function ensureChannelBulkButtonBar(anchor) {
    if (!anchor) return null;
    const chipMode = isChipBarHost(anchor);
    if (!bulkButtonBar || !document.body.contains(bulkButtonBar)) {
      bulkButtonBar = document.createElement('div');
      bulkButtonBar.id = 'yt-watched-hider-channel-bulk-bar';
    }
    // チップ行（新しい順/人気の動画/古い順）に置く場合は margin-left:auto で右端寄せ。
    // チップ行が見つからない場合はグリッド先頭カードの前に全幅バーとして挿入。
    bulkButtonBar.style.cssText = chipMode
      ? [
          'display:flex',
          'box-sizing:border-box',
          'gap:8px',
          'align-items:center',
          'flex-wrap:nowrap',
          'margin:0 0 0 auto',
          'padding:0',
          'width:auto',
          'flex:0 0 auto',
          'white-space:nowrap'
        ].join(';') + ';'
      : [
          'display:flex',
          'box-sizing:border-box',
          'gap:8px',
          'align-items:center',
          'flex-wrap:wrap',
          'margin:8px 12px 12px',
          'padding:0',
          'width:auto',
          'max-width:calc(100% - 24px)',
          'grid-column:1 / -1'
        ].join(';') + ';';

    if (chipMode) {
      // チップ行の最後の子として追加（margin-left:auto で右端へ寄る）
      if (bulkButtonBar.parentNode !== anchor || bulkButtonBar !== anchor.lastElementChild) {
        anchor.appendChild(bulkButtonBar);
      }
    } else {
      const parent = anchor.parentNode;
      if (!parent) return null;
      if (bulkButtonBar.parentNode !== parent || bulkButtonBar.nextSibling !== anchor) {
        parent.insertBefore(bulkButtonBar, anchor);
      }
    }
    return bulkButtonBar;
  }

  function insertBulkButton(button, context, anchor, kind) {
    if (context === 'channel') {
      const bar = ensureChannelBulkButtonBar(anchor);
      if (!bar) return false;
      if (kind === 'queue') {
        if (button.parentNode !== bar || button !== bar.firstElementChild) {
          bar.insertBefore(button, bar.firstChild);
        }
      } else if (button.parentNode !== bar || button.previousElementSibling !== queueAllBtn) {
        bar.appendChild(button);
      }
      return true;
    }

    if (!anchor || !anchor.parentNode) return false;
    anchor.parentNode.insertBefore(button, anchor);
    removeBulkButtonBarIfEmpty();
    return true;
  }

  function findQueueableCards(context = getBulkPageContext()) {
    if (context === 'channel') return findChannelBulkActionCards();
    if (context !== 'watch') return [];

    const cards = document.querySelectorAll(RELATED_CARD_SELECTORS);
    const out = [];
    for (const card of cards) {
      if (card.style.display === 'none') continue;
      // 関連サイドバーの先頭にある chip フィルター用などの 0x0 隠しセクション配下
      // のカードを除外（offsetParent===null で可視判定）
      if (card.offsetParent === null) continue;
      if (card.dataset.watchedHidden === 'true') continue;
      const link = card.querySelector('a[href*="/watch?v="]');
      if (!link) continue;
      // Skip Shorts
      if (card.querySelector('a[href*="/shorts/"]')) continue;
      // Skip Live
      const liveBadge = card.querySelector(
        '.badge-style-type-live-now, ' +
        '[aria-label*="ライブ"], ' +
        '[aria-label*="LIVE"]'
      );
      if (liveBadge) continue;
      out.push(card);
    }
    return out;
  }

  async function seedQueueWithCurrentVideo() {
    // Click the "..." button next to the current video (below the player).
    const moreBtn = document.querySelector(
      'ytd-watch-metadata #button-shape button[aria-label*="その他"], ' +
      'ytd-watch-metadata button[aria-label*="その他の操作"], ' +
      'ytd-menu-renderer.ytd-watch-metadata button[aria-label*="その他"], ' +
      'ytd-watch-metadata button[aria-label*="More actions"]'
    );
    if (!moreBtn) return { ok: false, reason: 'no-more-btn' };
    moreBtn.click();
    await sleep(200);

    let queueItem = null;
    for (let i = 0; i < 12; i++) {
      const candidates = document.querySelectorAll(
        'ytd-menu-popup-renderer ytd-menu-service-item-renderer, ' +
        'ytd-menu-popup-renderer tp-yt-paper-item, ' +
        'tp-yt-iron-dropdown ytd-menu-service-item-renderer, ' +
        'yt-list-item-view-model'
      );
      for (const c of candidates) {
        const text = (c.textContent || '').trim();
        if (text.includes('キューに追加') || text.toLowerCase().includes('add to queue')) {
          queueItem = c;
          break;
        }
      }
      if (queueItem) break;
      await sleep(80);
    }

    if (!queueItem) {
      document.body.click();
      return { ok: false, reason: 'no-queue-item' };
    }
    const clickTarget = queueItem.querySelector('button, [role="menuitem"], .yt-list-item-view-model-wiz__container') || queueItem;
    clickTarget.click();
    await sleep(200);
    return { ok: true };
  }

  async function queueOneCard(card) {
    const kebab = card.querySelector(
      'button[aria-label*="その他の操作"], ' +                 // new UI (yt-lockup-view-model)
      'button[aria-label*="More actions"], ' +                  // English new UI
      'ytd-menu-renderer yt-icon-button button, ' +             // old UI
      'ytd-menu-renderer button, ' +
      'button.yt-spec-button-shape-next[aria-label*="アクション"], ' +
      'button[aria-label*="アクション メニュー"], ' +
      'button[aria-label*="Action menu"]'
    );
    if (!kebab) return { ok: false, reason: 'no-kebab' };

    kebab.click();
    await sleep(180);

    // Poll for popup items
    let queueItem = null;
    for (let i = 0; i < 12; i++) {
      const candidates = document.querySelectorAll(
        'ytd-menu-popup-renderer ytd-menu-service-item-renderer, ' +
        'ytd-menu-popup-renderer tp-yt-paper-item, ' +
        'tp-yt-iron-dropdown ytd-menu-service-item-renderer, ' +
        'yt-list-item-view-model, ' +                              // new UI
        'yt-contextual-sheet-layout yt-list-item-view-model'
      );
      for (const c of candidates) {
        const text = (c.textContent || '').trim();
        if (text.includes('キューに追加') || text.toLowerCase().includes('add to queue')) {
          queueItem = c;
          break;
        }
      }
      if (queueItem) break;
      await sleep(80);
    }

    if (!queueItem) {
      // Close menu
      document.body.click();
      await sleep(100);
      return { ok: false, reason: 'no-queue-item' };
    }

    // For new UI, inner clickable is a button/div; click deepest clickable if present
    const clickTarget = queueItem.querySelector('button, [role="menuitem"], .yt-list-item-view-model-wiz__container') || queueItem;
    clickTarget.click();
    await sleep(180);
    return { ok: true };
  }

  function updateQueueButtonLabel() {
    if (!queueAllBtn || queueInProgress) return;
    const count = findQueueableCards(queueButtonContext || getBulkPageContext()).length;
    queueAllBtn.textContent = `⏭ キューに追加 (${count})`;
    queueAllBtn.disabled = count === 0;
    queueAllBtn.style.opacity = count === 0 ? '0.5' : '1';
  }

  async function onQueueAllClick() {
    if (queueInProgress) {
      queueAbort = true;
      if (queueAllBtn) queueAllBtn.textContent = '中止中...';
      return;
    }
    const context = getBulkPageContext();
    const cards = findQueueableCards(context);
    if (cards.length === 0) return;
    if (!confirm(buildBulkConfirmMessage('queue', cards.length, context))) return;

    queueInProgress = true;
    queueAbort = false;
    if (queueAllBtn) queueAllBtn.style.background = '#888';
    let success = 0, failed = 0;

    if (context === 'watch') {
      // Seed the queue with the currently playing video first, so related
      // videos get appended AFTER it (otherwise YouTube starts a new queue
      // with the first added video placed above the current one).
      try {
        if (queueAllBtn) queueAllBtn.textContent = '現在の動画をキューに追加中...';
        await seedQueueWithCurrentVideo();
        await sleep(200);
      } catch (e) {
        console.warn('[YT-Watched-Hider] seed queue error:', e);
      }
    }

    for (let i = 0; i < cards.length; i++) {
      if (queueAbort) break;
      if (!queueAllBtn) break;
      queueAllBtn.textContent = `追加中 ${i + 1}/${cards.length}(クリックで中止)`;
      try {
        const res = await queueOneCard(cards[i]);
        if (res.ok) success++; else failed++;
      } catch (e) {
        failed++;
        console.warn('[YT-Watched-Hider] queue error:', e);
      }
      await sleep(120);
    }

    queueInProgress = false;
    queueAbort = false;
    if (!queueAllBtn) return;
    queueAllBtn.style.background = '#ff4444';
    queueAllBtn.textContent = `完了: ${success}件追加${failed ? ` / ${failed}件失敗` : ''}`;
    setTimeout(updateQueueButtonLabel, 3000);
  }

  function ensureQueueAllButton() {
    if (contextInvalidated) return;
    const context = getBulkPageContext();
    if (!context) {
      removeQueueAllButton();
      return;
    }
    // Insert right before the first visible related video card to avoid
    // inheriting weird flex/grid sizing from container elements.
    const firstCard = findBulkActionAnchor(context);
    if (!firstCard) {
      if (queueButtonContext && queueButtonContext !== context) removeQueueAllButton();
      return;
    }

    if (queueAllBtn && document.body.contains(queueAllBtn)) {
      if (queueButtonContext !== context) {
        queueAllBtn.style.cssText = getBulkButtonStyle('queue', context);
      }
      // Re-position if parent changed (SPA nav, container swap) or first card moved
      if (context === 'channel' || queueAllBtn.parentNode !== firstCard.parentNode || queueAllBtn.nextSibling !== firstCard) {
        insertBulkButton(queueAllBtn, context, firstCard, 'queue');
        if (queueBtnObserver) queueBtnObserver.disconnect();
        queueBtnObserver = new MutationObserver(onQueueBtnMutation);
        queueBtnObserver.observe(firstCard.parentNode, { childList: true });
      }
      queueButtonContext = context;
      updateQueueButtonLabel();
      return;
    }

    // Wrap button in a container with fixed styling to isolate from parent layout
    queueAllBtn = document.createElement('button');
    queueAllBtn.id = 'yt-watched-hider-queue-all';
    queueAllBtn.style.cssText = getBulkButtonStyle('queue', context);
    queueAllBtn.addEventListener('click', onQueueAllClick);
    insertBulkButton(queueAllBtn, context, firstCard, 'queue');
    queueButtonContext = context;
    updateQueueButtonLabel();

    // Watch for removal: YouTube sometimes replaces the recommendations container,
    // which detaches the button. Re-insert within ~100ms instead of waiting up to 1s.
    if (queueBtnObserver) queueBtnObserver.disconnect();
    queueBtnObserver = new MutationObserver(onQueueBtnMutation);
    queueBtnObserver.observe(firstCard.parentNode, { childList: true });
  }

  function onQueueBtnMutation(mutations) {
    for (const m of mutations) {
      for (const n of m.removedNodes) {
        if (n === queueAllBtn || (n.contains && n.contains(queueAllBtn))) {
          if (queueBtnObserver) { queueBtnObserver.disconnect(); queueBtnObserver = null; }
          setTimeout(ensureQueueAllButton, 100);
          return;
        }
      }
    }
  }

  // ===== Watch Later feature =====
  let watchLaterBtn = null;
  let watchLaterInProgress = false;
  let watchLaterAbort = false;
  let watchLaterBtnObserver = null;
  let watchLaterButtonContext = null;

  function removeWatchLaterButton() {
    if (watchLaterBtnObserver) { watchLaterBtnObserver.disconnect(); watchLaterBtnObserver = null; }
    if (watchLaterBtn) { watchLaterBtn.remove(); watchLaterBtn = null; }
    watchLaterButtonContext = null;
    removeBulkButtonBarIfEmpty();
  }

  function findWatchLaterableCards(context = getBulkPageContext()) {
    if (context === 'channel') return findChannelBulkActionCards();
    if (context !== 'watch') return [];

    const currentVid = getCurrentVideoId();
    const cards = document.querySelectorAll(RELATED_CARD_SELECTORS);
    const out = [];
    for (const card of cards) {
      if (card.style.display === 'none') continue;
      // 関連サイドバーの先頭にある chip フィルター用などの 0x0 隠しセクション配下
      // のカードを除外（offsetParent===null で可視判定）
      if (card.offsetParent === null) continue;
      if (card.dataset.watchedHidden === 'true') continue;
      if (card.dataset.shortsHidden === 'true') continue;
      if (card.dataset.movieHidden === 'true') continue;
      const link = card.querySelector('a[href*="/watch?v="]');
      if (!link) continue;
      if (card.querySelector('a[href*="/shorts/"]')) continue;
      const liveBadge = card.querySelector(
        '.badge-style-type-live-now, [aria-label*="ライブ"], [aria-label*="LIVE"]'
      );
      if (liveBadge) continue;
      const videoId = getVideoIdFromHref(link.href);
      if (videoId && videoId === currentVid) continue;
      out.push(card);
    }
    return out;
  }

  async function watchLaterOneCard(card) {
    const kebab = card.querySelector(
      'button[aria-label*="その他の操作"], ' +
      'button[aria-label*="More actions"], ' +
      'ytd-menu-renderer yt-icon-button button, ' +
      'ytd-menu-renderer button, ' +
      'button.yt-spec-button-shape-next[aria-label*="アクション"], ' +
      'button[aria-label*="アクション メニュー"], ' +
      'button[aria-label*="Action menu"]'
    );
    if (!kebab) return { ok: false, reason: 'no-kebab' };

    kebab.click();
    await sleep(200);

    let item = null;
    for (let i = 0; i < 15; i++) {
      const candidates = document.querySelectorAll(
        'ytd-menu-popup-renderer ytd-menu-service-item-renderer, ' +
        'ytd-menu-popup-renderer tp-yt-paper-item, ' +
        'tp-yt-iron-dropdown ytd-menu-service-item-renderer, ' +
        'yt-list-item-view-model, ' +
        'yt-contextual-sheet-layout yt-list-item-view-model'
      );
      for (const c of candidates) {
        const text = (c.textContent || '').trim();
        if (text.includes('後で見る') || text.toLowerCase().includes('watch later')) {
          item = c;
          break;
        }
      }
      if (item) break;
      await sleep(80);
    }

    if (!item) {
      document.body.click();
      await sleep(100);
      return { ok: false, reason: 'no-watch-later-item' };
    }

    const clickTarget = item.querySelector('button, [role="menuitem"], .yt-list-item-view-model-wiz__container') || item;
    clickTarget.click();
    await sleep(200);
    return { ok: true };
  }

  function updateWatchLaterButtonLabel() {
    if (!watchLaterBtn || watchLaterInProgress) return;
    const count = findWatchLaterableCards(watchLaterButtonContext || getBulkPageContext()).length;
    watchLaterBtn.textContent = `後で見る (${count})`;
    watchLaterBtn.disabled = count === 0;
    watchLaterBtn.style.opacity = count === 0 ? '0.5' : '1';
  }

  async function onWatchLaterClick() {
    if (watchLaterInProgress) {
      watchLaterAbort = true;
      if (watchLaterBtn) watchLaterBtn.textContent = '中止中...';
      return;
    }
    const context = getBulkPageContext();
    const cards = findWatchLaterableCards(context);
    if (cards.length === 0) return;
    if (!confirm(buildBulkConfirmMessage('watchLater', cards.length, context))) return;

    watchLaterInProgress = true;
    watchLaterAbort = false;
    if (watchLaterBtn) watchLaterBtn.style.background = '#555';
    let success = 0, failed = 0;

    for (let i = 0; i < cards.length; i++) {
      if (watchLaterAbort) break;
      if (!watchLaterBtn) break;
      watchLaterBtn.textContent = `追加中 ${i + 1}/${cards.length}（クリックで中止）`;
      try {
        const res = await watchLaterOneCard(cards[i]);
        if (res.ok) success++; else failed++;
      } catch (e) {
        failed++;
      }
      await sleep(150);
    }

    watchLaterInProgress = false;
    watchLaterAbort = false;
    if (!watchLaterBtn) return;
    watchLaterBtn.style.background = '#1565c0';
    watchLaterBtn.textContent = `完了: ${success}件追加${failed ? ` / ${failed}件失敗` : ''}`;
    setTimeout(updateWatchLaterButtonLabel, 4000);
  }

  function findWatchLaterAnchor() {
    // /watch ページ専用: 関連動画の先頭（キューボタンの隣に置けるよう同じ親）
    // 注意: 関連サイドバーには chip フィルター用などの 0x0 隠しセクションが
    // 存在し、querySelector が先にそれを拾ってしまうことがある。
    // offsetParent !== null（=可視）なカードのみを採用する。
    const candidates = document.querySelectorAll(
      'ytd-watch-next-secondary-results-renderer yt-lockup-view-model, ' +
      'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer, ' +
      '#related yt-lockup-view-model, ' +
      '#related ytd-compact-video-renderer'
    );
    for (const el of candidates) {
      if (el.offsetParent !== null) return el;
    }
    return null;
  }

  function findChannelChipBar() {
    return document.querySelector('chip-bar-view-model') ||
      document.querySelector('ytd-feed-filter-chip-bar-renderer');
  }

  function findChannelBulkAnchor() {
    // 第一候補: フィルターチップ行（新しい順/人気の動画/古い順）。右端に寄せる。
    const chipBar = findChannelChipBar();
    if (chipBar && chipBar.offsetParent !== null) return chipBar;

    // フォールバック: グリッド先頭の可視カードの前に全幅バーとして挿入。
    const grid = document.querySelector('ytd-rich-grid-renderer #contents') ||
      document.querySelector('ytd-rich-grid-renderer');
    if (!grid) return null;

    const candidates = grid.querySelectorAll('ytd-rich-item-renderer');
    for (const el of candidates) {
      if (el.offsetParent !== null) return el;
    }
    return null;
  }

  function findBulkActionAnchor(context) {
    if (context === 'channel') return findChannelBulkAnchor();
    if (context === 'watch') return findWatchLaterAnchor();
    return null;
  }

  function ensureWatchLaterButton() {
    if (contextInvalidated) return;
    const context = getBulkPageContext();
    if (!context) {
      removeWatchLaterButton();
      return;
    }

    const anchor = findBulkActionAnchor(context);
    if (!anchor) {
      if (watchLaterButtonContext && watchLaterButtonContext !== context) removeWatchLaterButton();
      return;
    }

    if (watchLaterBtn && document.body.contains(watchLaterBtn)) {
      if (watchLaterButtonContext !== context) {
        watchLaterBtn.style.cssText = getBulkButtonStyle('watchLater', context);
      }
      // /watch 以外では先頭カードが動くので再配置
      let moved = false;
      if (context === 'channel' || (watchLaterBtn.nextSibling !== anchor && watchLaterBtn.parentNode !== anchor.parentNode)) {
        insertBulkButton(watchLaterBtn, context, anchor, 'watchLater');
        moved = true;
      } else if (watchLaterBtn.nextSibling !== anchor) {
        insertBulkButton(watchLaterBtn, context, anchor, 'watchLater');
        moved = true;
      }
      if (moved || watchLaterButtonContext !== context) {
        if (watchLaterBtnObserver) watchLaterBtnObserver.disconnect();
        watchLaterBtnObserver = new MutationObserver(onWatchLaterBtnMutation);
        watchLaterBtnObserver.observe(anchor.parentNode, { childList: true });
      }
      watchLaterButtonContext = context;
      updateWatchLaterButtonLabel();
      return;
    }

    watchLaterBtn = document.createElement('button');
    watchLaterBtn.id = 'yt-watched-hider-watch-later';
    watchLaterBtn.style.cssText = getBulkButtonStyle('watchLater', context);
    watchLaterBtn.addEventListener('click', onWatchLaterClick);
    insertBulkButton(watchLaterBtn, context, anchor, 'watchLater');
    watchLaterButtonContext = context;
    updateWatchLaterButtonLabel();

    if (watchLaterBtnObserver) watchLaterBtnObserver.disconnect();
    watchLaterBtnObserver = new MutationObserver(onWatchLaterBtnMutation);
    watchLaterBtnObserver.observe(anchor.parentNode, { childList: true });
  }

  function onWatchLaterBtnMutation(mutations) {
    for (const m of mutations) {
      for (const n of m.removedNodes) {
        if (n === watchLaterBtn || (n.contains && n.contains(watchLaterBtn))) {
          if (watchLaterBtnObserver) { watchLaterBtnObserver.disconnect(); watchLaterBtnObserver = null; }
          setTimeout(ensureWatchLaterButton, 100);
          return;
        }
      }
    }
  }

  function startRecoPolling() {
    if (contextInvalidated) return;
    if (recoInterval) clearInterval(recoInterval);
    checkRecommendations();
    ensureQueueAllButton();
    ensureWatchLaterButton();
    if (contextInvalidated) return;
    recoInterval = setInterval(() => {
      checkRecommendations();
      ensureQueueAllButton();
      ensureWatchLaterButton();
    }, 1000);
  }

  function stopRecoPolling() {
    if (recoInterval) {
      clearInterval(recoInterval);
      recoInterval = null;
    }
    removeQueueAllButton();
  }

  // Initial processing
  if (location.pathname === '/watch') {
    attachVideoEndedListener();
    startRecoPolling();
  } else {
    setTimeout(() => { ensureQueueAllButton(); ensureWatchLaterButton(); }, 600);
  }
  if (isHistoryPage()) {
    setTimeout(scrapeHistoryPage, 500);
  } else if (enabled) {
    setTimeout(processPage, 500);
  }

  // SAPISIDHASH header for authenticated YouTube Innertube API calls.
  // Required for private endpoints like the Liked Videos (LL) playlist.
  // Algorithm: SHA1("<unix_seconds> <SAPISID> https://www.youtube.com")
  async function computeSapisidHash() {
    try {
      const cookies = document.cookie.split(';').map(c => c.trim());
      const get = (name) => {
        const f = cookies.find(c => c.startsWith(name + '='));
        return f ? f.slice(name.length + 1) : '';
      };
      const sapisid = get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID');
      if (!sapisid) return null;
      const ts = Math.floor(Date.now() / 1000);
      const data = `${ts} ${sapisid} https://www.youtube.com`;
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(data));
      const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return `SAPISIDHASH ${ts}_${hash}`;
    } catch (_) {
      return null;
    }
  }

  // Read the account selector that YouTube embedded in this tab's current document.
  // SESSION_INDEX is the value required by X-Goog-AuthUser. The optional stable
  // account key strengthens the end-of-sync comparison when YouTube exposes one.
  function getYouTubeSyncContext() {
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const readConfigValue = (key) => {
      const match = html.match(new RegExp('"' + key + '"\\s*:\\s*(?:"((?:\\\\.|[^"])*)"|(\\d+))'));
      if (!match) return '';
      if (match[2] != null) return match[2];
      try { return JSON.parse('"' + match[1] + '"'); } catch (_e) { return match[1]; }
    };
    const authUser = readConfigValue('SESSION_INDEX');
    const accountId = readConfigValue('LOGGED_IN_USER_ACCOUNT_ID')
      || readConfigValue('DELEGATED_SESSION_ID');
    return {
      success: /^\d+$/.test(String(authUser)),
      authUser: String(authUser),
      accountId: String(accountId || ''),
    };
  }

  // §8.2 (H1): bound every fetch proxied through this content script (they run
  // in the YouTube tab so real cookies are attached — see FETCH_WATCH_HTML
  // etc. below). background.js's own abort/port-disconnect signal is checked
  // BEFORE it sends the message (see sendToYouTubeTab / fetchWatchHtmlQueued in
  // background.js) but cannot reach into a fetch already in flight here, so a
  // stalled request would otherwise never resolve and the caller's outer
  // stop/queue logic would never get control back. A local per-fetch timeout
  // is the only backstop for that. (Tab closure / navigating off youtube.com
  // entirely already terminates this script's execution context, so those
  // cases don't need explicit handling here.)
  const PROXY_FETCH_TIMEOUT_MS = 25000;

  // Listen for messages from background script
  function onMessage(message, sender, sendResponse) {
    if (message.type === 'GET_YOUTUBE_SYNC_CONTEXT') {
      sendResponse({ ...getYouTubeSyncContext(), syncSessionId: message.syncSessionId || '' });
      return true;
    }

    if (message.type === 'VIDEO_DETECTED') {
      if (location.pathname === '/watch') {
        attachVideoEndedListener();
      }
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'ENABLED_CHANGED') {
      enabled = message.enabled;
      if (enabled) {
        processPage();
        if (location.pathname === '/watch') startRecoPolling();
      } else {
        showAllCards();
        stopRecoPolling();
      }
    }

    if (message.type === 'RECORD_WHILE_OFF_CHANGED') {
      recordWhileOff = message.recordWhileOff;
    }

    if (message.type === 'HIDE_SHORTS_CHANGED') {
      hideShorts = message.hideShorts;
      if (hideShorts) {
        hideShortsCards();
      } else {
        showAllShorts();
      }
    }

    if (message.type === 'HARVEST_MODE_CHANGED') {
      harvestMode = message.harvestMode;
      if (harvestMode && isHistoryPage()) {
        ensureHarvestUI();
      } else {
        removeHarvestUI();
      }
    }

    if (message.type === 'HIDE_MOVIES_CHANGED') {
      hideMovies = message.hideMovies;
      if (hideMovies) {
        hideMovieCards();
      } else {
        showAllMovies();
      }
    }

    if (message.type === 'GET_CACHE_STATS') {
      sendResponse({ success: true, ...getCacheStats() });
      return true;
    }

    if (message.type === 'CACHE_INVALIDATED') {
      const mode = message.mode || (message.clear ? 'reload' : 'patch');
      if (mode === 'reload') {
        watchedPositive.clear();
        recentLookup.clear();
        pendingLookup.clear();
        cacheLoaded = false;
        showAllCards();
        loadCache();
      } else {
        if (Array.isArray(message.addedIds)) {
          for (const id of message.addedIds) rememberWatched(id);
        }
        if (Array.isArray(message.deletedIds)) {
          for (const id of message.deletedIds) forgetWatched(id);
          showCardsForVideoIds(message.deletedIds);
        }
      }
      if (enabled) setTimeout(processPage, 250);
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'FETCH_WATCH_HTML') {
      // Proxy fetch through the YouTube tab context so the request carries
      // real user cookies and looks like a normal page navigation. This
      // avoids the google.com/sorry bot-challenge that extension-origin
      // credentials:'omit' fetches trigger after a burst.
      (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
        try {
          const url = `https://www.youtube.com/watch?v=${encodeURIComponent(message.videoId)}`;
          const res = await fetch(url, { signal: controller.signal });
          const finalUrl = res.url || '';
          if (/google\.com\/sorry/i.test(finalUrl)) {
            sendResponse({ success: false, reason: 'sorry-redirect', finalUrl });
            return;
          }
          if (!res.ok) {
            sendResponse({ success: false, reason: 'http-' + res.status });
            return;
          }
          const html = await res.text();
          sendResponse({ success: true, html, finalUrl });
        } catch (e) {
          sendResponse({ success: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch-error', error: e.message });
        } finally {
          clearTimeout(timer);
        }
      })();
      return true;
    }

    if (message.type === 'FETCH_PLAYLIST_HTML') {
      (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
        try {
          const authUser = String(message.authUser == null ? '' : message.authUser);
          if (!/^\d+$/.test(authUser)) {
            sendResponse({ success: false, reason: 'invalid-auth-user' });
            return;
          }
          const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(message.listId || 'LL')}&authuser=${encodeURIComponent(authUser)}`;
          const res = await fetch(url, { signal: controller.signal });
          const finalUrl = res.url || '';
          if (/google\.com\/sorry/i.test(finalUrl)) {
            sendResponse({ success: false, reason: 'sorry-redirect', finalUrl });
            return;
          }
          if (!res.ok) {
            sendResponse({ success: false, reason: 'http-' + res.status });
            return;
          }
          const html = await res.text();
          sendResponse({ success: true, html, finalUrl });
        } catch (e) {
          sendResponse({ success: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch-error', error: e.message });
        } finally {
          clearTimeout(timer);
        }
      })();
      return true;
    }

    if (message.type === 'FETCH_INNERTUBE_BROWSE') {
      // Proxy POST to youtubei/v1/browse with full auth headers (LL is private).
      (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
        try {
          const authUser = String(message.authUser == null ? '' : message.authUser);
          if (!/^\d+$/.test(authUser)) {
            sendResponse({ success: false, reason: 'invalid-auth-user' });
            return;
          }
          const url = `https://www.youtube.com/youtubei/v1/browse?prettyPrint=false${message.apiKey ? '&key=' + encodeURIComponent(message.apiKey) : ''}`;
          const headers = {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '1',
            'X-Origin': 'https://www.youtube.com',
            'X-Goog-AuthUser': authUser,
          };
          if (message.clientVersion) headers['X-YouTube-Client-Version'] = message.clientVersion;
          const auth = await computeSapisidHash();
          if (auth) headers['Authorization'] = auth;
          const res = await fetch(url, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify(message.body || {}),
            signal: controller.signal,
          });
          if (!res.ok) {
            sendResponse({ success: false, reason: 'http-' + res.status });
            return;
          }
          const data = await res.json();
          sendResponse({ success: true, data });
        } catch (e) {
          sendResponse({ success: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch-error', error: e.message });
        } finally {
          clearTimeout(timer);
        }
      })();
      return true;
    }

    if (message.type === 'FETCH_INNERTUBE_EDIT_PLAYLIST') {
      // Proxy POST to youtubei/v1/browse/edit_playlist. This is the ONLY irreversible
      // request the extension makes, so the endpoint is hardcoded here and the body is
      // re-validated: whatever the caller sends, this proxy can never do more than
      // remove ONE entry from Watch Later. Widening it (other playlists, other
      // actions, batches) must be a deliberate edit to this guard, not a caller change.
      (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
        try {
          const authUser = String(message.authUser == null ? '' : message.authUser);
          if (!/^\d+$/.test(authUser)) {
            sendResponse({ success: false, reason: 'invalid-auth-user' });
            return;
          }
          const body = message.body || {};
          const actions = Array.isArray(body.actions) ? body.actions : [];
          if (body.playlistId !== 'WL' || actions.length !== 1
              || !actions[0] || actions[0].action !== 'ACTION_REMOVE_VIDEO'
              || !actions[0].setVideoId) {
            sendResponse({ success: false, reason: 'refused-unexpected-edit' });
            return;
          }
          const url = `https://www.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false${message.apiKey ? '&key=' + encodeURIComponent(message.apiKey) : ''}`;
          const headers = {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '1',
            'X-Origin': 'https://www.youtube.com',
            'X-Goog-AuthUser': authUser,
          };
          if (message.clientVersion) headers['X-YouTube-Client-Version'] = message.clientVersion;
          const auth = await computeSapisidHash();
          if (auth) headers['Authorization'] = auth;
          const res = await fetch(url, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!res.ok) {
            sendResponse({ success: false, reason: 'http-' + res.status });
            return;
          }
          const data = await res.json();
          sendResponse({ success: true, data });
        } catch (e) {
          sendResponse({ success: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch-error', error: e.message });
        } finally {
          clearTimeout(timer);
        }
      })();
      return true;
    }

    if (message.type === 'QUEUE_VIDEO') {
      const card = findCardByVideoId(message.videoId);
      if (card) queueOneCard(card).catch(() => {});
    }

    if (message.type === 'WATCH_LATER_VIDEO') {
      const card = findCardByVideoId(message.videoId);
      if (card) watchLaterOneCard(card).catch(() => {});
    }
  }

  if (typeof chrome !== 'undefined' && detectContextInvalidation()) {
    contextReady = true;
    cleanup(true);
    return { cleanup };
  }
  chrome.runtime.onMessage.addListener(onMessage);
  contextReady = true;

  // Cleanup function for re-injection
  function cleanup(keepReloadNotice = false) {
    for (const timer of contextTimers) window.clearTimeout(timer);
    contextTimers.clear();
    processQueued = false;
    queueAbort = true;
    watchLaterAbort = true;
    if (toastState.el) { toastState.el.remove(); toastState.el = null; }
    if (!keepReloadNotice) document.getElementById(reloadNoticeId)?.remove();
    observer.disconnect();
    if (recoInterval) clearInterval(recoInterval);
    if (currentVideoElement && endedHandler) {
      currentVideoElement.removeEventListener('ended', endedHandler);
    }
    document.removeEventListener('yt-navigate-finish', onNavigateFinish);
    removeHarvestUI();
    if (!contextInvalidated && chrome.runtime?.id) chrome.runtime.onMessage.removeListener(onMessage);
    if (queueBtnObserver) { queueBtnObserver.disconnect(); queueBtnObserver = null; }
    if (queueAllBtn) { queueAllBtn.remove(); queueAllBtn = null; }
    if (watchLaterBtnObserver) { watchLaterBtnObserver.disconnect(); watchLaterBtnObserver = null; }
    if (watchLaterBtn) { watchLaterBtn.remove(); watchLaterBtn = null; }
    if (bulkButtonBar) { bulkButtonBar.remove(); bulkButtonBar = null; }
  }

  return { cleanup };
})();
