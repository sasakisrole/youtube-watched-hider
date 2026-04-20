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

  // Import toast: shows "+N件 取り込み" when new records are added to DB.
  // Accumulates count during rapid imports and auto-dismisses after idle.
  const toastState = { el: null, count: 0, timer: null };
  function showImportToast(n) {
    if (!n || n <= 0) return;
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
  chrome.storage.local.get({ enabled: true, recordWhileOff: false, hideShorts: false, hideMovies: false, harvestMode: false }, (result) => {
    enabled = result.enabled;
    recordWhileOff = result.recordWhileOff;
    hideShorts = result.hideShorts;
    hideMovies = result.hideMovies;
    harvestMode = result.harvestMode;
    if (enabled) processPage(); // phase 1: seekbar detection works even without cache
    if (harvestMode && isHistoryPage()) ensureHarvestUI();
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
    if (!videoId) return;
    const deadline = Date.now() + 12000; // 12s window
    const INTERVAL = 500;

    const tick = () => {
      if (watchMetadataMatches(videoId)) {
        const title = getWatchPageTitle();
        const channel = getWatchPageChannel();
        if (title || channel) {
          WatchedDB.updateTitleAndChannel(videoId, title, channel).catch(() => {});
          return;
        }
      }
      if (Date.now() < deadline) {
        setTimeout(tick, INTERVAL);
      } else {
        // Last resort: ask background to fetch via oEmbed.
        try {
          chrome.runtime.sendMessage({
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
  async function recordCurrentVideo() {
    if (!enabled && !recordWhileOff) return;

    const videoId = getCurrentVideoId();
    if (!videoId) return;

    try {
      // Guard against SPA race: on autoplay, URL may already point to the
      // next video while ytd-watch-metadata still shows the previous one
      // (or vice versa). Only trust title/channel if the DOM agrees with
      // the URL's videoId. Otherwise save id only and schedule a backfill.
      const domAgrees = watchMetadataMatches(videoId);
      const title = domAgrees ? getWatchPageTitle() : '';
      const channel = domAgrees ? getWatchPageChannel() : '';
      await WatchedDB.addWatched(videoId, title, 'self', channel);
      watchedCache.add(videoId);
      console.log(`[YT-Watched-Hider] Recorded: ${title || videoId}${domAgrees ? '' : ' (id only, scheduling backfill)'}`);

      if (!domAgrees || !title || !channel) {
        backfillTitleChannel(videoId);
      }
    } catch (e) {
      console.error('[YT-Watched-Hider] Error recording video:', e);
    }
  }

  // Attach ended listener to the <video> element
  let videoRetryCount = 0;
  const VIDEO_RETRY_MAX = 10;

  function attachVideoEndedListener() {
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
    endedHandler = () => {
      recordCurrentVideo();
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
          WatchedDB.addWatched(videoId, title, 'seekbar', channel).then((res) => {
            if (res && res.isNew) showImportToast(1);
          }).catch(() => {});
          // If we couldn't extract title or channel from the card (some
          // layout variants expose neither), schedule an oEmbed backfill
          // so the entry doesn't stay blank forever.
          if (!title || !channel) {
            try {
              chrome.runtime.sendMessage({
                type: 'FIX_CHANNELS',
                videoIds: [videoId],
                force: false
              }, () => { /* ignore */ });
            } catch (_e) { /* ignore */ }
          }
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
    const { removeProcessed = false } = options;
    const cards = document.querySelectorAll(HISTORY_CARD_SELECTOR);
    console.log(`[YT-Watched-Hider] History scrape: found ${cards.length} cards`);

    const candidates = [];
    const processedCards = [];
    for (const card of cards) {
      if (card.dataset.historyScraped === 'true') continue;
      card.dataset.historyScraped = 'true';
      processedCards.push(card);

      const link = getHistoryVideoLink(card);
      if (!link) continue;

      const videoId = getVideoIdFromHref(link.href);
      if (!videoId) continue;

      // Skip partially watched videos — only register >= 95% progress
      if (!isHistoryCardCompleted(card)) continue;

      candidates.push({ card, videoId });
    }
    console.log(`[YT-Watched-Hider] Candidates: ${candidates.length}`);

    let added = 0;
    if (candidates.length > 0) {
      const videoIds = candidates.map(c => c.videoId);
      const existing = await WatchedDB.checkMultiple(videoIds);

      const newRecords = [];
      for (const { card, videoId } of candidates) {
        if (existing[videoId]) continue;

        const title = getHistoryTitle(card);
        const channel = getHistoryChannel(card);
        const sectionDate = getHistorySectionDate(card) || Date.now();
        newRecords.push({
          videoId,
          title,
          channel: channel || '',
          watchedAt: sectionDate,
          firstWatchedAt: sectionDate,
          playCount: 0,
          source: 'history',
        });
      }

      if (newRecords.length > 0) {
        try {
          await WatchedDB.importData(newRecords);
          for (const r of newRecords) watchedCache.add(r.videoId);
          showImportToast(newRecords.length);
          added = newRecords.length;
          console.log(`[YT-Watched-Hider] Imported ${added} new videos from history`);
        } catch (e) {
          console.error('[YT-Watched-Hider] History batch import failed:', e);
        }
      }
    }

    if (removeProcessed) {
      for (const card of processedCards) card.remove();
    }

    return { added, scanned: processedCards.length };
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
    if (location.pathname === '/watch') {
      attachVideoEndedListener();
      startRecoPolling();
    } else {
      stopRecoPolling();
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
          WatchedDB.addWatched(videoId, title, 'seekbar', channel).then((res) => {
            if (res && res.isNew) showImportToast(1);
          }).catch(() => {});
          // If we couldn't extract title or channel from the card (some
          // layout variants expose neither), schedule an oEmbed backfill
          // so the entry doesn't stay blank forever.
          if (!title || !channel) {
            try {
              chrome.runtime.sendMessage({
                type: 'FIX_CHANNELS',
                videoIds: [videoId],
                force: false
              }, () => { /* ignore */ });
            } catch (_e) { /* ignore */ }
          }
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

  // Shared selector for related video cards on watch pages (Queue All / Watch Later)
  const RELATED_CARD_SELECTORS =
    '#related ytd-compact-video-renderer, ' +
    '#related yt-lockup-view-model, ' +
    'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer, ' +
    'ytd-watch-next-secondary-results-renderer yt-lockup-view-model';

  // ===== Queue All feature =====
  // Adds a button on watch pages to bulk-enqueue all visible related videos.
  // Works by programmatically clicking each card's kebab menu, then "Add to queue".
  let queueAllBtn = null;
  let queueInProgress = false;
  let queueAbort = false;
  let queueBtnObserver = null;

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function findQueueableCards() {
    const cards = document.querySelectorAll(RELATED_CARD_SELECTORS);
    const out = [];
    for (const card of cards) {
      if (card.style.display === 'none') continue;
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
    const count = findQueueableCards().length;
    queueAllBtn.textContent = `⏭ キューに追加 (${count})`;
    queueAllBtn.disabled = count === 0;
    queueAllBtn.style.opacity = count === 0 ? '0.5' : '1';
  }

  async function onQueueAllClick() {
    if (queueInProgress) {
      queueAbort = true;
      queueAllBtn.textContent = '中止中...';
      return;
    }
    const cards = findQueueableCards();
    if (cards.length === 0) return;
    if (!confirm(`${cards.length}件の関連動画をキューに追加します。\n処理中YouTubeのメニューが順次開閉します。続行しますか？`)) return;

    queueInProgress = true;
    queueAbort = false;
    queueAllBtn.style.background = '#888';
    let success = 0, failed = 0;

    // Seed the queue with the currently playing video first, so related
    // videos get appended AFTER it (otherwise YouTube starts a new queue
    // with the first added video placed above the current one).
    try {
      queueAllBtn.textContent = '現在の動画をキューに追加中...';
      await seedQueueWithCurrentVideo();
      await sleep(200);
    } catch (e) {
      console.warn('[YT-Watched-Hider] seed queue error:', e);
    }

    for (let i = 0; i < cards.length; i++) {
      if (queueAbort) break;
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
    queueAllBtn.style.background = '#ff4444';
    queueAllBtn.textContent = `完了: ${success}件追加${failed ? ` / ${failed}件失敗` : ''}`;
    setTimeout(updateQueueButtonLabel, 3000);
  }

  function ensureQueueAllButton() {
    if (location.pathname !== '/watch') {
      if (queueBtnObserver) { queueBtnObserver.disconnect(); queueBtnObserver = null; }
      if (queueAllBtn) { queueAllBtn.remove(); queueAllBtn = null; }
      return;
    }
    // Insert right before the first visible related video card to avoid
    // inheriting weird flex/grid sizing from container elements.
    const firstCard = findWatchLaterAnchor();
    if (!firstCard) return;

    if (queueAllBtn && document.body.contains(queueAllBtn)) {
      // Re-position if parent changed (SPA nav, container swap) or first card moved
      if (queueAllBtn.parentNode !== firstCard.parentNode || queueAllBtn.nextSibling !== firstCard) {
        firstCard.parentNode.insertBefore(queueAllBtn, firstCard);
        if (queueBtnObserver) queueBtnObserver.disconnect();
        queueBtnObserver = new MutationObserver(onQueueBtnMutation);
        queueBtnObserver.observe(firstCard.parentNode, { childList: true });
      }
      updateQueueButtonLabel();
      return;
    }

    // Wrap button in a container with fixed styling to isolate from parent layout
    queueAllBtn = document.createElement('button');
    queueAllBtn.id = 'yt-watched-hider-queue-all';
    queueAllBtn.style.cssText = [
      'display:inline-block',
      'box-sizing:border-box',
      'margin:8px 12px 12px',
      'padding:8px 14px',
      'background:#ff4444',
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
      'text-overflow:ellipsis'
    ].join(';') + ';';
    queueAllBtn.addEventListener('click', onQueueAllClick);
    firstCard.parentNode.insertBefore(queueAllBtn, firstCard);
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

  function findWatchLaterableCards() {
    const currentVid = getCurrentVideoId();
    const cards = document.querySelectorAll(RELATED_CARD_SELECTORS);
    const out = [];
    for (const card of cards) {
      if (card.style.display === 'none') continue;
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
    const count = findWatchLaterableCards().length;
    watchLaterBtn.textContent = `後で見る (${count})`;
    watchLaterBtn.disabled = count === 0;
    watchLaterBtn.style.opacity = count === 0 ? '0.5' : '1';
  }

  async function onWatchLaterClick() {
    if (watchLaterInProgress) {
      watchLaterAbort = true;
      watchLaterBtn.textContent = '中止中...';
      return;
    }
    const cards = findWatchLaterableCards();
    if (cards.length === 0) return;
    if (!confirm(`${cards.length}件の動画を「後で見る」に追加します。\nメニューが順次開閉します。続行しますか？`)) return;

    watchLaterInProgress = true;
    watchLaterAbort = false;
    watchLaterBtn.style.background = '#555';
    let success = 0, failed = 0;

    for (let i = 0; i < cards.length; i++) {
      if (watchLaterAbort) break;
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
    watchLaterBtn.style.background = '#1565c0';
    watchLaterBtn.textContent = `完了: ${success}件追加${failed ? ` / ${failed}件失敗` : ''}`;
    setTimeout(updateWatchLaterButtonLabel, 4000);
  }

  function isWatchLaterSupportedPage() {
    return location.pathname === '/watch';
  }

  function findWatchLaterAnchor() {
    // /watch ページ専用: 関連動画の先頭（キューボタンの隣に置けるよう同じ親）
    return document.querySelector(
      'ytd-watch-next-secondary-results-renderer yt-lockup-view-model, ' +
      'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer, ' +
      '#related yt-lockup-view-model, ' +
      '#related ytd-compact-video-renderer'
    );
  }

  function ensureWatchLaterButton() {
    if (!isWatchLaterSupportedPage()) {
      if (watchLaterBtnObserver) { watchLaterBtnObserver.disconnect(); watchLaterBtnObserver = null; }
      if (watchLaterBtn) { watchLaterBtn.remove(); watchLaterBtn = null; }
      return;
    }

    const anchor = findWatchLaterAnchor();
    if (!anchor) return;

    if (watchLaterBtn && document.body.contains(watchLaterBtn)) {
      // /watch 以外では先頭カードが動くので再配置
      if (watchLaterBtn.nextSibling !== anchor && watchLaterBtn.parentNode !== anchor.parentNode) {
        anchor.parentNode.insertBefore(watchLaterBtn, anchor);
      } else if (watchLaterBtn.nextSibling !== anchor) {
        anchor.parentNode.insertBefore(watchLaterBtn, anchor);
      }
      updateWatchLaterButtonLabel();
      return;
    }

    watchLaterBtn = document.createElement('button');
    watchLaterBtn.id = 'yt-watched-hider-watch-later';
    watchLaterBtn.style.cssText = [
      'display:inline-block',
      'box-sizing:border-box',
      'margin:8px 8px 12px 0',
      'padding:8px 14px',
      'background:#1565c0',
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
      'text-overflow:ellipsis'
    ].join(';') + ';';
    watchLaterBtn.addEventListener('click', onWatchLaterClick);
    anchor.parentNode.insertBefore(watchLaterBtn, anchor);
    updateWatchLaterButtonLabel();

    if (watchLaterBtnObserver) watchLaterBtnObserver.disconnect();
    watchLaterBtnObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.removedNodes) {
          if (n === watchLaterBtn || (n.contains && n.contains(watchLaterBtn))) {
            watchLaterBtnObserver.disconnect();
            watchLaterBtnObserver = null;
            setTimeout(ensureWatchLaterButton, 100);
            return;
          }
        }
      }
    });
    watchLaterBtnObserver.observe(anchor.parentNode, { childList: true });
  }

  function startRecoPolling() {
    if (recoInterval) clearInterval(recoInterval);
    checkRecommendations();
    ensureQueueAllButton();
    ensureWatchLaterButton();
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
    if (queueBtnObserver) { queueBtnObserver.disconnect(); queueBtnObserver = null; }
    if (queueAllBtn) { queueAllBtn.remove(); queueAllBtn = null; }
  }

  // Initial processing
  if (location.pathname === '/watch') {
    attachVideoEndedListener();
    startRecoPolling();
  } else {
    setTimeout(ensureWatchLaterButton, 600);
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
        for (const record of message.data) {
          if (record.videoId) watchedCache.add(record.videoId);
        }
        processPage();
        sendResponse({ success: true, count });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    if (message.type === 'MERGE_IMPORT') {
      WatchedDB.mergeImport(message.data).then((result) => {
        for (const record of message.data) {
          if (record.videoId) watchedCache.add(record.videoId);
        }
        processPage();
        sendResponse({ success: true, added: result.added, skipped: result.skipped, total: result.total });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    if (message.type === 'DELETE_VIDEO') {
      WatchedDB.deleteOne(message.videoId).then(() => {
        watchedCache.delete(message.videoId);
        sendResponse({ success: true });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    if (message.type === 'FETCH_WATCH_HTML') {
      // Proxy fetch through the YouTube tab context so the request carries
      // real user cookies and looks like a normal page navigation. This
      // avoids the google.com/sorry bot-challenge that extension-origin
      // credentials:'omit' fetches trigger after a burst.
      (async () => {
        try {
          const url = `https://www.youtube.com/watch?v=${encodeURIComponent(message.videoId)}`;
          const res = await fetch(url);
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
          sendResponse({ success: false, reason: 'fetch-error', error: e.message });
        }
      })();
      return true;
    }

    if (message.type === 'MARK_CREDITS_CHECKED') {
      WatchedDB.markCreditsChecked(message.videoId).then(() => {
        sendResponse({ success: true });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    if (message.type === 'UPDATE_CREDITS') {
      WatchedDB.updateCredits(
        message.videoId,
        message.credits || {},
        !!message.force,
        message.creditsSource || ''
      ).then((didUpdate) => {
        sendResponse({ success: true, updated: !!didUpdate });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    if (message.type === 'UPDATE_TITLE_CHANNEL') {
      // Force-update title/channel for a given videoId (used by oEmbed correction).
      WatchedDB.updateTitleAndChannel(
        message.videoId,
        message.title || '',
        message.channel || '',
        !!message.force
      ).then((didUpdate) => {
        sendResponse({ success: true, updated: !!didUpdate });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
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

    if (message.type === 'CLEAR_DATA') {
      WatchedDB.clearAll().then(() => {
        watchedCache.clear();
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
    removeHarvestUI();
    chrome.runtime.onMessage.removeListener(onMessage);
    if (queueBtnObserver) { queueBtnObserver.disconnect(); queueBtnObserver = null; }
    if (queueAllBtn) { queueAllBtn.remove(); queueAllBtn = null; }
    if (watchLaterBtnObserver) { watchLaterBtnObserver.disconnect(); watchLaterBtnObserver = null; }
    if (watchLaterBtn) { watchLaterBtn.remove(); watchLaterBtn = null; }
  }

  return { cleanup };
})();
