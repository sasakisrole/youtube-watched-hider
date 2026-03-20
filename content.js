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
    playlistItem: 'ytd-playlist-panel-video-renderer', // Playlist panel

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
  let processQueued = false;
  let processRunning = false;
  let currentVideoElement = null;
  let endedHandler = null;

  // In-memory cache of watched video IDs to avoid repeated IndexedDB lookups
  const CACHE_MAX_SIZE = 50000;
  const watchedCache = new Set();
  let cacheLoaded = false;
  let cacheLoadTime = 0;
  let dbStatus = 'loading'; // 'loading' | 'ready' | 'error'

  // Load all watched IDs into cache at startup (lightweight: keys only)
  async function loadCache() {
    const t0 = performance.now();
    try {
      const ids = await WatchedDB.getAllIds();
      for (const id of ids) {
        watchedCache.add(id);
      }
      cacheLoaded = true;
      cacheLoadTime = Math.round(performance.now() - t0);
      dbStatus = 'ready';
      if (watchedCache.size > CACHE_MAX_SIZE) {
        console.warn(`[YT-Watched-Hider] Cache exceeds ${CACHE_MAX_SIZE}, falling back to DB queries`);
        watchedCache.clear();
        cacheLoaded = false;
      }
      console.log(`[YT-Watched-Hider] DB ready: ${watchedCache.size} videos cached in ${cacheLoadTime}ms`);
      // Cache is now ready — run a full pass to catch anything missed during phase 1
      if (enabled) processPage();
    } catch (e) {
      cacheLoadTime = Math.round(performance.now() - t0);
      dbStatus = 'error';
      console.error(`[YT-Watched-Hider] DB load failed (${cacheLoadTime}ms):`, e);
      // Fall back to per-query DB access
      cacheLoaded = false;
    }
  }
  loadCache();

  // Load settings — start seekbar-only processing immediately (no DB needed)
  chrome.storage.local.get({ enabled: true, recordWhileOff: false }, (result) => {
    enabled = result.enabled;
    recordWhileOff = result.recordWhileOff;
    if (enabled) processPage(); // phase 1: seekbar detection works even without cache
  });

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

  // Check if a card has YouTube's seekbar (red progress bar on thumbnail)
  function hasYouTubeSeekbar(card) {
    // Old UI: resume playback overlay
    const resume = card.querySelector(SELECTORS.resumeOverlay);
    if (resume) return true;

    // Old UI: #progress element with width
    const progress = card.querySelector(SELECTORS.seekbar);
    if (progress && progress.style && parseFloat(progress.style.width) > 0) return true;

    // New UI: progress bar segment with width percentage
    const segment = card.querySelector(SELECTORS.progressBarNew);
    if (segment && segment.style && parseFloat(segment.style.width) > 0) return true;

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

  // Get channel name from watch page
  function getWatchPageChannel() {
    const channelEl = document.querySelector(
      'ytd-watch-metadata ytd-channel-name yt-formatted-string a, ' +
      '#owner ytd-channel-name yt-formatted-string a, ' +
      '#channel-name yt-formatted-string a, ' +
      'ytd-video-owner-renderer ytd-channel-name a'
    );
    return channelEl ? channelEl.textContent.trim() : '';
  }

  // Record current video as watched (source: 'self')
  async function recordCurrentVideo() {
    if (!enabled && !recordWhileOff) return;

    const videoId = getCurrentVideoId();
    if (!videoId) return;

    try {
      const title = getWatchPageTitle();
      const channel = getWatchPageChannel();
      await WatchedDB.addWatched(videoId, title, 'self', channel);
      watchedCache.add(videoId);
      console.log(`[YT-Watched-Hider] Recorded: ${title || videoId}`);
    } catch (e) {
      console.error('[YT-Watched-Hider] Error recording video:', e);
    }
  }

  // Attach ended listener to the <video> element
  function attachVideoEndedListener() {
    // Clean up previous listener
    if (currentVideoElement && endedHandler) {
      currentVideoElement.removeEventListener('ended', endedHandler);
      currentVideoElement = null;
      endedHandler = null;
    }

    const video = document.querySelector('video');
    if (!video) {
      // Video element might not be ready yet, retry
      setTimeout(attachVideoEndedListener, 1000);
      return;
    }

    currentVideoElement = video;
    endedHandler = () => {
      recordCurrentVideo();
    };

    video.addEventListener('ended', endedHandler);

    // Also update title/channel in DB if we already have the record (from seekbar detection)
    setTimeout(() => {
      const videoId = getCurrentVideoId();
      const title = getWatchPageTitle();
      const channel = getWatchPageChannel();
      if (videoId && (title || channel)) {
        WatchedDB.updateTitleAndChannel(videoId, title, channel).catch(() => {});
      }
    }, 3000);
  }

  // Process all visible video cards (with queue to avoid lost updates)
  async function processPage() {
    if (!enabled) return;
    if (processRunning) {
      processQueued = true; // will re-run after current finishes
      return;
    }
    processRunning = true;
    processQueued = false;

    try {
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
        // Skip already-processed hidden cards
        if (card.dataset.watchedHidden === 'true') continue;

        const link = card.querySelector(SELECTORS.videoLink);
        if (!link) continue;

        const videoId = getVideoIdFromHref(link.href);
        if (!videoId) continue;

        // Don't hide the currently playing video's card
        if (videoId === getCurrentVideoId()) continue;

        // Check YouTube seekbar first (no DB needed)
        if (hasYouTubeSeekbar(card)) {
          hideCard(card, videoId);
          watchedCache.add(videoId);
          const title = getTitleFromCard(card);
          const channel = getChannelFromCard(card);
          WatchedDB.addWatched(videoId, title, 'seekbar', channel).catch(() => {});
          hiddenBySeekbar++;
          continue;
        }

        // Check in-memory cache first (fast path)
        if (cacheLoaded && watchedCache.has(videoId)) {
          hideCard(card, videoId);
          hiddenByCache++;
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
        const results = await WatchedDB.checkMultiple(videoIds);
        for (const [videoId, isWatched] of Object.entries(results)) {
          const matchingCards = cardMap.get(videoId) || [];
          if (isWatched) {
            watchedCache.add(videoId);
            for (const card of matchingCards) {
              hideCard(card, videoId);
              hiddenByDb++;
            }
          } else {
            // Mark as checked with the specific videoId so sidebar polling skips these
            for (const card of matchingCards) {
              card.dataset.watchedCheckedId = videoId;
            }
          }
        }
      }

      const totalHidden = hiddenBySeekbar + hiddenByCache + hiddenByDb;
      if (totalHidden > 0) {
        console.log(`[YT-Watched-Hider] Hidden ${totalHidden} videos (seekbar: ${hiddenBySeekbar}, cache: ${hiddenByCache}, db: ${hiddenByDb})`);
      }
    } catch (e) {
      console.error('[YT-Watched-Hider] Error processing page:', e);
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
  }

  // --- History page scraping ---
  const HISTORY_CARD_SELECTOR = 'yt-lockup-view-model, ytd-video-renderer';

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

  function getHistoryVideoLink(card) {
    return card.querySelector('a[href*="watch"], a[href*="/watch?v="]');
  }

  // Check if a history card's video was watched to completion (>= 95%)
  function isHistoryCardCompleted(card) {
    const segment = card.querySelector(
      '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment'
    );
    if (!segment) return false;
    const width = parseFloat(segment.style.width);
    return !isNaN(width) && width >= 95;
  }

  async function scrapeHistoryPage() {
    const cards = document.querySelectorAll(HISTORY_CARD_SELECTOR);
    console.log(`[YT-Watched-Hider] History scrape: found ${cards.length} cards`);

    const candidates = [];
    for (const card of cards) {
      if (card.dataset.historyScraped === 'true') continue;
      card.dataset.historyScraped = 'true';

      const link = getHistoryVideoLink(card);
      if (!link) continue;

      const videoId = getVideoIdFromHref(link.href);
      if (!videoId) continue;

      // Skip partially watched videos — only register >= 95% progress
      if (!isHistoryCardCompleted(card)) continue;

      candidates.push({ card, videoId });
    }
    console.log(`[YT-Watched-Hider] Candidates: ${candidates.length}`);

    if (candidates.length === 0) return;

    const videoIds = candidates.map(c => c.videoId);
    const existing = await WatchedDB.checkMultiple(videoIds);

    // Collect new records for batch import
    const newRecords = [];
    for (const { card, videoId } of candidates) {
      if (existing[videoId]) continue;

      const title = getHistoryTitle(card);
      const channel = getHistoryChannel(card);
      newRecords.push({
        videoId,
        title,
        channel: channel || '',
        watchedAt: Date.now(),
        firstWatchedAt: Date.now(),
        playCount: 0,
        source: 'history',
      });
    }

    if (newRecords.length > 0) {
      try {
        await WatchedDB.importData(newRecords);
        for (const r of newRecords) watchedCache.add(r.videoId);
        console.log(`[YT-Watched-Hider] Imported ${newRecords.length} new videos from history`);
      } catch (e) {
        console.error('[YT-Watched-Hider] History batch import failed:', e);
      }
    }
  }

  function isHistoryPage() {
    return location.pathname === '/feed/history';
  }

  // Observe DOM mutations for dynamically loaded content
  const observer = new MutationObserver((mutations) => {
    let hasRelevantChange = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches?.(ALL_CARD_SELECTORS) || node.querySelector?.(ALL_CARD_SELECTORS) ||
              node.matches?.(HISTORY_CARD_SELECTOR) || node.querySelector?.(HISTORY_CARD_SELECTOR)) {
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
        observer._debounceTimer = setTimeout(processPage, 300);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Listen for YouTube SPA navigation
  function onNavigateFinish() {
    if (location.pathname === '/watch') {
      attachVideoEndedListener();
      startRecoPolling();
    }
    // Reset flags on navigation (sidebar content changes)
    for (const card of document.querySelectorAll('[data-watched-hidden="true"]')) {
      card.style.display = '';
      delete card.dataset.watchedHidden;
      delete card.dataset.watchedVideoId;
    }
    for (const card of document.querySelectorAll('[data-watched-checked-id]')) {
      delete card.dataset.watchedCheckedId;
    }
    if (isHistoryPage()) {
      setTimeout(scrapeHistoryPage, 500);
    } else if (enabled) {
      setTimeout(processPage, 500);
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
    if (!enabled || location.pathname !== '/watch') return;
    if (document.hidden) return; // skip while tab is not visible
    if (recoChecking) return; // prevent overlap
    recoChecking = true;

    try {
      // Search entire document — covers sidebar, below-player (theater), end screen
      const cards = document.querySelectorAll(ALL_CARD_SELECTORS);
      if (cards.length === 0) return;

      const unchecked = [];
      const currentVid = getCurrentVideoId();

      for (const card of cards) {
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

        if (card.dataset.watchedCheckedId === videoId) continue; // already checked this exact video

        // Check YouTube seekbar first (hide immediately, no DB lookup needed)
        if (hasYouTubeSeekbar(card)) {
          hideCard(card, videoId);
          watchedCache.add(videoId);
          const title = getTitleFromCard(card);
          const channel = getChannelFromCard(card);
          WatchedDB.addWatched(videoId, title, 'seekbar', channel).catch(() => {});
          continue;
        }

        // Check in-memory cache (fast path, no DB access)
        if (cacheLoaded && watchedCache.has(videoId)) {
          hideCard(card, videoId);
          continue;
        }

        unchecked.push({ card, videoId });
      }

      if (unchecked.length === 0) return;

      const ids = unchecked.map(c => c.videoId);
      const results = await WatchedDB.checkMultiple(ids);
      for (const { card, videoId } of unchecked) {
        if (results[videoId]) {
          watchedCache.add(videoId);
          hideCard(card, videoId);
        } else {
          // Store the checked videoId so we can detect recycling
          card.dataset.watchedCheckedId = videoId;
        }
      }
    } catch (e) {
      // DB error, will retry on next poll
    } finally {
      recoChecking = false;
    }
  }

  function startRecoPolling() {
    if (recoInterval) clearInterval(recoInterval);
    checkRecommendations();
    recoInterval = setInterval(checkRecommendations, 1000);
  }

  // Initial processing
  if (location.pathname === '/watch') {
    attachVideoEndedListener();
    startRecoPolling();
  }
  if (isHistoryPage()) {
    setTimeout(scrapeHistoryPage, 500);
  } else if (enabled) {
    setTimeout(processPage, 500);
  }

  // Listen for messages from background script
  function onMessage(message, sender, sendResponse) {
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
      } else {
        showAllCards();
      }
    }

    if (message.type === 'RECORD_WHILE_OFF_CHANGED') {
      recordWhileOff = message.recordWhileOff;
    }

    if (message.type === 'GET_STATS') {
      WatchedDB.getStats().then((stats) => {
        sendResponse({
          ...stats,
          dbStatus,
          cacheSize: watchedCache.size,
          cacheLoadTime,
        });
      }).catch(() => sendResponse({ count: 0, dbStatus: 'error', cacheSize: 0, cacheLoadTime: 0 }));
      return true;
    }

    if (message.type === 'EXPORT_DATA') {
      WatchedDB.exportAll().then(sendResponse).catch(() => sendResponse([]));
      return true;
    }

    if (message.type === 'IMPORT_DATA') {
      WatchedDB.importData(message.data).then((count) => {
        processPage();
        sendResponse({ success: true, count });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    if (message.type === 'CLEAR_DATA') {
      WatchedDB.clearAll().then(() => {
        showAllCards();
        sendResponse({ success: true });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);

  // Cleanup function for re-injection
  function cleanup() {
    observer.disconnect();
    if (recoInterval) clearInterval(recoInterval);
    if (currentVideoElement && endedHandler) {
      currentVideoElement.removeEventListener('ended', endedHandler);
    }
    document.removeEventListener('yt-navigate-finish', onNavigateFinish);
    chrome.runtime.onMessage.removeListener(onMessage);
  }

  return { cleanup };
})();
