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

  // Record current video as watched (source: 'self')
  async function recordCurrentVideo() {
    if (!enabled && !recordWhileOff) return;

    const videoId = getCurrentVideoId();
    if (!videoId) return;

    try {
      const title = getWatchPageTitle();
      await WatchedDB.addWatched(videoId, title, 'self');
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

    // Also update title in DB if we already have the record (from seekbar detection)
    setTimeout(() => {
      const videoId = getCurrentVideoId();
      const title = getWatchPageTitle();
      if (videoId && title) {
        WatchedDB.updateTitle(videoId, title).catch(() => {});
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
          // Record with source='seekbar' and grab title from card
          const title = getTitleFromCard(card);
          WatchedDB.addWatched(videoId, title, 'seekbar').catch(() => {});
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
          if (isWatched) {
            const matchingCards = cardMap.get(videoId) || [];
            for (const card of matchingCards) {
              hideCard(card, videoId);
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

  // Observe DOM mutations for dynamically loaded content
  const observer = new MutationObserver((mutations) => {
    if (!enabled) return;

    let hasNewCards = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches?.(ALL_CARD_SELECTORS) || node.querySelector?.(ALL_CARD_SELECTORS)) {
            hasNewCards = true;
            break;
          }
        }
      }
      if (hasNewCards) break;
    }

    if (hasNewCards) {
      // Debounce processing
      clearTimeout(observer._debounceTimer);
      observer._debounceTimer = setTimeout(processPage, 200);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Listen for YouTube SPA navigation
  document.addEventListener('yt-navigate-finish', () => {
    if (location.pathname === '/watch') {
      // Attach ended listener to detect playback completion
      attachVideoEndedListener();
    }
    // Only hide cards when enabled
    if (enabled) {
      setTimeout(processPage, 500);
    }
  });

  // Initial processing
  if (location.pathname === '/watch') {
    attachVideoEndedListener();
  }
  if (enabled) setTimeout(processPage, 500);

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
