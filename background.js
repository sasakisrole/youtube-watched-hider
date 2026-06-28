// Service Worker for YouTube Watched Hider
// Handles: tab URL monitoring, message passing, auto-backup

// Extract video ID from YouTube URL
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.pathname === '/watch') {
      return u.searchParams.get('v');
    }
  } catch (e) {
    // invalid URL
  }
  return null;
}

// Track which videos have been recorded this session to avoid duplicate writes
const recentlyRecorded = new Set();

// Listen for tab URL changes to detect video plays
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const videoId = extractVideoId(changeInfo.url);
    if (videoId && !recentlyRecorded.has(videoId)) {
      recentlyRecorded.add(videoId);
      chrome.tabs.sendMessage(tabId, {
        type: 'VIDEO_DETECTED',
        videoId
      }).catch(() => {});
    }
  }
});

// Clean up recentlyRecorded periodically to prevent memory growth
setInterval(() => {
  if (recentlyRecorded.size > 10000) {
    recentlyRecorded.clear();
  }
}, 60 * 60 * 1000);

// --- Auto-backup ---

const BACKUP_ALARM = 'auto-backup';

// Schedule daily backup at a fixed hour (default: 3:00 AM)
function scheduleDailyBackup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  // If 3:00 AM already passed today, schedule for tomorrow
  if (next <= now) next.setDate(next.getDate() + 1);
  const delayInMinutes = Math.max(1, Math.round((next - now) / 60000));

  chrome.alarms.create(BACKUP_ALARM, {
    delayInMinutes,
    periodInMinutes: 24 * 60
  });
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'yt-queue',
      title: 'キューに追加',
      contexts: ['link'],
      documentUrlPatterns: ['*://*.youtube.com/*'],
      targetUrlPatterns: ['*://*.youtube.com/watch?*'],
    });
    chrome.contextMenus.create({
      id: 'yt-watch-later',
      title: '後で見る',
      contexts: ['link'],
      documentUrlPatterns: ['*://*.youtube.com/*'],
      targetUrlPatterns: ['*://*.youtube.com/watch?*'],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  scheduleDailyBackup();
  createContextMenus();
  if (details.reason === 'install') {
    chrome.storage.local.set({ migrationV135Done: true });
  } else if (details.reason === 'update') {
    chrome.storage.local.get('migrationV135Done', (result) => {
      if (typeof result.migrationV135Done !== 'boolean') {
        chrome.storage.local.set({ migrationV135Done: false });
      }
    });
  }
  ensureOffscreenDocument().catch((e) => console.warn('[YT-Watched] offscreen init failed:', e.message));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get(BACKUP_ALARM, (alarm) => {
    if (!alarm) scheduleDailyBackup();
  });
  ensureOffscreenDocument().catch((e) => console.warn('[YT-Watched] offscreen startup failed:', e.message));
});

// Handle alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) {
    performAutoBackup();
  }
});

// --- Helper: send message to a YouTube tab with retry ---
// Tries each YouTube tab in order until one responds.
async function sendToYouTubeTab(message) {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  if (tabs.length === 0) throw new Error('No YouTube tab open');

  for (const tab of tabs) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, message);
      return result;
    } catch (e) {
      // This tab didn't respond, try next
    }
  }

  throw new Error('No YouTube tab responded');
}

const WATCH_HTML_CONCURRENCY = 2;
const WATCH_HTML_DELAY_MS = 500;
const WATCH_HTML_JITTER_MS = 200;
const fetchWatchHtmlQueue = [];
let fetchWatchHtmlActive = 0;
let fetchWatchHtmlAutoStopped = false;

function watchHtmlQueueSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function watchHtmlQueueDelay() {
  return WATCH_HTML_DELAY_MS + Math.floor(Math.random() * WATCH_HTML_JITTER_MS);
}

function finishFetchWatchHtmlEntry(entry, result) {
  entry.resolve({
    ...result,
    videoId: entry.videoId,
    source: entry.source,
  });
}

function drainFetchWatchHtmlQueue(reason) {
  while (fetchWatchHtmlQueue.length) {
    const entry = fetchWatchHtmlQueue.shift();
    finishFetchWatchHtmlEntry(entry, { ok: false, reason });
  }
}

function resetFetchWatchHtmlAutoStopIfIdle() {
  if (fetchWatchHtmlAutoStopped && fetchWatchHtmlActive === 0 && fetchWatchHtmlQueue.length === 0) {
    fetchWatchHtmlAutoStopped = false;
  }
}

function stopFetchWatchHtmlQueue(reason) {
  fetchWatchHtmlAutoStopped = true;
  drainFetchWatchHtmlQueue(reason);
}

function pumpFetchWatchHtmlQueue() {
  if (fetchWatchHtmlAutoStopped) {
    drainFetchWatchHtmlQueue('sorry-redirect');
    resetFetchWatchHtmlAutoStopIfIdle();
    return;
  }

  while (fetchWatchHtmlActive < WATCH_HTML_CONCURRENCY && fetchWatchHtmlQueue.length) {
    const entry = fetchWatchHtmlQueue.shift();
    fetchWatchHtmlActive++;
    runFetchWatchHtmlEntry(entry);
  }
}

async function runFetchWatchHtmlEntry(entry) {
  let result;
  try {
    if (entry.abortSignal && entry.abortSignal.aborted) {
      result = { ok: false, reason: 'aborted', aborted: true };
    } else {
      let resp;
      try {
        resp = await sendToYouTubeTab({ type: 'FETCH_WATCH_HTML', videoId: entry.videoId });
      } catch (_e) {
        result = { ok: false, reason: 'no-youtube-tab' };
      }
      if (!result) {
        if (!resp || !resp.success) {
          result = {
            ok: false,
            reason: (resp && resp.reason) || 'proxy-failed',
            finalUrl: (resp && resp.finalUrl) || '',
            error: (resp && resp.error) || '',
          };
        } else {
          result = {
            ok: true,
            html: resp.html || '',
            finalUrl: resp.finalUrl || '',
          };
        }
      }
    }
  } catch (e) {
    result = { ok: false, reason: 'fetch-error', error: e.message };
  }

  if (result.reason === 'sorry-redirect') {
    stopFetchWatchHtmlQueue('sorry-redirect');
  }
  finishFetchWatchHtmlEntry(entry, result);
  if (fetchWatchHtmlQueue.length && !fetchWatchHtmlAutoStopped && !result.aborted) {
    await watchHtmlQueueSleep(watchHtmlQueueDelay());
  }
  fetchWatchHtmlActive--;
  pumpFetchWatchHtmlQueue();
  resetFetchWatchHtmlAutoStopIfIdle();
}

function fetchWatchHtmlQueued(videoId, source, abortSignal) {
  resetFetchWatchHtmlAutoStopIfIdle();
  return new Promise((resolve) => {
    const entry = { videoId, source, abortSignal, resolve };
    if (abortSignal && abortSignal.aborted) {
      finishFetchWatchHtmlEntry(entry, { ok: false, reason: 'aborted', aborted: true });
      return;
    }
    if (fetchWatchHtmlAutoStopped) {
      finishFetchWatchHtmlEntry(entry, { ok: false, reason: 'sorry-redirect' });
      return;
    }
    fetchWatchHtmlQueue.push(entry);
    pumpFetchWatchHtmlQueue();
  });
}

// --- Offscreen DB owner ---
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreenDocument = null;
let v135MigrationInProgress = false;
let v135MigrationTimer = null;

function setV135MigrationInProgress(value) {
  v135MigrationInProgress = value;
  if (v135MigrationTimer) {
    clearTimeout(v135MigrationTimer);
    v135MigrationTimer = null;
  }
  if (value) {
    v135MigrationTimer = setTimeout(() => {
      v135MigrationInProgress = false;
      v135MigrationTimer = null;
    }, 2 * 60 * 1000);
  }
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (contexts.length > 0) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['BLOBS'],
      justification: 'Keep IndexedDB ownership and export preparation in an extension offscreen document.',
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function sendToOffscreenDb(op, payload = {}) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen-db',
    op,
    ...payload,
  });
  if (!response || !response.success) {
    throw new Error((response && response.error) || 'Offscreen DB did not respond');
  }
  return response.result;
}

function storageLocalGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageLocalSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function exportDataEnvelope(source = 'manual') {
  const { likedSyncMeta } = await storageLocalGet({ likedSyncMeta: null });
  const appVersion = chrome.runtime.getManifest().version;
  return sendToOffscreenDb('EXPORT_DATA', {
    source,
    likedSyncMeta,
    appVersion,
  });
}

function getManualExportFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `yt-watched-${yyyy}-${mm}-${dd}.json`;
}

async function createExportBlobUrl(source = 'manual') {
  const { likedSyncMeta } = await storageLocalGet({ likedSyncMeta: null });
  const appVersion = chrome.runtime.getManifest().version;
  return sendToOffscreenDb('OFFSCREEN_CREATE_EXPORT_BLOB', {
    source,
    likedSyncMeta,
    appVersion,
  });
}

async function revokeExportBlobUrl(blobInfo) {
  if (!blobInfo || !blobInfo.blobUrl) return;
  try {
    await sendToOffscreenDb('OFFSCREEN_REVOKE_BLOB', {
      requestId: blobInfo.requestId,
      blobUrl: blobInfo.blobUrl,
    });
  } catch (e) {
    console.warn('[YT-Watched] Blob URL revoke failed:', e.message);
  }
}

function downloadUrl(url, filename, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      conflictAction: options.conflictAction || 'uniquify',
      saveAs: !!options.saveAs,
    }, (downloadId) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (typeof downloadId !== 'number') {
        reject(new Error('chrome.downloads.download returned no downloadId'));
        return;
      }
      resolve(downloadId);
    });
  });
}

function waitForDownloadSettled(downloadId) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve({ state: 'unknown', timedOut: true });
    }, 5 * 60 * 1000);

    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      const state = delta.state.current;
      if (state !== 'complete' && state !== 'interrupted') return;
      clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve({ state });
    }

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }, (items) => {
      const state = items && items[0] && items[0].state;
      if (state === 'complete' || state === 'interrupted') {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve({ state });
      }
    });
  });
}

function getExportCount(blobInfo) {
  const counts = blobInfo && blobInfo.counts ? blobInfo.counts : {};
  return {
    watchedVideos: counts.watchedVideos || 0,
    likedVideos: counts.likedVideos || 0,
    total: (counts.watchedVideos || 0) + (counts.likedVideos || 0),
  };
}

async function downloadExportJson({ source, filename, conflictAction = 'uniquify', saveAs = false }) {
  let blobInfo = null;
  try {
    blobInfo = await createExportBlobUrl(source);
    const counts = getExportCount(blobInfo);
    if (counts.total === 0) {
      await revokeExportBlobUrl(blobInfo);
      return { success: false, reason: 'no_data', counts, count: 0 };
    }

    const downloadId = await downloadUrl(blobInfo.blobUrl, filename, { conflictAction, saveAs });
    const settled = await waitForDownloadSettled(downloadId);
    await revokeExportBlobUrl(blobInfo);

    if (settled.state === 'interrupted') {
      return { success: false, reason: 'download_interrupted', downloadId, counts, count: counts.watchedVideos };
    }
    if (settled.timedOut) {
      return { success: false, reason: 'download_state_timeout', downloadId, counts, count: counts.watchedVideos };
    }

    return {
      success: true,
      downloadId,
      counts,
      count: counts.watchedVideos,
      exportedAt: blobInfo.exportedAt,
    };
  } catch (e) {
    if (blobInfo) await revokeExportBlobUrl(blobInfo);
    const message = e.message || String(e);
    return { success: false, reason: message, error: message, errorType: 'download_error', count: 0 };
  }
}

function summarizeBackupError(result) {
  if (!result) return 'unknown';
  if (result.error) return result.error;
  return result.reason || 'unknown';
}

async function storeImportedMeta(result) {
  if (result && result.likedSyncMeta) {
    await storageLocalSet({ likedSyncMeta: result.likedSyncMeta });
  }
}

function broadcastToYouTubeTabs(message) {
  chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

function broadcastCacheInvalidated(detail = {}) {
  const mode = detail.mode || (detail.clear ? 'reload' : 'patch');
  broadcastToYouTubeTabs({ type: 'CACHE_INVALIDATED', ...detail, mode });
}

async function getContentCacheStats() {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CACHE_STATS' });
      if (response && response.success) return response;
    } catch (_e) {
      // Try next YouTube tab.
    }
  }
  return null;
}

// --- Enrich Credits external lookup helpers ---
// Test-case mapping for DESIGN_enrich_credits.md:
// Case 2-4 are enforced by parseUtanetArtistSongs + history-side similarity thresholding.
// Case 5 is enforced by runEnrichRateLimited, which serializes each source at >=1s/request.
// Case 7 is enforced by returning empty song/candidate payloads without creating tabs.
const ENRICH_RATE_LIMIT_MS = 1000;
const ENRICH_FETCH_TIMEOUT_MS = 30000;
const ENRICH_MB_USER_AGENT = 'yt-watched-hider/1.40.0 (https://github.com/sasakisrole/youtube-watched-hider)';
const enrichRateState = {
  utanet: { lastStartedAt: 0, queue: Promise.resolve() },
  mb: { lastStartedAt: 0, queue: Promise.resolve() },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runEnrichRateLimited(source, task) {
  const state = enrichRateState[source];
  if (!state) return task();

  const run = async () => {
    const now = Date.now();
    const waitMs = Math.max(0, ENRICH_RATE_LIMIT_MS - (now - state.lastStartedAt));
    if (waitMs > 0) await sleep(waitMs);
    state.lastStartedAt = Date.now();
    return task();
  };

  const next = state.queue.catch(() => {}).then(run);
  state.queue = next.catch(() => {});
  return next;
}

async function fetchEnrichText(source, url, headers = {}) {
  return runEnrichRateLimited(source, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENRICH_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { text, status: response.status, finalUrl: response.url || url };
    } finally {
      clearTimeout(timer);
    }
  });
}

async function fetchEnrichJson(source, url, headers = {}) {
  const result = await fetchEnrichText(source, url, headers);
  return JSON.parse(result.text);
}

function decodeHtmlEntities(value) {
  const entityMap = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'",
  };
  return String(value || '').replace(/&#(\d+);|&#x([0-9a-fA-F]+);|&([a-zA-Z][a-zA-Z0-9]+);/g, (_m, dec, hex, named) => {
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return Object.prototype.hasOwnProperty.call(entityMap, named) ? entityMap[named] : `&${named};`;
  });
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCreditLookupText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s*-\s*Topic\s*$/i, '')
    .replace(/[\s・･.\-_!?！？♪♥'"`/\\()[\]{}<>:;,\u3000]+/g, '')
    .toLowerCase();
}

function sequenceRatio(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const prev = new Array(b.length + 1).fill(0);
  const curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}

function extractHtmlCells(rowHtml) {
  const cells = [];
  const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let match;
  while ((match = cellRe.exec(rowHtml))) cells.push(match[1]);
  return cells;
}

function parseUtanetArtistLinks(html, keyword) {
  const raw = [];
  const linkRe = /<a\b[^>]*href=["']\/artist\/(\d+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html))) {
    const id = match[1];
    const name = stripHtml(match[2]);
    if (!id || !name || name.length > 120) continue;
    raw.push({ id, name });
  }

  const seen = new Set();
  const keywordNorm = normalizeCreditLookupText(keyword);
  return raw
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map((item) => {
      const nameNorm = normalizeCreditLookupText(item.name);
      const score = keywordNorm && nameNorm
        ? (nameNorm === keywordNorm ? 1 : sequenceRatio(keywordNorm, nameNorm))
        : 0;
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score);
}

function extractUtanetTitle(titleCell, hatsuCell) {
  const titleSpan = titleCell.match(/<span\b[^>]*class=["'][^"']*songlist-title[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  const linkText = titleCell.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
  let title = stripHtml(titleSpan ? titleSpan[1] : (linkText ? linkText[1] : titleCell));
  const hatsu = stripHtml(hatsuCell || '');
  if (hatsu && title.endsWith(hatsu)) {
    title = title.slice(0, -hatsu.length).trim();
  }
  return title;
}

function parseUtanetArtistSongs(html) {
  const songs = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(html))) {
    const table = tableMatch[0];
    if (!table.includes('曲名') || !table.includes('作曲者名')) continue;
    const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 2) continue;
    const headers = extractHtmlCells(rows[0]).map(stripHtml);
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });
    if (idx['曲名'] == null || idx['作曲者名'] == null) continue;

    for (const row of rows.slice(1)) {
      const cells = extractHtmlCells(row);
      if (cells.length < headers.length) continue;
      const titleCell = cells[idx['曲名']] || '';
      const href = (titleCell.match(/href=["']([^"']+)["']/i) || [])[1] || '';
      const title = extractUtanetTitle(titleCell, cells[idx['歌い出し']] || '');
      if (!title) continue;
      songs.push({
        title,
        songUrl: href,
        lyricist: stripHtml(cells[idx['作詞者名']] || ''),
        composer: stripHtml(cells[idx['作曲者名']] || ''),
        arranger: idx['編曲者名'] == null ? '' : stripHtml(cells[idx['編曲者名']] || ''),
      });
    }
  }
  return songs;
}

async function enrichCreditsFetchUtanet(artist) {
  const keyword = String(artist || '').replace(/\s*-\s*Topic\s*$/i, '').trim();
  if (!keyword) return { success: false, reason: 'empty-artist', songs: [] };

  const searchUrl = `https://www.uta-net.com/search/?Aselect=1&Bselect=4&Keyword=${encodeURIComponent(keyword)}`;
  const search = await fetchEnrichText('utanet', searchUrl, {
    Accept: 'text/html,application/xhtml+xml',
  });
  const links = parseUtanetArtistLinks(search.text, keyword);
  if (!links.length) {
    const directSongs = parseUtanetArtistSongs(search.text);
    return {
      success: true,
      artist: keyword,
      searchedUrl: searchUrl,
      selectedArtist: null,
      artistCandidates: [],
      songs: directSongs,
    };
  }

  const selectedArtist = links[0];
  const detailUrl = `https://www.uta-net.com/artist/${encodeURIComponent(selectedArtist.id)}/`;
  const detail = await fetchEnrichText('utanet', detailUrl, {
    Accept: 'text/html,application/xhtml+xml',
  });
  return {
    success: true,
    artist: keyword,
    searchedUrl: searchUrl,
    selectedArtist,
    artistCandidates: links.slice(0, 10),
    songs: parseUtanetArtistSongs(detail.text),
  };
}

const MB_SUFFIX_PATTERNS = [
  /\s*[-–—]\s*Live\s*\d{0,4}.*$/i,
  /\s*[-–—]\s*Live at .*$/i,
  /\s*[-–—]\s*Remix.*$/i,
  /\s*[-–—]\s*Instrumental.*$/i,
  /\s*[-–—]\s*Off\s*Vocal.*$/i,
  /\s*[-–—]\s*Acoustic.*$/i,
  /\s*[-–—]\s*[\w\s]*Style.*$/i,
  /\s*〜.*?〜\s*$/i,
  /\s*~.*?~\s*$/i,
  /\s*feat[.\s].*$/i,
  /\s*ft[.\s].*$/i,
  /\s*\(feat[^)]*\)/i,
  /\s*\[.*?]\s*$/i,
  /\s*【.*?】\s*$/i,
  /\s*（.*?）\s*$/i,
  /\s*\(.*?\)\s*$/i,
];

function cleanMbTitle(title) {
  let value = String(title || '');
  for (let pass = 0; pass < 3; pass++) {
    const prev = value;
    for (const pattern of MB_SUFFIX_PATTERNS) value = value.replace(pattern, '');
    if (value === prev) break;
  }
  return value.replace(/^[\s-–—]+|[\s-–—]+$/g, '');
}

async function mbGet(path, params) {
  const query = new URLSearchParams(params);
  const url = `https://musicbrainz.org/ws/2/${path}?${query.toString()}`;
  return fetchEnrichJson('mb', url, {
    Accept: 'application/json',
    'User-Agent': ENRICH_MB_USER_AGENT,
  });
}

function collectMbRole(roles, rel) {
  const type = rel && rel.type;
  if (!Object.prototype.hasOwnProperty.call(roles, type)) return;
  const name = rel.artist && rel.artist.name;
  if (name) roles[type].add(name);
}

async function getMbRecordingRoles(recordingId) {
  const full = await mbGet(`recording/${encodeURIComponent(recordingId)}`, {
    inc: 'work-rels+artist-rels',
    fmt: 'json',
  });
  const roles = {
    composer: new Set(),
    lyricist: new Set(),
    arranger: new Set(),
  };
  const workIds = new Set();
  for (const rel of full.relations || []) {
    collectMbRole(roles, rel);
    if (rel.work && rel.work.id) workIds.add(rel.work.id);
  }
  for (const workId of Array.from(workIds).slice(0, 3)) {
    const work = await mbGet(`work/${encodeURIComponent(workId)}`, {
      inc: 'artist-rels',
      fmt: 'json',
    });
    for (const rel of work.relations || []) collectMbRole(roles, rel);
  }
  return {
    composer: Array.from(roles.composer).sort(),
    lyricist: Array.from(roles.lyricist).sort(),
    arranger: Array.from(roles.arranger).sort(),
  };
}

function hasAnyMbRole(roles) {
  return !!(roles && (roles.composer.length || roles.lyricist.length || roles.arranger.length));
}

function joinMbRoles(values) {
  return Array.isArray(values) ? values.join('・') : '';
}

function mbArtistMatches(artist, recording) {
  const target = normalizeCreditLookupText(artist);
  const credits = recording['artist-credit'] || [];
  return credits.some((credit) => {
    const names = [credit.name, credit.artist && credit.artist.name].filter(Boolean);
    return names.some((name) => {
      const norm = normalizeCreditLookupText(name);
      return norm && (norm.includes(target) || target.includes(norm) || sequenceRatio(target, norm) >= 0.7);
    });
  });
}

async function enrichCreditsLookupMb(artist, title) {
  const cleanArtist = String(artist || '').replace(/\s*-\s*Topic\s*$/i, '').trim();
  const cleanTitle = cleanMbTitle(title);
  if (!cleanArtist || !cleanTitle) return { success: false, reason: 'empty-query' };

  const strictQuery = `artist:"${cleanArtist}" AND recording:"${cleanTitle}"`;
  const strict = await mbGet('recording/', { query: strictQuery, fmt: 'json', limit: '5' });
  let chosen = null;
  let stage = '';
  const strictRecordings = strict.recordings || [];
  if (strictRecordings.length && Number(strictRecordings[0].score || 0) >= 90) {
    chosen = strictRecordings[0];
    stage = 'strict';
  } else {
    const titleOnly = await mbGet('recording/', { query: `recording:"${cleanTitle}"`, fmt: 'json', limit: '10' });
    for (const recording of titleOnly.recordings || []) {
      if (mbArtistMatches(cleanArtist, recording)) {
        chosen = recording;
        stage = 'fuzzy';
        break;
      }
    }
    if (!chosen && titleOnly.recordings && titleOnly.recordings.length) {
      const top = titleOnly.recordings[0];
      const sim = sequenceRatio(normalizeCreditLookupText(top.title || ''), normalizeCreditLookupText(cleanTitle));
      if (sim >= 0.85) {
        chosen = top;
        stage = 'title-only';
      }
    }
  }

  if (!chosen || !chosen.id) {
    return { success: true, artist: cleanArtist, title: cleanTitle, candidate: null, reason: 'no-recording' };
  }

  const roles = await getMbRecordingRoles(chosen.id);
  if (!hasAnyMbRole(roles)) {
    return { success: true, artist: cleanArtist, title: cleanTitle, candidate: null, reason: 'no-roles' };
  }
  const sim = sequenceRatio(normalizeCreditLookupText(cleanTitle), normalizeCreditLookupText(chosen.title || ''));
  return {
    success: true,
    artist: cleanArtist,
    title: cleanTitle,
    candidate: {
      composer: joinMbRoles(roles.composer),
      lyricist: joinMbRoles(roles.lyricist),
      arranger: joinMbRoles(roles.arranger),
      mbid: chosen.id,
      mbTitle: chosen.title || '',
      stage,
      score: chosen.score || 0,
      sim,
    },
  };
}

// Generate backup filename with date (e.g. yt-watched-backup-2026-04-03.json)
function getBackupFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `yt-watched-backup-${yyyy}-${mm}-${dd}.json`;
}

// Returns a promise with the backup result for callers that need feedback.
async function performAutoBackup(options = {}) {
  const source = options.source || 'auto';
  const respectEnabled = options.respectEnabled !== false;
  const settings = await storageLocalGet({ autoBackup: true });
  if (respectEnabled && !settings.autoBackup) {
    return { success: false, reason: 'disabled' };
  }

  const result = await downloadExportJson({
    source,
    filename: getBackupFilename(),
    conflictAction: 'overwrite',
    saveAs: false,
  });

  if (result.success) {
    await storageLocalSet({
      lastBackup: Date.now(),
      lastBackupCount: result.count,
      lastBackupError: null,
    });
    console.log('[YT-Watched] Backup completed:', result.count, 'watched records');
    return result;
  }

  const error = summarizeBackupError(result);
  if (result.reason !== 'disabled') {
    await storageLocalSet({ lastBackupError: error });
  }
  console.warn('[YT-Watched] Backup failed:', error);
  return result;
}

// Context menu click handler
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const videoId = extractVideoId(info.linkUrl);
  if (!videoId) return;

  const type = info.menuItemId === 'yt-queue' ? 'QUEUE_VIDEO' : 'WATCH_LATER_VIDEO';
  chrome.tabs.sendMessage(tab.id, { type, videoId }).catch(() => {});
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DB_RPC') {
    sendToOffscreenDb(message.op, message)
      .then((result) => sendResponse({ success: true, result }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'V135_CONTENT_READY') {
    chrome.storage.local.get({ migrationV135Done: false }, (result) => {
      const run = !result.migrationV135Done && !v135MigrationInProgress && sender.tab && sender.tab.id;
      if (run) setV135MigrationInProgress(true);
      sendResponse({ run: !!run });
    });
    return true;
  }

  if (message.type === 'V135_LEGACY_EXPORT') {
    (async () => {
      try {
        const payload = message.payload || {};
        if (!payload.success) {
          setV135MigrationInProgress(false);
          sendResponse({ success: false, error: payload.error || 'legacy-export-failed' });
          return;
        }
        const result = await sendToOffscreenDb('IMPORT_LEGACY_V135', {
          watched: payload.watched || [],
          liked: payload.liked || [],
        });
        await chrome.storage.local.set({
          migrationV135Done: true,
          migrationV135CompletedAt: Date.now(),
          migrationV135Counts: result,
        });
        setV135MigrationInProgress(false);
        broadcastCacheInvalidated({ reason: 'migration-v135', mode: 'reload' });
        console.info('[YT-Watched] v1.35 migration completed:', result);
        sendResponse({ success: true, ...result });
      } catch (e) {
        setV135MigrationInProgress(false);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'GET_STATS') {
    (async () => {
      const [stats, cacheStats] = await Promise.all([
        sendToOffscreenDb('GET_STATS'),
        getContentCacheStats().catch(() => null),
      ]);
      const cache = cacheStats || {};
      const positiveCacheSize = typeof cache.positiveCacheSize === 'number' ? cache.positiveCacheSize : 0;
      sendResponse({
        ...stats,
        dbStatus: 'ready',
        dbOwner: 'offscreen',
        cacheMode: cache.cacheMode || 'error',
        positiveCacheSize,
        recentCacheSize: typeof cache.recentCacheSize === 'number' ? cache.recentCacheSize : 0,
        cacheLoadTime: typeof cache.cacheLoadTime === 'number' ? cache.cacheLoadTime : 0,
        cacheLoadedPages: typeof cache.cacheLoadedPages === 'number' ? cache.cacheLoadedPages : 0,
        cacheSize: positiveCacheSize,
        cacheUnavailable: !cacheStats,
      });
    })()
      .catch((e) => sendResponse({
        count: 0,
        dbStatus: 'error',
        cacheMode: 'error',
        positiveCacheSize: 0,
        recentCacheSize: 0,
        cacheLoadTime: 0,
        cacheLoadedPages: 0,
        cacheSize: 0,
        error: e.message,
      }));
    return true;
  }

  if (message.type === 'EXPORT_DATA') {
    exportDataEnvelope(message.source || 'manual')
      .then((data) => sendResponse(data || { records: [] }))
      .catch((e) => sendResponse({ __error: true, message: e.message || String(e) }));
    return true;
  }

  if (message.type === 'EXPORT_DOWNLOAD') {
    downloadExportJson({
      source: message.source || 'manual',
      filename: message.filename || getManualExportFilename(),
      conflictAction: message.conflictAction || 'uniquify',
      saveAs: !!message.saveAs,
    }).then(sendResponse);
    return true;
  }

  if (message.type === 'IMPORT_DATA') {
    sendToOffscreenDb('IMPORT_DATA', { data: message.data })
      .then(async (result) => {
        await storeImportedMeta(result);
        const addedIds = Array.isArray(result.watchedIds) ? result.watchedIds : [];
        broadcastCacheInvalidated({
          reason: 'import',
          mode: addedIds.length > 10000 ? 'reload' : 'patch',
          addedIds,
        });
        sendResponse({ success: true, ...result, count: result.count || 0 });
      })
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'MERGE_IMPORT') {
    sendToOffscreenDb('MERGE_IMPORT', { data: message.data })
      .then(async (result) => {
        await storeImportedMeta(result);
        broadcastCacheInvalidated({ reason: 'merge-import', mode: 'reload' });
        sendResponse({ success: true, ...result });
      })
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'DELETE_VIDEO') {
    sendToOffscreenDb('DELETE_VIDEO', { videoId: message.videoId })
      .then(() => {
        broadcastCacheInvalidated({ reason: 'delete', mode: 'patch', deletedIds: [message.videoId] });
        sendResponse({ success: true });
      })
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'CLEAR_DATA') {
    sendToOffscreenDb('CLEAR_DATA')
      .then(() => {
        broadcastCacheInvalidated({ reason: 'clear', mode: 'reload', clear: true });
        sendResponse({ success: true });
      })
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'SYNC_LIKED') {
    syncLikedPlaylist({ confirmAccountChange: !!message.confirmAccountChange })
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_LIKED') {
    sendToOffscreenDb('GET_LIKED')
      .then((rows) => sendResponse({ success: true, rows }))
      .catch((e) => sendResponse({ success: false, error: e.message, rows: [] }));
    return true;
  }

  if (message.type === 'GET_LIKED_STATS') {
    sendToOffscreenDb('GET_LIKED_STATS')
      .then((stats) => sendResponse({ success: true, ...stats }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'CLEAR_LIKED') {
    sendToOffscreenDb('CLEAR_LIKED', { accountId: message.accountId || '' })
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_LIKED_META') {
    chrome.storage.local.get({ likedSyncMeta: null }, (r) => {
      sendResponse({ success: true, meta: r.likedSyncMeta });
    });
    return true;
  }

  if (message.type === 'GET_ENABLED') {
    chrome.storage.local.get({
      enabled: true,
      recordWhileOff: false,
      hideShorts: false,
      hideMovies: false,
      harvestMode: false,
      autoBackup: true,
      lastBackup: null,
      lastBackupCount: 0,
      lastBackupError: null,
      migrationV135Done: false
    }, (result) => {
      // Include next backup schedule
      chrome.alarms.get(BACKUP_ALARM, (alarm) => {
        result.nextBackup = alarm ? alarm.scheduledTime : null;
        sendResponse(result);
      });
    });
    return true;
  }

  if (message.type === 'SET_ENABLED') {
    chrome.storage.local.set({ enabled: message.enabled }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'ENABLED_CHANGED',
            enabled: message.enabled
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_HIDE_MOVIES') {
    chrome.storage.local.set({ hideMovies: message.hideMovies }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'HIDE_MOVIES_CHANGED',
            hideMovies: message.hideMovies
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_HARVEST_MODE') {
    chrome.storage.local.set({ harvestMode: message.harvestMode }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'HARVEST_MODE_CHANGED',
            harvestMode: message.harvestMode
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_HIDE_SHORTS') {
    chrome.storage.local.set({ hideShorts: message.hideShorts }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'HIDE_SHORTS_CHANGED',
            hideShorts: message.hideShorts
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_RECORD_WHILE_OFF') {
    chrome.storage.local.set({ recordWhileOff: message.recordWhileOff }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'RECORD_WHILE_OFF_CHANGED',
            recordWhileOff: message.recordWhileOff
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_AUTO_BACKUP') {
    chrome.storage.local.set({ autoBackup: message.autoBackup }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'BACKUP_NOW') {
    performAutoBackup({ source: 'backup-now', respectEnabled: false }).then(sendResponse);
    return true;
  }

  if (message.type === 'enrichCreditsUtanet') {
    enrichCreditsFetchUtanet(message.artist || '')
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, reason: 'fetch-error', error: e.message, songs: [] }));
    return true;
  }

  if (message.type === 'enrichCreditsMb') {
    enrichCreditsLookupMb(message.artist || '', message.title || '')
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, reason: 'fetch-error', error: e.message }));
    return true;
  }

  if (message.type === 'FIX_CHANNELS') {
    // message.videoIds: string[]
    // message.force: boolean (overwrite existing non-empty channel/title)
    fixChannelsBatch(message.videoIds || [], !!message.force)
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'FIX_DURATIONS') {
    fixDurationsBatch(message.videoIds || [])
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

// --- oEmbed-based channel correction ---
// YouTube oEmbed endpoint returns {title, author_name, ...} with no auth.
// We throttle concurrency to avoid rate limiting.
async function fetchOEmbed(videoId) {
  try {
    // IMPORTANT: the `url` query parameter value must itself be URL-encoded,
    // otherwise YouTube oEmbed returns non-200 (typically 401/404).
    const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return { videoId, ok: false, status: res.status };
    const json = await res.json();
    return {
      videoId,
      ok: true,
      title: json.title || '',
      channel: json.author_name || ''
    };
  } catch (e) {
    return { videoId, ok: false, error: e.message };
  }
}

// Fallback: fetch the watch page HTML and extract metadata from
// ytInitialPlayerResponse. Works for videos where embedding is disabled
// (oEmbed returns 401/403 for those).
function decodeJsonStringLiteral(s) {
  try { return JSON.parse('"' + s + '"'); } catch { return s; }
}

function extractJsonObjectAfter(text, startIndex) {
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

function parseInitialPlayerResponse(html) {
  const markers = ['ytInitialPlayerResponse =', 'ytInitialPlayerResponse='];
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const json = extractJsonObjectAfter(html, idx + marker.length);
    if (!json) continue;
    try { return JSON.parse(json); } catch (_e) { /* try next marker */ }
  }
  return null;
}

function parseDurationFromWatchHtml(html) {
  if (!html) return { ok: false, reason: 'empty-html' };
  const playerResponse = parseInitialPlayerResponse(html);
  const details = playerResponse && playerResponse.videoDetails;
  if (details) {
    if (details.isLiveContent === true) {
      return { ok: true, durationSec: -1, isLive: true };
    }
    const durationSec = Number(details.lengthSeconds);
    if (Number.isFinite(durationSec) && durationSec > 0) {
      return { ok: true, durationSec: Math.round(durationSec), isLive: false };
    }
  }
  const playabilityStatus = playerResponse && playerResponse.playabilityStatus;
  if (playabilityStatus && playabilityStatus.status && playabilityStatus.status !== 'OK') {
    return { ok: false, reason: 'playability-' + String(playabilityStatus.status).toLowerCase() };
  }
  const liveMatch = html.match(/"isLiveContent"\s*:\s*(true|false)/);
  if (liveMatch && liveMatch[1] === 'true') return { ok: true, durationSec: -1, isLive: true };
  const lengthMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
  if (lengthMatch) {
    const durationSec = Number(lengthMatch[1]);
    if (Number.isFinite(durationSec) && durationSec > 0) {
      return { ok: true, durationSec, isLive: false };
    }
  }
  return { ok: false, reason: 'no-duration' };
}

async function fetchDurationFromWatch(videoId, abortSignal) {
  const resp = await fetchWatchHtmlQueued(videoId, 'fix-durations', abortSignal);
  if (resp.aborted) return { videoId, ok: false, reason: 'aborted', aborted: true };
  if (!resp.ok) return { videoId, ok: false, reason: resp.reason || 'proxy-failed' };
  const parsed = parseDurationFromWatchHtml(resp.html || '');
  return { videoId, ...parsed };
}

async function fetchWatchPageMeta(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return { videoId, ok: false, status: res.status };
    const html = await res.text();

    // Try ytInitialPlayerResponse.videoDetails first (most reliable).
    // Look for: "title":"...","...":"...","author":"..."
    // Scoped within a videoDetails block.
    const vdStart = html.indexOf('"videoDetails":{');
    if (vdStart !== -1) {
      const slice = html.slice(vdStart, vdStart + 4000);
      const titleMatch = slice.match(/"title":"((?:\\.|[^"\\])*)"/);
      const authorMatch = slice.match(/"author":"((?:\\.|[^"\\])*)"/);
      const title = titleMatch ? decodeJsonStringLiteral(titleMatch[1]) : '';
      const channel = authorMatch ? decodeJsonStringLiteral(authorMatch[1]) : '';
      if (title || channel) {
        return { videoId, ok: true, title, channel };
      }
    }

    // Fallback: og:title meta tag (title only).
    const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
    if (ogTitle) {
      return { videoId, ok: true, title: ogTitle[1], channel: '' };
    }

    return { videoId, ok: false, status: 'no-metadata' };
  } catch (e) {
    return { videoId, ok: false, error: e.message };
  }
}

// Unified fetch: try oEmbed, fall back to watch page HTML on failure.
async function fetchVideoMeta(videoId) {
  const oe = await fetchOEmbed(videoId);
  if (oe.ok && (oe.title || oe.channel)) return oe;
  const wp = await fetchWatchPageMeta(videoId);
  if (wp.ok) return wp;
  console.warn('[YT-Watched] metadata fetch failed:', videoId,
    'oEmbed=', oe.status || oe.error, 'watchPage=', wp.status || wp.error);
  return { videoId, ok: false };
}

async function fixChannelsBatch(videoIds, force, onProgress) {
  if (!videoIds.length) return { success: true, updated: 0, failed: 0, total: 0 };

  const CONCURRENCY = 5;
  let updated = 0;
  let failed = 0;
  let processed = 0;
  let idx = 0;

  async function worker() {
    while (idx < videoIds.length) {
      const vid = videoIds[idx++];
      const result = await fetchVideoMeta(vid);
      let wasUpdated = false;
      if (!result.ok || (!result.title && !result.channel)) {
        failed++;
      } else {
        try {
          const didUpdate = await sendToOffscreenDb('UPDATE_TITLE_CHANNEL', {
            videoId: vid,
            title: result.title,
            channel: result.channel,
            force: force
          });
          if (didUpdate) {
            updated++;
            wasUpdated = true;
          }
        } catch (_e) {
          failed++;
        }
      }
      processed++;
      if (onProgress) {
        try {
          onProgress({
            videoId: vid,
            processed,
            updated,
            failed,
            total: videoIds.length,
            channel: result.channel || '',
            title: result.title || '',
            wasUpdated
          });
        } catch (_e) { /* ignore */ }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, videoIds.length); i++) workers.push(worker());
  await Promise.all(workers);

  return { success: true, updated, failed, total: videoIds.length };
}

// --- Topic credits (composer/lyricist/arranger) extraction ---
// Reads ytInitialPlayerResponse.videoDetails.shortDescription from the
// watch page HTML and parses the auto-generated Topic credit lines.
function cleanCreditLine(s) {
  if (!s) return '';
  let out = s;
  // Strip parenthesized URLs / Twitter handles: "(Twitter: https://...)", "(https://t.co/...)", "(twitter.com/...)"
  out = out.replace(/[\(（][^()（）]*(?:https?:\/\/|twitter\.com|x\.com|t\.co\/|Twitter\s*[:：])[^()（）]*[\)）]/gi, '');
  // Strip bare URLs that may remain
  out = out.replace(/https?:\/\/\S+/gi, '');
  // Collapse whitespace and trailing separator junk
  out = out.replace(/\s+/g, ' ').replace(/\s*([,、，\/／])\s*/g, '$1').replace(/[,、，\/／]+$/, '').trim();
  // Strip trailing dashes/middots left over after URL removal
  // (e.g. "Foo - https://..." -> "Foo -" -> "Foo")
  out = out.replace(/[\s\-–—·]+$/, '').trim();
  // Spreadsheet error sentinels — never a real name
  if (out.toUpperCase() === '#N/A' || out.toUpperCase() === '#REF!' || out === '-') return '';
  return out;
}

// Role keywords. Each line of form "<label>: <value>" is checked: if the
// label part contains any keyword for a role, the value is assigned to that
// role. This handles compound labels like "Composer, Writer:" (comma) and
// "Composer Lyricist:" (space) and "Recording Arranger:" (prefix).
const CREDIT_ROLE_KEYWORDS = {
  composer: ['composers', 'composed by', 'composition', 'composer', 'music by', 'music composer', 'music', '作曲家', '作曲者', '作曲'],
  lyricist: ['lyricists', 'lyrics by', 'written by', 'lyricist', 'lyrics', 'songwriter', 'writer', 'author', '作詞家', '作詞者', '作詞'],
  arranger: ['arrangers', 'arranged by', 'arrangement', 'recording arranger', 'arranger', '編曲家', '編曲者', '編曲'],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelHasKeyword(labelLower, kw) {
  // ASCII keywords: word-boundary match. Japanese keywords: substring match.
  if (/^[\x20-\x7E]+$/.test(kw)) {
    const re = new RegExp('(?:^|[^a-z])' + escapeRegex(kw) + '(?:[^a-z]|$)', 'i');
    return re.test(labelLower);
  }
  return labelLower.includes(kw);
}

// Find the first non-empty line after "Provided to YouTube by ...". This is
// where Topic-channel auto-generated descriptions place the · separated
// credits row (e.g. "Title · Artist · Composer · Lyricist · Arranger").
function findTopicCreditsLine(desc) {
  const lines = desc.split('\n');
  let foundProvided = false;
  for (const line of lines) {
    if (/Provided to YouTube by/i.test(line)) { foundProvided = true; continue; }
    if (!foundProvided) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes('·')) return trimmed;
    return null;
  }
  return null;
}

function parseCreditsFromDescription(desc) {
  if (!desc) return { composer: '', lyricist: '', arranger: '', creditsRaw: '' };

  // Phase A: parse explicit "<role>: <name>" labeled lines. Handles compound
  // labels like "Composer, Writer:" / "Composer Lyricist:" / "Recording Arranger:".
  const found = { composer: [], lyricist: [], arranger: [] };
  const lines = desc.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const labelPart = m[1].toLowerCase();
    const valuePart = cleanCreditLine(m[2]);
    if (!valuePart) continue;
    for (const role of Object.keys(CREDIT_ROLE_KEYWORDS)) {
      for (const kw of CREDIT_ROLE_KEYWORDS[role]) {
        if (labelHasKeyword(labelPart, kw)) {
          if (!found[role].includes(valuePart)) found[role].push(valuePart);
          break;
        }
      }
    }
  }
  let composer = found.composer.join(', ');
  let lyricist = found.lyricist.join(', ');
  let arranger = found.arranger.join(', ');

  // Phase B: Topic-channel · separated row. Position-based role assignment is
  // unreliable (varies by distributor: NexTone vs King Records vs JVCKENWOOD
  // place fields in different orders), so we record contributors as raw text
  // unless every credit slot is the same name (in which case all 3 roles are
  // safely assigned to that single person).
  let creditsRaw = '';
  const topicLine = findTopicCreditsLine(desc);
  if (topicLine) {
    const fields = topicLine.split(/\s*·\s*/).map(s => s.trim()).filter(s => s && !/^[\-–—]+$/.test(s));
    if (fields.length >= 3) {
      // Include position 1 (artist) and onward as contributors. Some
      // distributors place the actual composer at position 1 and a publisher
      // at position 2 (e.g. NexTone "Yuki Matsumura · KOEI TECMO SOUND"), so
      // limiting to position 2+ would lose the real creator.
      const seen = new Set();
      const creditNames = [];
      for (let i = 1; i < fields.length; i++) {
        if (!seen.has(fields[i])) { seen.add(fields[i]); creditNames.push(fields[i]); }
      }
      creditsRaw = creditNames.join(' · ');

      // Same-name detection: if positions 1..end (artist + all credit slots)
      // are all the same name, that person handled every role.
      const allSame = fields.slice(1).every(n => n === fields[1]);
      if (allSame && !composer && !lyricist && !arranger) {
        composer = fields[1];
        lyricist = fields[1];
        arranger = fields[1];
      }
    }
  }

  return { composer, lyricist, arranger, creditsRaw };
}

async function fetchCreditsFromWatch(videoId, abortSignal) {
  try {
    // Route through a YouTube tab so the request carries user cookies and
    // avoids the google.com/sorry bot challenge.
    const resp = await fetchWatchHtmlQueued(videoId, 'fix-credits', abortSignal);
    if (resp.aborted) return { videoId, ok: false, reason: 'aborted', aborted: true };
    if (!resp.ok) return { videoId, ok: false, reason: resp.reason || 'proxy-failed' };
    const html = resp.html || '';

    // Consent/redirect pages lack ytInitialPlayerResponse entirely.
    if (html.indexOf('ytInitialPlayerResponse') === -1) {
      return { videoId, ok: false, reason: 'no-playerResponse' };
    }

    const vdStart = html.indexOf('"videoDetails":{');
    if (vdStart === -1) return { videoId, ok: false, reason: 'no-videoDetails' };
    const slice = html.slice(vdStart, vdStart + 100000);
    const descMatch = slice.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
    if (!descMatch) return { videoId, ok: false, reason: 'no-description' };
    const desc = decodeJsonStringLiteral(descMatch[1]);
    const credits = parseCreditsFromDescription(desc);
    const hasAny = credits.composer || credits.lyricist || credits.arranger || credits.creditsRaw;
    if (!hasAny) return { videoId, ok: true, credits, hasAny: false, reason: 'no-credits' };
    return { videoId, ok: true, credits, hasAny: true };
  } catch (e) {
    return { videoId, ok: false, reason: 'fetch-error', error: e.message };
  }
}

// One-time pass to clean URL/Twitter pollution from records saved before
// cleanCreditLine was strict enough. Runs at most once per install (gated by
// chrome.storage flag). Safe to retry: cleanAllCredits is idempotent.
async function runCreditsCleanupOnce() {
  try {
    const flag = await chrome.storage.local.get('creditsCleanupV1Done');
    if (flag.creditsCleanupV1Done) return null;
    const resp = await sendToOffscreenDb('CLEAN_ALL_CREDITS');
    if (resp) {
      await chrome.storage.local.set({ creditsCleanupV1Done: true });
      console.log('[Credits cleanup]', resp);
      return resp;
    }
  } catch (e) {
    console.warn('[Credits cleanup] skipped:', e.message);
  }
  return null;
}

async function fixDurationsBatch(videoIds, onProgress, abortSignal) {
  if (!videoIds.length) return { success: true, updated: 0, live: 0, fetchFailed: 0, total: 0, processed: 0 };

  const CONCURRENCY = WATCH_HTML_CONCURRENCY;

  let updated = 0;
  let live = 0;
  let fetchFailed = 0;
  const failReasons = {};
  let processed = 0;
  let idx = 0;
  let autoStopped = false;

  async function worker() {
    while (idx < videoIds.length) {
      if (abortSignal && abortSignal.aborted) return;
      if (autoStopped) return;
      const vid = videoIds[idx++];
      const result = await fetchDurationFromWatch(vid, abortSignal);
      if (result.aborted) return;
      let wasUpdated = false;
      if (!result.ok) {
        fetchFailed++;
        const r = result.reason || 'unknown';
        failReasons[r] = (failReasons[r] || 0) + 1;
        if (r === 'sorry-redirect') autoStopped = true;
        // Persist only video-specific permanent failures (playability-*:
        // age-restricted, removed, private, unavailable). Parser/transient
        // reasons (no-duration / empty-html / no-playerResponse / fetch-error
        // / env reasons) are not persisted so the next run can retry them.
        if (r.startsWith('playability-')) {
          try {
            await sendToOffscreenDb('MARK_DURATION_FAILED', { videoId: vid, reason: r });
          } catch (_e) { /* ignore */ }
        }
      } else {
        try {
          if (result.durationSec === -1) {
            live++;
            wasUpdated = await sendToOffscreenDb('MARK_DURATION_LIVE', { videoId: vid });
          } else {
            wasUpdated = await sendToOffscreenDb('UPDATE_DURATION', {
              videoId: vid,
              durationSec: result.durationSec,
            });
            if (wasUpdated) updated++;
          }
        } catch (_e) {
          fetchFailed++;
          failReasons['db-error'] = (failReasons['db-error'] || 0) + 1;
        }
      }
      processed++;
      if (onProgress) {
        try {
          onProgress({
            videoId: vid,
            processed,
            updated,
            live,
            fetchFailed,
            failReasons,
            total: videoIds.length,
            durationSec: result.durationSec,
            reason: result.reason || '',
            isLive: result.durationSec === -1,
            wasUpdated,
          });
        } catch (_e) { /* ignore */ }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, videoIds.length); i++) workers.push(worker());
  await Promise.all(workers);

  const aborted = !!(abortSignal && abortSignal.aborted);
  return { success: true, updated, live, fetchFailed, failReasons, total: videoIds.length, processed, aborted, autoStopped };
}

async function fixCreditsBatch(videoIds, sources, force, onProgress, abortSignal) {
  if (!videoIds.length) return { success: true, updated: 0, noCredits: 0, fetchFailed: 0, total: 0 };

  // Best-effort: clean polluted records once before this batch starts.
  await runCreditsCleanupOnce();

  // Watch HTML fetch pacing is owned by fetchWatchHtmlQueue above. Too
  // aggressive a rate trips YouTube's bot challenge and blocks the user's
  // whole session; keep this batch worker count aligned with the shared queue.
  const CONCURRENCY = WATCH_HTML_CONCURRENCY;

  let updated = 0;
  let noCredits = 0;
  let fetchFailed = 0;
  const failReasons = {};
  let processed = 0;
  let idx = 0;
  let autoStopped = false;

  async function worker() {
    while (idx < videoIds.length) {
      if (abortSignal && abortSignal.aborted) return;
      if (autoStopped) return;
      const vid = videoIds[idx++];
      const result = await fetchCreditsFromWatch(vid, abortSignal);
      if (result.aborted) return;
      let wasUpdated = false;
      if (!result.ok) {
        fetchFailed++;
        const r = result.reason || 'unknown';
        failReasons[r] = (failReasons[r] || 0) + 1;
        // Bot-challenge detected: stop the whole batch immediately to avoid
        // digging the rate-limit hole deeper.
        if (r === 'sorry-redirect') {
          autoStopped = true;
        }
        // Persist per-video failure reason so we can analyze later.
        // Skip environment-level reasons (not video-specific).
        const ENV_REASONS = new Set(['no-youtube-tab', 'sorry-redirect', 'proxy-failed']);
        if (!ENV_REASONS.has(r)) {
          try {
            await sendToOffscreenDb('MARK_CREDITS_FAILED', { videoId: vid, reason: r });
          } catch (_e) { /* ignore */ }
        }
      } else if (!result.hasAny) {
        noCredits++;
        // Stamp DB so next run can skip this videoId.
        try {
          await sendToOffscreenDb('MARK_CREDITS_CHECKED', { videoId: vid });
        } catch (_e) { /* ignore */ }
      } else {
        try {
          const didUpdate = await sendToOffscreenDb('UPDATE_CREDITS', {
            videoId: vid,
            credits: result.credits,
            creditsSource: (sources && sources[vid]) || '',
            force: force
          });
          if (didUpdate) {
            updated++;
            wasUpdated = true;
          }
        } catch (_e) {
          fetchFailed++;
          failReasons['db-error'] = (failReasons['db-error'] || 0) + 1;
        }
      }
      processed++;
      if (onProgress) {
        try {
          onProgress({
            videoId: vid,
            processed,
            updated,
            noCredits,
            fetchFailed,
            failReasons,
            total: videoIds.length,
            credits: result.credits || null,
            wasUpdated
          });
        } catch (_e) { /* ignore */ }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, videoIds.length); i++) workers.push(worker());
  await Promise.all(workers);

  const aborted = !!(abortSignal && abortSignal.aborted);
  return { success: true, updated, noCredits, fetchFailed, failReasons, total: videoIds.length, processed, aborted, autoStopped };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fix-credits') return;

  const abortSignal = { aborted: false };
  port.onDisconnect.addListener(() => { abortSignal.aborted = true; });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'ABORT') {
      abortSignal.aborted = true;
      return;
    }
    if (msg.type !== 'START') return;
    const videoIds = msg.videoIds || [];
    const sources = msg.sources || {};
    const force = !!msg.force;
    try {
      const result = await fixCreditsBatch(videoIds, sources, force, (progress) => {
        try { port.postMessage({ type: 'PROGRESS', ...progress }); } catch (_e) {}
      }, abortSignal);
      try { port.postMessage({ type: 'DONE', ...result }); } catch (_e) {}
    } catch (e) {
      try { port.postMessage({ type: 'ERROR', error: e.message }); } catch (_e) {}
    }
    try { port.disconnect(); } catch (_e) {}
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fix-durations') return;

  const abortSignal = { aborted: false };
  port.onDisconnect.addListener(() => { abortSignal.aborted = true; });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'ABORT') {
      abortSignal.aborted = true;
      return;
    }
    if (msg.type !== 'START') return;
    const videoIds = msg.videoIds || [];
    try {
      const result = await fixDurationsBatch(videoIds, (progress) => {
        try { port.postMessage({ type: 'PROGRESS', ...progress }); } catch (_e) {}
      }, abortSignal);
      try { port.postMessage({ type: 'DONE', ...result }); } catch (_e) {}
    } catch (e) {
      try { port.postMessage({ type: 'ERROR', error: e.message }); } catch (_e) {}
    }
    try { port.disconnect(); } catch (_e) {}
  });
});

// --- Liked playlist sync (LL = Liked Videos) ---
function findFirstContinuationToken(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.continuationCommand && node.continuationCommand.token) return node.continuationCommand.token;
  if (Array.isArray(node)) {
    for (const v of node) { const t = findFirstContinuationToken(v); if (t) return t; }
    return null;
  }
  for (const k in node) { const t = findFirstContinuationToken(node[k]); if (t) return t; }
  return null;
}

// Walks any ytInitialData / continuation response payload and pulls all
// playlistVideoRenderer items + the next continuation token if present.
function extractItemsAndContinuation(data) {
  const items = [];
  let continuation = '';
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    // 2026+ structure: playlist items migrated from playlistVideoRenderer to
    // the new lockupViewModel component. Extract videoId/title/channel from it.
    if (node.lockupViewModel) {
      const lv = node.lockupViewModel;
      const ct = lv.contentType || '';
      // Only video lockups carry a watchable videoId; skip playlist/channel lockups.
      if (!ct || ct === 'LOCKUP_CONTENT_TYPE_VIDEO') {
        const videoId = lv.contentId || '';
        if (videoId) {
          const lm = (lv.metadata && lv.metadata.lockupMetadataViewModel) || {};
          let title = '';
          if (lm.title && typeof lm.title.content === 'string') title = lm.title.content;
          let channel = '';
          const cmv = lm.metadata && lm.metadata.contentMetadataViewModel;
          const rows = (cmv && cmv.metadataRows) || [];
          // Prefer the metadata part linked to a channel (browseId starts with UC).
          for (const row of rows) {
            for (const part of (row.metadataParts || [])) {
              const t = part.text;
              if (!t || !t.content) continue;
              const runs = t.commandRuns || [];
              const linked = runs.some((r) => {
                const be = r.onTap && r.onTap.innertubeCommand && r.onTap.innertubeCommand.browseEndpoint;
                return be && typeof be.browseId === 'string' && be.browseId.startsWith('UC');
              });
              if (linked) { channel = t.content; break; }
            }
            if (channel) break;
          }
          // Fallback: first metadata part's text when no channel link found.
          if (!channel && rows[0] && rows[0].metadataParts && rows[0].metadataParts[0]
              && rows[0].metadataParts[0].text) {
            channel = rows[0].metadataParts[0].text.content || '';
          }
          items.push({ videoId, title, channel, playlistIndex: 0 });
        }
      }
      return;
    }
    if (node.playlistVideoRenderer) {
      const r = node.playlistVideoRenderer;
      const videoId = r.videoId;
      if (videoId) {
        let title = '';
        if (r.title && r.title.runs && r.title.runs[0]) title = r.title.runs[0].text || '';
        else if (r.title && r.title.simpleText) title = r.title.simpleText;
        let channel = '';
        if (r.shortBylineText && r.shortBylineText.runs && r.shortBylineText.runs[0]) {
          channel = r.shortBylineText.runs[0].text || '';
        }
        const indexStr = (r.index && r.index.simpleText) || '';
        const playlistIndex = parseInt(indexStr, 10) || 0;
        items.push({ videoId, title, channel, playlistIndex });
      }
      return;
    }
    if (node.continuationItemRenderer) {
      // 2024+ structure may wrap the token in commandExecutorCommand.commands[]
      // (yt-dlp PR #12777). Walk the renderer body for any continuationCommand.token.
      const t = findFirstContinuationToken(node.continuationItemRenderer);
      if (t && !continuation) continuation = t;
      return;
    }
    for (const k in node) walk(node[k]);
  }
  walk(data);
  // Fallback: continuation responses (lockupViewModel-based) sometimes don't
  // expose the next token via continuationItemRenderer in a shape the walker
  // recognizes. Scan the stringified payload for the first continuationCommand
  // token (mirrors parseLikedPlaylistHtml's fallback).
  if (!continuation) {
    try {
      const s = JSON.stringify(data);
      const m = s.match(/"continuationCommand":\{"token":"([^"]+)"/);
      if (m) continuation = m[1];
    } catch (_) {}
  }
  return { items, continuation };
}

// Extract the full INNERTUBE_CONTEXT object from HTML by balanced-matching braces
// starting at the key. The minimal {client:{clientName,clientVersion}} subset
// is rejected by some browse endpoints, so we forward the complete context.
function extractInnertubeContext(html) {
  const key = '"INNERTUBE_CONTEXT":';
  const i = html.indexOf(key);
  if (i === -1) return null;
  let p = i + key.length;
  while (p < html.length && html[p] !== '{') p++;
  if (html[p] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let j = p; j < html.length; j++) {
    const c = html[j];
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
      if (depth === 0) {
        const slice = html.slice(p, j + 1);
        try { return JSON.parse(slice); } catch (_) { return null; }
      }
    }
  }
  return null;
}

function extractYtcfg(html) {
  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || '';
  const clientName = (html.match(/"INNERTUBE_CLIENT_NAME":"([^"]+)"/) || [])[1] || 'WEB';
  const clientVersion = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '';
  const context = extractInnertubeContext(html);
  return { apiKey, clientName, clientVersion, context };
}

// Parses ytInitialData from the playlist HTML and extracts video items + owner identity.
function parseLikedPlaylistHtml(html) {
  const items = [];
  let ownerName = '';
  let ownerHandle = '';
  let ownerChannelId = '';
  let continuation = '';

  // Locate ytInitialData JSON (varies between "var ytInitialData = {...};" and "ytInitialData = {...};")
  const m = html.match(/(?:var\s+)?ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) return { items, ownerName, ownerHandle, ownerChannelId, continuation, error: 'no-ytInitialData' };

  let data;
  try { data = JSON.parse(m[1]); }
  catch (e) { return { items, ownerName, ownerHandle, ownerChannelId, continuation, error: 'parse-failed' }; }

  // Owner identity (best-effort across UI variants)
  try {
    const header = data.header || {};
    const ph = header.playlistHeaderRenderer || {};
    if (ph.ownerText && ph.ownerText.runs && ph.ownerText.runs[0]) {
      ownerName = ph.ownerText.runs[0].text || '';
      const ne = ph.ownerText.runs[0].navigationEndpoint;
      if (ne && ne.browseEndpoint) {
        ownerChannelId = ne.browseEndpoint.browseId || '';
        const u = ne.browseEndpoint.canonicalBaseUrl || '';
        if (u.startsWith('/@')) ownerHandle = u.slice(1);
      }
    }
    // Newer pageHeaderRenderer variant
    const phNew = (header.pageHeaderRenderer && header.pageHeaderRenderer.content
      && header.pageHeaderRenderer.content.pageHeaderViewModel) || null;
    if (!ownerName && phNew && phNew.metadata && phNew.metadata.contentMetadataViewModel) {
      const rows = phNew.metadata.contentMetadataViewModel.metadataRows || [];
      for (const row of rows) {
        const parts = (row.metadataParts || []);
        for (const p of parts) {
          const t = p.text && p.text.content;
          if (t && t.startsWith('@')) { ownerHandle = t; break; }
        }
      }
    }
  } catch (_) { /* tolerate structure changes */ }

  const ext = extractItemsAndContinuation(data);
  for (const it of ext.items) items.push({ ...it, playlistIndex: it.playlistIndex || items.length + 1 });
  continuation = ext.continuation;

  // Fallback 1: scan parsed JSON via stringify+regex if walker missed it
  if (!continuation) {
    try {
      const s = JSON.stringify(data);
      const m2 = s.match(/"continuationCommand":\{"token":"([^"]+)"/);
      if (m2) continuation = m2[1];
    } catch (_) {}
  }

  // Fallback 2: scan raw HTML
  if (!continuation) {
    const m3 = html.match(/"continuationCommand":\{"token":"([^"]+)"/);
    if (m3) continuation = m3[1];
  }

  return { items, ownerName, ownerHandle, ownerChannelId, continuation };
}

async function syncLikedPlaylist({ confirmAccountChange, maxPages } = {}) {
  let resp;
  try {
    resp = await sendToYouTubeTab({ type: 'FETCH_PLAYLIST_HTML', listId: 'LL' });
  } catch (e) {
    return { success: false, reason: 'no-youtube-tab' };
  }
  if (!resp || !resp.success) {
    return { success: false, reason: (resp && resp.reason) || 'fetch-failed' };
  }
  const html = resp.html || '';
  const parsed = parseLikedPlaylistHtml(html);
  if (parsed.error) return { success: false, reason: parsed.error };
  // NOTE: Do NOT bail on zero static-HTML items here. YouTube no longer embeds
  // liked-video items in the LL playlist's static HTML (they require an
  // authenticated browse POST). Fall through to the VLLL browse fallback below,
  // which populates items even when the initial HTML ships none. A final
  // no-items guard after pagination handles the genuinely-empty / logged-out case.

  const ytcfg = extractYtcfg(html);
  const allItems = [...parsed.items];
  let continuation = parsed.continuation;
  const cap = typeof maxPages === 'number' ? maxPages : 50; // 50 pages × ~100 = up to 5000 items
  let page = 1;
  const errors = [];

  // Prefer the full INNERTUBE_CONTEXT extracted from HTML; fall back to a minimal one.
  const baseContext = ytcfg.context
    || { client: { clientName: ytcfg.clientName, clientVersion: ytcfg.clientVersion, hl: 'ja', gl: 'JP' } };

  // If the initial HTML didn't expose a continuation token (LL often doesn't
  // ship one in the static HTML — it requires an authenticated browse POST),
  // ask the API for the full LL response which carries the first continuation.
  if (!continuation || !allItems.length) {
    try {
      const initResp = await sendToYouTubeTab({
        type: 'FETCH_INNERTUBE_BROWSE',
        apiKey: ytcfg.apiKey,
        clientVersion: ytcfg.clientVersion,
        body: { context: baseContext, browseId: 'VLLL' },
      });
      if (initResp && initResp.success && initResp.data) {
        const ext0 = extractItemsAndContinuation(initResp.data);
        // The browse response often carries a fuller item set than HTML; merge dedup.
        const seen = new Set(allItems.map(x => x.videoId));
        for (const it of ext0.items) {
          if (!seen.has(it.videoId)) {
            allItems.push({ ...it, playlistIndex: it.playlistIndex || allItems.length + 1 });
            seen.add(it.videoId);
          }
        }
        continuation = ext0.continuation;
      } else if (initResp && !initResp.success) {
        errors.push('init-browse: ' + (initResp.reason || 'unknown'));
      }
    } catch (e) {
      errors.push('init-browse: ' + e.message);
    }
  }

  while (continuation && page < cap) {
    page++;
    let contResp;
    try {
      contResp = await sendToYouTubeTab({
        type: 'FETCH_INNERTUBE_BROWSE',
        apiKey: ytcfg.apiKey,
        clientVersion: ytcfg.clientVersion,
        body: { context: baseContext, continuation },
      });
    } catch (e) {
      errors.push('page-' + page + ': ' + e.message);
      break;
    }
    if (!contResp || !contResp.success) {
      errors.push('page-' + page + ': ' + ((contResp && contResp.reason) || 'unknown'));
      break;
    }
    const ext = extractItemsAndContinuation(contResp.data);
    if (!ext.items.length) {
      // No items but maybe continuation came back — log and stop to avoid infinite loops.
      errors.push('page-' + page + ': empty-page');
      break;
    }
    for (const it of ext.items) {
      allItems.push({ ...it, playlistIndex: it.playlistIndex || allItems.length + 1 });
    }
    continuation = ext.continuation;
  }

  const uniqueItems = [];
  const seenFinal = new Set();
  for (const it of allItems) {
    if (!it.videoId || seenFinal.has(it.videoId)) continue;
    seenFinal.add(it.videoId);
    uniqueItems.push({ ...it, playlistIndex: it.playlistIndex || uniqueItems.length + 1 });
  }

  // Genuinely-empty / logged-out: static HTML had no items AND the authenticated
  // browse fallback returned nothing either.
  if (!uniqueItems.length) return { success: false, reason: 'no-items', errors };

  const accountId = parsed.ownerChannelId || parsed.ownerHandle || parsed.ownerName || 'unknown';

  // Account-change detection
  const meta = await new Promise((r) => chrome.storage.local.get({ likedSyncMeta: null }, (x) => r(x.likedSyncMeta)));
  if (meta && meta.accountId && meta.accountId !== accountId && !confirmAccountChange) {
    return {
      success: false,
      reason: 'account-changed',
      previous: meta,
      current: { accountId, ownerName: parsed.ownerName, ownerHandle: parsed.ownerHandle, ownerChannelId: parsed.ownerChannelId, count: uniqueItems.length },
    };
  }

  // Approximate likedAt: assume newest-first ordering; assign decreasing offsets.
  const now = Date.now();
  const enriched = uniqueItems.map((it, idx) => ({ ...it, likedAt: now - idx * 1000 }));

  let upsertResp;
  try {
    upsertResp = await sendToOffscreenDb('UPSERT_LIKED', { items: enriched, accountId });
  } catch (e) {
    return { success: false, reason: 'db-upsert-failed', error: e.message };
  }

  const newMeta = {
    accountId,
    ownerName: parsed.ownerName,
    ownerHandle: parsed.ownerHandle,
    ownerChannelId: parsed.ownerChannelId,
    lastSyncedAt: now,
    count: uniqueItems.length,
  };
  await new Promise((r) => chrome.storage.local.set({ likedSyncMeta: newMeta }, r));

  return {
    success: true,
    fetched: uniqueItems.length,
    added: upsertResp.added || 0,
    pages: page,
    errors,
    diagnostics: {
      initialContinuation: !!parsed.continuation,
      ytcfgApiKey: !!ytcfg.apiKey,
      ytcfgContext: !!ytcfg.context,
      clientVersion: ytcfg.clientVersion,
    },
    accountId,
    ownerName: parsed.ownerName,
    ownerHandle: parsed.ownerHandle,
    ownerChannelId: parsed.ownerChannelId,
  };
}

// Streaming variant via chrome.runtime.Port — emits progress events.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fix-channels') return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'START') return;
    const videoIds = msg.videoIds || [];
    const force = !!msg.force;

    try {
      const result = await fixChannelsBatch(videoIds, force, (progress) => {
        try { port.postMessage({ type: 'PROGRESS', ...progress }); } catch (_e) {}
      });
      try { port.postMessage({ type: 'DONE', ...result }); } catch (_e) {}
    } catch (e) {
      try { port.postMessage({ type: 'ERROR', error: e.message }); } catch (_e) {}
    }
    try { port.disconnect(); } catch (_e) {}
  });
});
