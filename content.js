// Content script for YouTube Watched Hider
// Hides watched videos using dual detection: YouTube seekbar + IndexedDB
// Records only when video playback completes (ended event)

(() => {
  // Selectors for video card containers (update these if YouTube changes DOM)
  const SELECTORS = {
    // Video card containers
    richItem: 'ytd-rich-item-renderer',           // Home page grid
    videoRenderer: 'ytd-video-renderer',           // Search results
    compactVideo: 'ytd-compact-video-renderer',    // Sidebar / end screen
    reelItem: 'ytd-rich-grid-media',               // Shorts shelf on home

    // Link containing video ID
    videoLink: 'a[href*="/watch?v="]',

    // YouTube's own watched indicator (red progress bar on thumbnail)
    seekbar: '#progress',
    resumeOverlay: 'ytd-thumbnail-overlay-resume-playback-renderer',
  };

  const ALL_CARD_SELECTORS = [
    SELECTORS.richItem,
    SELECTORS.videoRenderer,
    SELECTORS.compactVideo,
  ].join(', ');

  let enabled = true;
  let recordWhileOff = false;
  let processing = false;
  let currentVideoElement = null;
  let endedHandler = null;

  // Load settings
  chrome.storage.local.get({ enabled: true, recordWhileOff: false }, (result) => {
    enabled = result.enabled;
    recordWhileOff = result.recordWhileOff;
    if (enabled) processPage();
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
      'yt-formatted-string#video-title'
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
      '#channel-name a'
    );
    return channelEl ? channelEl.textContent.trim() : '';
  }

  // Check if a card has YouTube's seekbar (red progress bar)
  function hasYouTubeSeekbar(card) {
    const resume = card.querySelector(SELECTORS.resumeOverlay);
    if (resume) return true;

    const progress = card.querySelector(SELECTORS.seekbar);
    if (progress && progress.style && parseFloat(progress.style.width) > 0) return true;

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

  // Process all visible video cards
  async function processPage() {
    if (!enabled || processing) return;
    processing = true;

    try {
      const cards = document.querySelectorAll(ALL_CARD_SELECTORS);
      if (cards.length === 0) {
        processing = false;
        return;
      }

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
          // Record with source='seekbar' and grab title/channel from card
          const title = getTitleFromCard(card);
          const channel = getChannelFromCard(card);
          WatchedDB.addWatched(videoId, title, 'seekbar', channel).catch(() => {});
          continue;
        }

        if (!cardMap.has(videoId)) {
          cardMap.set(videoId, []);
        }
        cardMap.get(videoId).push(card);
      }

      // Batch check remaining IDs against IndexedDB
      const videoIds = Array.from(cardMap.keys());
      if (videoIds.length > 0) {
        const results = await WatchedDB.checkMultiple(videoIds);
        for (const [videoId, isWatched] of Object.entries(results)) {
          const matchingCards = cardMap.get(videoId) || [];
          if (isWatched) {
            for (const card of matchingCards) {
              hideCard(card, videoId);
            }
          } else {
            // Mark as checked so sidebar polling skips these
            for (const card of matchingCards) {
              card.dataset.watchedChecked = 'true';
            }
          }
        }
      }
    } catch (e) {
      console.error('[YT-Watched-Hider] Error processing page:', e);
    }

    processing = false;
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
  // Scan /feed/history for watched videos and import them into DB
  // Does NOT hide anything on the history page
  // YouTube history page uses yt-lockup-view-model (new UI), fallback to ytd-video-renderer
  const HISTORY_CARD_SELECTOR = 'yt-lockup-view-model, ytd-video-renderer';

  // Get title from history card (handles both old and new YouTube UI)
  function getHistoryTitle(card) {
    const el = card.querySelector('h3, #video-title, yt-formatted-string#video-title');
    return el ? el.textContent.trim() : getTitleFromCard(card);
  }

  // Get channel from history card
  function getHistoryChannel(card) {
    // New UI: channel info in various text elements
    const el = card.querySelector(
      '.yt-content-metadata-view-model-wiz__metadata-text, ' +
      'ytd-channel-name yt-formatted-string a, ' +
      'ytd-channel-name yt-formatted-string'
    );
    return el ? el.textContent.trim() : getChannelFromCard(card);
  }

  // Get video link from history card
  function getHistoryVideoLink(card) {
    // New UI uses a[href*="watch"], same as old
    return card.querySelector('a[href*="watch"], a[href*="/watch?v="]');
  }

  // Check if a history card's video was watched to completion (>= 95%)
  // New YouTube UI uses yt-thumbnail-overlay-progress-bar-view-model with
  // a child div whose style.width indicates progress percentage.
  // Returns false if no progress bar found (e.g. live streams) or progress < 95%.
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

    // Collect candidates (only videos watched >= 95%)
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

    // Batch check which are already in DB — skip those
    const videoIds = candidates.map(c => c.videoId);
    const existing = await WatchedDB.checkMultiple(videoIds);

    let imported = 0;
    for (const { card, videoId } of candidates) {
      if (existing[videoId]) continue; // already in DB, skip

      const title = getHistoryTitle(card);
      const channel = getHistoryChannel(card);

      try {
        await WatchedDB.addWatched(videoId, title, 'self', channel);
        imported++;
      } catch (e) {
        // skip individual failures
      }
    }

    if (imported > 0) {
      console.log(`[YT-Watched-Hider] Imported ${imported} new videos from history`);
    }
  }

  function isHistoryPage() {
    return location.pathname === '/feed/history';
  }

  // Observe DOM mutations for dynamically loaded content
  // NOTE: Only observe childList (new nodes added). Do NOT observe attributes
  // because YouTube heavily mutates href/attributes during SPA navigation,
  // which can interfere with background playback and mini-player.
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
        // On history page: scrape new cards into DB (no hiding)
        observer._debounceTimer = setTimeout(scrapeHistoryPage, 300);
      } else if (enabled) {
        // Normal pages: hide watched videos
        observer._debounceTimer = setTimeout(processPage, 300);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Listen for YouTube SPA navigation
  document.addEventListener('yt-navigate-finish', () => {
    if (location.pathname === '/watch') {
      attachVideoEndedListener();
    }
    // Reset flags on navigation (sidebar content changes)
    for (const card of document.querySelectorAll('[data-watched-hidden="true"]')) {
      delete card.dataset.watchedHidden;
    }
    for (const card of document.querySelectorAll('[data-watched-checked="true"]')) {
      delete card.dataset.watchedChecked;
    }
    if (isHistoryPage()) {
      // Scrape history page
      setTimeout(scrapeHistoryPage, 500);
    } else if (enabled) {
      setTimeout(processPage, 500);
    }
  });

  // Sidebar-specific check: independent of processPage to avoid processing flag deadlock.
  // YouTube recycles sidebar DOM without adding new nodes, so MutationObserver misses them.
  const SIDEBAR_SELECTORS = [
    'ytd-compact-video-renderer',
    'ytd-video-renderer',
    'ytd-rich-item-renderer',
  ].join(', ');

  let sidebarInterval = null;
  async function checkSidebar() {
    if (!enabled || location.pathname !== '/watch') return;

    const sidebar = document.querySelector('#secondary, ytd-watch-next-secondary-results-renderer');
    if (!sidebar) return;

    const cards = sidebar.querySelectorAll(SIDEBAR_SELECTORS);
    if (cards.length === 0) return;

    const unchecked = [];
    const currentVid = getCurrentVideoId();

    for (const card of cards) {
      if (card.dataset.watchedHidden === 'true') continue;
      if (card.dataset.watchedChecked === 'true') continue;

      // Check seekbar first (hide immediately)
      if (hasYouTubeSeekbar(card)) {
        const link = card.querySelector(SELECTORS.videoLink);
        const videoId = link ? getVideoIdFromHref(link.href) : null;
        if (videoId && videoId !== currentVid) {
          hideCard(card, videoId);
          const title = getTitleFromCard(card);
          const channel = getChannelFromCard(card);
          WatchedDB.addWatched(videoId, title, 'seekbar', channel).catch(() => {});
        }
        continue;
      }

      const link = card.querySelector(SELECTORS.videoLink);
      if (!link) continue;
      const videoId = getVideoIdFromHref(link.href);
      if (!videoId || videoId === currentVid) continue;

      unchecked.push({ card, videoId });
    }

    if (unchecked.length === 0) return;

    // Batch check against DB
    try {
      const ids = unchecked.map(c => c.videoId);
      const results = await WatchedDB.checkMultiple(ids);
      for (const { card, videoId } of unchecked) {
        if (results[videoId]) {
          hideCard(card, videoId);
        } else {
          card.dataset.watchedChecked = 'true';
        }
      }
    } catch (e) {
      // DB error, will retry on next poll
    }
  }

  function startSidebarPolling() {
    if (sidebarInterval) return;
    // Run immediately, then every 2 seconds
    checkSidebar();
    sidebarInterval = setInterval(checkSidebar, 2000);
  }

  // Initial processing
  if (location.pathname === '/watch') {
    attachVideoEndedListener();
    startSidebarPolling();
  }
  if (isHistoryPage()) {
    setTimeout(scrapeHistoryPage, 500);
  } else if (enabled) {
    setTimeout(processPage, 500);
  }

  // Start polling when navigating to watch page
  document.addEventListener('yt-navigate-finish', () => {
    if (location.pathname === '/watch') {
      startSidebarPolling();
    }
  });

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'VIDEO_DETECTED') {
      // Background detected a URL change to a watch page.
      // Don't record yet — wait for the ended event.
      // But do attach the listener if not already attached.
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
      WatchedDB.getStats().then(sendResponse).catch(() => sendResponse({ count: 0 }));
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
  });
})();
