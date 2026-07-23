// Service Worker for YouTube Watched Hider
// Handles: tab URL monitoring, message passing, auto-backup

importScripts('credit_target.js');

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

// u1ps (Codex B1 VERIFY minor 1): like storageLocalSet but REJECTS on a
// chrome.storage write failure (e.g. quota). Used on the destructive meta-reset
// paths so a failed likedSyncMeta clear surfaces as an error instead of a false
// success. Kept separate so the many fire-and-forget storageLocalSet callers
// (settings toggles) are unaffected.
function storageLocalSetChecked(values) {
  return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve();
  }));
}

// u1ps §7.4 (Codex B1 VERIFY blocker 2): reset likedSyncMeta only if it is still
// exactly the value captured in the pre-reset snapshot. If a liked sync completed
// DURING the reset window it wrote a newer meta describing liked records that
// (being written after the snapshot) survived the id-scoped delete — nulling it
// would leave those surviving records without their account meta. Compare-and-set
// keeps meta consistent with the data that actually remains.
async function resetLikedSyncMetaIfUnchanged(snapshotMeta) {
  const { likedSyncMeta: current } = await storageLocalGet({ likedSyncMeta: null });
  if (JSON.stringify(current) !== JSON.stringify(snapshotMeta)) return false;
  await storageLocalSetChecked({ likedSyncMeta: null });
  return true;
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

// u1ps §7.3/§7.4: distinct filename for the mandatory safety backup taken right
// before a destructive replace/full-reset, so it never collides with (or is
// mistaken for) a routine manual/daily backup.
function getPreDestructiveBackupFilename(tag) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `yt-watched-backup-before-${tag}-${yyyy}${mm}${dd}-${hh}${mi}${ss}.json`;
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
    // u1ps (Codex B1 VERIFY blocker 1): a records-empty export can still carry
    // likedSyncMeta; keep it out of the "no_data" (nothing to back up) test.
    hasLikedSyncMeta: !!(blobInfo && blobInfo.hasLikedSyncMeta),
  };
}

async function downloadExportJson({ source, filename, conflictAction = 'uniquify', saveAs = false }) {
  let blobInfo = null;
  try {
    blobInfo = await createExportBlobUrl(source);
    const counts = getExportCount(blobInfo);
    // u1ps: only "nothing at all" (no records AND no sync meta) counts as no_data.
    if (counts.total === 0 && !counts.hasLikedSyncMeta) {
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

// u1ps §7.3 (Codex B2 VERIFY blocker 1): current-priority meta for "安全に統合".
// Keep the current likedSyncMeta; only fill it from the backup when none exists
// locally (fresh install). This matches the mode's "競合は現在を優先" contract,
// whereas storeImportedMeta (backup overwrites) is for "backup優先で統合".
async function storeImportedMetaIfAbsent(result) {
  if (!result || !result.likedSyncMeta) return;
  const { likedSyncMeta } = await storageLocalGet({ likedSyncMeta: null });
  if (likedSyncMeta == null) {
    // Checked write (Codex B2 minor 3) so a failed fill surfaces as an error.
    await storageLocalSetChecked({ likedSyncMeta: result.likedSyncMeta });
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
// Case 2-4 are enforced by MusicBrainz lookup + history-side similarity thresholding.
// Case 5 is enforced by runEnrichRateLimited, which serializes each source at >=1s/request.
// Case 7 is enforced by returning empty song/candidate payloads without creating tabs.
const ENRICH_RATE_LIMIT_MS = 1000;
const ENRICH_FETCH_TIMEOUT_MS = 30000;
const enrichRateState = {
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

function getEnrichMbUserAgent() {
  const manifest = chrome.runtime.getManifest();
  const version = manifest && manifest.version ? manifest.version : 'unknown';
  return `yt-watched-hider/${version} (https://github.com/sasakisrole/youtube-watched-hider)`;
}

function normalizeCreditLookupText(value) {
  return self.CreditTarget.stripTopicChannelSuffix(value)
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

const MB_SUFFIX_PATTERNS = [
  /\s*[-–—]\s*Live\s*\d{0,4}.*$/i,
  /\s*[-–—]\s*Live at .*$/i,
  /\s*[-–—]\s*Remix.*$/i,
  /\s*[-–—]\s*Cover.*$/i,
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

// 版表記の境界について:
// \b は数字も word 文字として扱うため、\blive\b は "Live2022"（実データに存在する表記）に
// 一致しない＝Live版が通常版として自動採用されていた（2026-07-21 実応答検証で判明）。
// 数字が直に続く形は許し、前後に「文字」が続く場合だけ除外する（alive / lively / delivery を誤検出しない）。
const MB_RECORDING_VERSION_RULES = [
  { label: 'Remix', pattern: /(?<![\p{L}])remix(?:ed)?(?![\p{L}])|リミックス/iu },
  { label: 'Cover', pattern: /(?<![\p{L}])cover(?:ed)?(?![\p{L}])|カバー/iu },
  { label: 'Live', pattern: /(?<![\p{L}])live(?![\p{L}])|ライブ/iu },
  { label: 'Instrumental', pattern: /(?<![\p{L}])instrumental(?![\p{L}])|インスト(?:ゥルメンタル)?/iu },
  { label: 'Off Vocal', pattern: /(?<![\p{L}])off\s*vocal(?![\p{L}])|オフ\s*ボーカル/iu },
  { label: 'Acoustic', pattern: /(?<![\p{L}])acoustic(?![\p{L}])|アコースティック/iu },
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

function parseMbTitle(title) {
  const originalTitle = String(title || '').normalize('NFKC').trim();
  const versions = MB_RECORDING_VERSION_RULES
    .filter((rule) => rule.pattern.test(originalTitle))
    .map((rule) => rule.label);
  return {
    originalTitle,
    baseWorkTitle: cleanMbTitle(originalTitle),
    recordingVersion: versions.join('/'),
    requiresManualReview: versions.length > 0,
  };
}

function mbRecordingVersionsMatch(requested, candidate) {
  const requestedVersion = requested && requested.recordingVersion || '';
  const candidateVersion = candidate && candidate.recordingVersion || '';
  if (!requestedVersion && !candidateVersion) return true;
  if (!requestedVersion || requestedVersion !== candidateVersion) return false;
  return normalizeCreditLookupText(requested.originalTitle) === normalizeCreditLookupText(candidate.originalTitle);
}

async function mbGet(path, params) {
  const query = new URLSearchParams(params);
  const url = `https://musicbrainz.org/ws/2/${path}?${query.toString()}`;
  return fetchEnrichJson('mb', url, {
    Accept: 'application/json',
    'User-Agent': getEnrichMbUserAgent(),
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

function mbArtistMatchQuality(artist, recording) {
  const target = normalizeCreditLookupText(artist);
  if (!target) return 'none';
  const credits = recording['artist-credit'] || [];
  let similar = false;
  for (const credit of credits) {
    const names = [credit.name, credit.artist && credit.artist.name].filter(Boolean);
    for (const name of names) {
      const norm = normalizeCreditLookupText(name);
      if (!norm) continue;
      if (norm === target) return 'exact';
      const lengthRatio = Math.min(target.length, norm.length) / Math.max(target.length, norm.length);
      if (Math.min(target.length, norm.length) >= 5
          && lengthRatio >= 0.8
          && sequenceRatio(target, norm) >= 0.9) {
        similar = true;
      }
    }
  }
  return similar ? 'similar' : 'none';
}

function mbArtistMatches(artist, recording) {
  return mbArtistMatchQuality(artist, recording) !== 'none';
}

async function enrichCreditsLookupMb(artist, title) {
  const cleanArtist = self.CreditTarget.stripTopicChannelSuffix(artist);
  const requestedTitle = parseMbTitle(title);
  const cleanTitle = requestedTitle.baseWorkTitle;
  if (!cleanArtist || !cleanTitle) return { success: false, reason: 'empty-query' };

  const strictQuery = `artist:"${cleanArtist}" AND recording:"${cleanTitle}"`;
  const strict = await mbGet('recording/', { query: strictQuery, fmt: 'json', limit: '5' });
  let chosen = null;
  let stage = '';
  const strictRecordings = strict.recordings || [];
  chosen = strictRecordings.find((recording) => {
    if (Number(recording.score || 0) < 90) return false;
    if (mbArtistMatchQuality(cleanArtist, recording) !== 'exact') return false;
    const candidateTitle = parseMbTitle(recording.title || '');
    const titleMatches = normalizeCreditLookupText(cleanTitle)
      === normalizeCreditLookupText(candidateTitle.baseWorkTitle);
    return titleMatches && mbRecordingVersionsMatch(requestedTitle, candidateTitle);
  }) || null;
  if (chosen) {
    stage = 'strict';
  } else {
    const titleOnly = await mbGet('recording/', { query: `recording:"${cleanTitle}"`, fmt: 'json', limit: '10' });
    const artistMatched = (titleOnly.recordings || [])
      .filter((recording) => mbArtistMatches(cleanArtist, recording))
      .map((recording) => ({
        recording,
        sim: sequenceRatio(
          normalizeCreditLookupText(cleanTitle),
          normalizeCreditLookupText(parseMbTitle(recording.title || '').baseWorkTitle)
        ),
      }))
      .sort((a, b) => b.sim - a.sim || Number(b.recording.score || 0) - Number(a.recording.score || 0));
    if (artistMatched.length) {
      chosen = artistMatched[0].recording;
      stage = 'fuzzy';
    }
  }

  if (!chosen || !chosen.id) {
    return { success: true, artist: cleanArtist, title: cleanTitle, candidate: null, reason: 'no-recording' };
  }

  const chosenTitle = parseMbTitle(chosen.title || '');
  const versionMatch = mbRecordingVersionsMatch(requestedTitle, chosenTitle);
  const roles = await getMbRecordingRoles(chosen.id);
  const safeRoles = {
    composer: roles.composer,
    lyricist: roles.lyricist,
    arranger: versionMatch ? roles.arranger : [],
  };
  if (!hasAnyMbRole(safeRoles)) {
    return { success: true, artist: cleanArtist, title: cleanTitle, candidate: null, reason: 'no-roles' };
  }
  const sim = sequenceRatio(
    normalizeCreditLookupText(cleanTitle),
    normalizeCreditLookupText(chosenTitle.baseWorkTitle)
  );
  const requiresManualReview = stage !== 'strict'
    || requestedTitle.requiresManualReview
    || chosenTitle.requiresManualReview
    || !versionMatch;
  const manualReviewReasons = [];
  if (stage !== 'strict') manualReviewReasons.push('non-strict-match');
  if (requestedTitle.requiresManualReview || chosenTitle.requiresManualReview) manualReviewReasons.push('recording-version');
  if (!versionMatch) manualReviewReasons.push('version-mismatch');
  return {
    success: true,
    artist: cleanArtist,
    title: cleanTitle,
    candidate: {
      composer: joinMbRoles(safeRoles.composer),
      lyricist: joinMbRoles(safeRoles.lyricist),
      arranger: joinMbRoles(safeRoles.arranger),
      mbid: chosen.id,
      mbTitle: chosen.title || '',
      stage,
      score: chosen.score || 0,
      sim,
      baseWorkTitle: cleanTitle,
      recordingVersion: requestedTitle.recordingVersion,
      mbRecordingVersion: chosenTitle.recordingVersion,
      versionMatch,
      requiresManualReview,
      manualReviewReason: manualReviewReasons.join(','),
      autoEligible: stage === 'strict' && !requiresManualReview,
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
    // "安全に統合" (current-priority): keep current meta, fill only if absent.
    sendToOffscreenDb('MERGE_IMPORT', { data: message.data })
      .then(async (result) => {
        await storeImportedMetaIfAbsent(result);
        broadcastCacheInvalidated({ reason: 'merge-import', mode: 'reload' });
        sendResponse({ success: true, ...result });
      })
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'IMPORT_DIFF') {
    // u1ps §7.3: read-only dry-run preview (追加/更新/削除予定/無効) before the user
    // picks an import mode. No mutation.
    sendToOffscreenDb('IMPORT_DIFF', { data: message.data })
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'REPLACE_IMPORT') {
    // u1ps §7.3: 置換 (replace) — final state = the backup's records. Freeze-free,
    // snapshot-consistent (mirrors CLEAR_ALL):
    //   1) snapshot current (EXPORT_DATA) = the mandatory pre-replace backup,
    //   2) download it — abort & change NOTHING if it fails,
    //   3) REPLACE_APPLY deletes only (snapshot ids \ new ids) then imports the new
    //      records (backup wins); records written AFTER the snapshot survive,
    //   4) set likedSyncMeta FAITHFULLY to the backup's meta (null -> clear;
    //      Codex B1 VERIFY blocker 3).
    (async () => {
      let blobInfo = null;
      try {
        const { likedSyncMeta } = await storageLocalGet({ likedSyncMeta: null });
        const appVersion = chrome.runtime.getManifest().version;
        const envelope = await sendToOffscreenDb('EXPORT_DATA', { source: 'pre-replace', likedSyncMeta, appVersion });
        const watchedVideos = Array.isArray(envelope.watchedVideos) ? envelope.watchedVideos : [];
        const likedVideos = Array.isArray(envelope.likedVideos) ? envelope.likedVideos : [];
        const hasData = watchedVideos.length > 0 || likedVideos.length > 0 || !!envelope.likedSyncMeta;

        let backup = { success: false, reason: 'no_data', counts: { watchedVideos: watchedVideos.length, likedVideos: likedVideos.length } };
        if (hasData) {
          blobInfo = await sendToOffscreenDb('OFFSCREEN_CREATE_EXPORT_BLOB', { envelope });
          const downloadId = await downloadUrl(blobInfo.blobUrl, getPreDestructiveBackupFilename('replace'), { conflictAction: 'uniquify' });
          const settled = await waitForDownloadSettled(downloadId);
          await sendToOffscreenDb('OFFSCREEN_REVOKE_BLOB', { requestId: blobInfo.requestId, blobUrl: blobInfo.blobUrl });
          blobInfo = null;
          if (settled.state === 'interrupted' || settled.timedOut) {
            sendResponse({ success: false, reason: 'backup_failed', backup: { success: false, reason: settled.timedOut ? 'download_state_timeout' : 'download_interrupted' } });
            return;
          }
          backup = { success: true, counts: { watchedVideos: watchedVideos.length, likedVideos: likedVideos.length } };
        }

        const snapshotWatchedIds = watchedVideos.map((r) => r && r.videoId).filter((v) => typeof v === 'string' && v);
        const snapshotLikedIds = likedVideos.map((r) => r && r.videoId).filter((v) => typeof v === 'string' && v);
        const result = await sendToOffscreenDb('REPLACE_APPLY', { data: message.data, snapshotWatchedIds, snapshotLikedIds });
        // Faithful replace (Codex B1 blocker 3): the backup's meta is authoritative
        // (null clears the old one). This is UNCONDITIONAL by design — replace means
        // "restore to this backup", so imposing the backup's meta is the intent
        // (unlike CLEAR_ALL, which uses compare-and-set to avoid nulling a
        // concurrently-synced meta). ACCEPTED EDGE: a liked sync completing during
        // the backup window writes a meta not in the backup; replace overwrites it
        // to the backup's meta. Self-heals on the next sync; negligible for a
        // deliberate restore. NOTE (Codex B2 minor 4): the DB replace and this
        // chrome.storage meta write can't share one transaction, so if this write
        // fails the records are replaced while meta keeps its old value and the
        // response is an error — the state is recoverable from the pre-replace
        // backup file that was just downloaded, and a re-import re-applies meta.
        await storageLocalSetChecked({ likedSyncMeta: result.likedSyncMeta || null });
        const addedIds = Array.isArray(result.watchedIds) ? result.watchedIds : [];
        broadcastCacheInvalidated({ reason: 'replace-import', mode: 'reload', clear: true, addedIds });
        sendResponse({ success: true, backup, ...result });
      } catch (e) {
        if (blobInfo) {
          try { await sendToOffscreenDb('OFFSCREEN_REVOKE_BLOB', { requestId: blobInfo.requestId, blobUrl: blobInfo.blobUrl }); } catch (_) { /* best effort */ }
        }
        sendResponse({ success: false, error: e.message || String(e) });
      }
    })();
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
    // u1ps §7.4: 視聴履歴だけ削除 (watched store only).
    sendToOffscreenDb('CLEAR_DATA')
      .then(() => {
        broadcastCacheInvalidated({ reason: 'clear', mode: 'reload', clear: true });
        sendResponse({ success: true });
      })
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'CLEAR_LIKED_ALL') {
    // u1ps §7.4: 高評価データだけ削除 = clear the whole liked store AND reset the
    // liked sync meta so a stale account identity never lingers after the data
    // it described is gone.
    sendToOffscreenDb('CLEAR_LIKED', { accountId: '' })
      .then(async () => {
        await storageLocalSetChecked({ likedSyncMeta: null });
        broadcastCacheInvalidated({ reason: 'clear-liked', mode: 'reload' });
        sendResponse({ success: true });
      })
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'CLEAR_ALL') {
    // u1ps §7.4: 全データを初期化. Freeze-free, snapshot-consistent reset
    // (Codex B1 VERIFY blockers 1+2):
    //   1) Take ONE snapshot (EXPORT_DATA) — used as BOTH the backup file and the
    //      exact set of ids to delete.
    //   2) MANDATORY auto-backup of that snapshot — abort & delete NOTHING if the
    //      download fails. (Nothing to back up when there are 0 records and no
    //      sync meta => proceed straight to the no-op delete.)
    //   3) Delete exactly the snapshot's ids. Any record written AFTER the
    //      snapshot is not in the list, so it SURVIVES instead of being
    //      deleted-without-backup — no lock/freeze, no lost watched events.
    //   4) Reset likedSyncMeta (checked).
    (async () => {
      let blobInfo = null;
      try {
        const { likedSyncMeta } = await storageLocalGet({ likedSyncMeta: null });
        const appVersion = chrome.runtime.getManifest().version;
        const envelope = await sendToOffscreenDb('EXPORT_DATA', { source: 'pre-reset', likedSyncMeta, appVersion });
        const watchedVideos = Array.isArray(envelope.watchedVideos) ? envelope.watchedVideos : [];
        const likedVideos = Array.isArray(envelope.likedVideos) ? envelope.likedVideos : [];
        const hasData = watchedVideos.length > 0 || likedVideos.length > 0 || !!envelope.likedSyncMeta;

        let backup = { success: false, reason: 'no_data', counts: { watchedVideos: watchedVideos.length, likedVideos: likedVideos.length } };
        if (hasData) {
          blobInfo = await sendToOffscreenDb('OFFSCREEN_CREATE_EXPORT_BLOB', { envelope });
          const downloadId = await downloadUrl(blobInfo.blobUrl, getPreDestructiveBackupFilename('reset'), { conflictAction: 'uniquify' });
          const settled = await waitForDownloadSettled(downloadId);
          await sendToOffscreenDb('OFFSCREEN_REVOKE_BLOB', { requestId: blobInfo.requestId, blobUrl: blobInfo.blobUrl });
          blobInfo = null;
          if (settled.state === 'interrupted' || settled.timedOut) {
            // Backup did not settle safely: delete NOTHING.
            sendResponse({ success: false, reason: 'backup_failed', backup: { success: false, reason: settled.timedOut ? 'download_state_timeout' : 'download_interrupted' } });
            return;
          }
          backup = { success: true, counts: { watchedVideos: watchedVideos.length, likedVideos: likedVideos.length } };
        }

        const watchedIds = watchedVideos.map((r) => r && r.videoId).filter((v) => typeof v === 'string' && v);
        const likedIds = likedVideos.map((r) => r && r.videoId).filter((v) => typeof v === 'string' && v);
        // Delete only the snapshot ids. ACCEPTED LIMITATION (Codex B1 VERIFY): if
        // the SAME videoId is re-watched (playCount/watchedAt bumped) during the
        // brief backup-download window, its id is in the list and the newer record
        // is deleted while the backup holds the pre-bump version. The record is
        // being wiped anyway (deliberate double-confirmed full reset); the only gap
        // is one increment in the safety-backup for a video watched in that window.
        // A per-record compare-and-delete (CAS) is disproportionate to that; the
        // meta below uses CAS because it is a single cheap value.
        await sendToOffscreenDb('DELETE_SNAPSHOT', { watchedIds, likedIds });
        // Compare against the meta value read at snapshot time (what the backup
        // captured), not the sanitized envelope copy, so an unchanged meta is
        // reliably cleared and a concurrently-updated one is preserved.
        await resetLikedSyncMetaIfUnchanged(likedSyncMeta);
        broadcastCacheInvalidated({ reason: 'clear-all', mode: 'reload', clear: true });
        sendResponse({ success: true, backup });
      } catch (e) {
        if (blobInfo) {
          try { await sendToOffscreenDb('OFFSCREEN_REVOKE_BLOB', { requestId: blobInfo.requestId, blobUrl: blobInfo.blobUrl }); } catch (_) { /* best effort */ }
        }
        sendResponse({ success: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'SYNC_LIKED') {
    syncLikedPlaylist({
      confirmAccountChange: !!message.confirmAccountChange,
      confirmUnknownAccount: !!message.confirmUnknownAccount,
    })
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
  composer: ['composers', 'composed by', 'composition', 'composer', 'compose', 'music by', 'original music', 'music composer', '作曲家', '作曲者', '作曲'],
  lyricist: ['lyricists', 'lyrics by', 'written by', 'lyricist', 'lyrics', 'songwriter', 'words', '作詞家', '作詞者', '作詞', '作詩'],
  arranger: ['arrangers', 'arranged by', 'arrangement', 'recording arranger', 'arranger', 'arrange', '編曲家', '編曲者', '編曲'],
};

const CREDIT_LABEL_TOKEN_RE = /(?:^|[\s/／|｜;；]\s*)((?:作曲\s*[・&＆/／]\s*編曲|作編曲|words\s*(?:&|and)\s*music|compose(?:r)?\s*(?:&|and|\/|／)\s*arrange(?:r)?|composer\s*[,，]?\s*(?:writer|lyricist)|composer\s+lyricist|composers?|composed\s+by|composition|compose|music\s+by|original\s+music|music\s+composer|lyricists?|lyrics\s+by|written\s+by|lyrics?|songwriters?|words|arrangers?|arranged\s+by|arrangement|recording\s+arranger|arrange|作詞家|作詞者|作詞|作詩|作曲家|作曲者|作曲|編曲家|編曲者|編曲))\s*[:：]/giu;

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

function rolesForCreditLabel(label) {
  const labelLower = label.toLowerCase();
  const roles = [];
  if (/作編曲|作曲\s*[・&＆/／]\s*編曲|compose(?:r)?\s*(?:&|and|\/|／)\s*arrange(?:r)?/iu.test(labelLower)) {
    return ['composer', 'arranger'];
  }
  if (/words\s*(?:&|and)\s*music/iu.test(labelLower)) return ['composer', 'lyricist'];
  for (const role of Object.keys(CREDIT_ROLE_KEYWORDS)) {
    if (CREDIT_ROLE_KEYWORDS[role].some(kw => labelHasKeyword(labelLower, kw))) roles.push(role);
  }
  // Preserve the prior explicitly musical compound-label behavior without
  // accepting a naked Writer/Author label.
  if (roles.includes('composer') && /(?:^|[^a-z])writer(?:[^a-z]|$)/iu.test(labelLower)) roles.push('lyricist');
  return [...new Set(roles)];
}

function extractCreditSegments(line) {
  const matches = [];
  CREDIT_LABEL_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = CREDIT_LABEL_TOKEN_RE.exec(line))) {
    matches.push({ index: match.index, valueStart: CREDIT_LABEL_TOKEN_RE.lastIndex, label: match[1] });
  }
  return matches.map((item, index) => ({
    roles: rolesForCreditLabel(item.label),
    value: line.slice(item.valueStart, index + 1 < matches.length ? matches[index + 1].index : line.length),
  }));
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

  // Phase A: tokenize every recognized "<role>: <name>" segment. A value ends
  // immediately before the next role label, so multiple roles on one line do
  // not leak their label text into the preceding value.
  const found = { composer: [], lyricist: [], arranger: [] };
  const lines = desc.split('\n');
  for (const line of lines) {
    for (const segment of extractCreditSegments(line)) {
      const valuePart = cleanCreditLine(segment.value);
      if (!self.CreditTarget.isValidCreditValue(valuePart)) continue;
      for (const role of segment.roles) {
        if (!found[role].includes(valuePart)) found[role].push(valuePart);
      }
    }
  }
  const joinValidRoleValues = values => {
    const joined = values.join(', ');
    return self.CreditTarget.isValidCreditValue(joined) ? joined : '';
  };
  const composer = joinValidRoleValues(found.composer);
  const lyricist = joinValidRoleValues(found.lyricist);
  const arranger = joinValidRoleValues(found.arranger);

  // Phase B: Topic-channel · separated row. Position-based role assignment is
  // unreliable (varies by distributor: NexTone vs King Records vs JVCKENWOOD
  // place fields in different orders), so we record contributors only as raw
  // evidence. A repeated Topic name does not prove any role.
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

// v1.42.9 (H1 refinement, Codex 2026-07-10): container names split into two roles.
//
// LL_PRIMARY_RENDERERS = playlist-SPECIFIC renderers. Their name IS real evidence of
// Liked-playlist provenance (a `playlistVideoListRenderer` / `richGridRenderer` is the
// playlist body, not a recommendation shelf), so a container under one of these wins
// primary selection over any generic sibling regardless of raw item count. This is the
// structural anchor: item-count comparison is demoted to a last-resort fallback.
//
// v1.42.7 merged these with the generic continuation envelopes below into one
// LL_ITEM_CONTAINERS set used as the `named` preference. That still let a sibling
// recommendation shelf wrapped in `appendContinuationItemsAction` become "named" and,
// if it carried more lockups than the real body, hijack primary (H1 residual). By
// keeping ONLY the playlist-specific names as evidence, that bias is removed.
const LL_PRIMARY_RENDERERS = new Set([
  'playlistVideoListRenderer',
  'richGridRenderer',
]);

// LL_CONTINUATION_ENVELOPES = GENERIC continuation envelopes shared by every section of
// YouTube. They are NOT evidence of LL provenance — a diverged token's response uses the
// exact same envelope. They are intentionally excluded from the `named` preference so
// they never bias primary selection; the token-provenance regex already scopes tokens to
// the primary container's subtree, so no name-based envelope matching is needed for that.
// (Kept as a documented constant so a future reader doesn't re-add them to the anchor.)
const LL_CONTINUATION_ENVELOPES = new Set([
  'appendContinuationItemsAction',
  'reloadContinuationItemsCommand',
]);

// Walks any ytInitialData / continuation response payload and pulls playlist items
// + the next continuation token.
//
// H1 provenance model (v1.42.7):
//   1. Identify the PRIMARY CONTAINER structurally = the array that actually holds
//      the items (preferring a known LL container name, else the array with the most
//      items). A recommendation shelf sharing the response lives in a different array.
//   2. Items in the primary container => source:'scoped'. Everything else => 'loose'.
//   3. The continuation token is taken ONLY from inside the primary container (its
//      sibling continuationItemRenderer, or a regex restricted to that array's
//      subtree). Tokens found anywhere else are ignored.
//
// (3) is what actually closes H1: the old code fell back to `JSON.stringify(whole
// response)` and grabbed the first `continuationCommand` anywhere, which could be a
// recommendation shelf's token. Once such a token is fetched, its response looks
// structurally identical to a real LL page (same generic envelope) and NO downstream
// check can tell them apart. By never taking a token outside the container we
// harvested items from, and by starting from the authoritative `browseId:'VLLL'`
// response, LL provenance is preserved inductively across every page.
function extractItemsAndContinuation(data) {
  const rawItems = [];   // { ...item, cid, named }
  const rawTokens = [];  // { token, cid }
  const arrayByCid = new Map();
  let nextCid = 0;

  function walk(node, cid, named) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      // Each array is a candidate container; its elements belong to it.
      const myCid = ++nextCid;
      arrayByCid.set(myCid, node);
      for (const v of node) walk(v, myCid, named);
      return;
    }
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
          // L1: no unconditional fallback to the first metadata part. When no
          // browseEndpoint(UC)-linked part is found, leave channel empty rather
          // than risk storing a non-channel string (view count, upload date,
          // etc.) that would pollute liked-artist aggregation. Analyzer treats
          // empty channel as "channel unknown".
          rawItems.push({ videoId, title, channel, playlistIndex: 0, cid, named });
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
        rawItems.push({ videoId, title, channel, playlistIndex, cid, named });
      }
      return;
    }
    if (node.continuationItemRenderer) {
      // 2024+ structure may wrap the token in commandExecutorCommand.commands[]
      // (yt-dlp PR #12777). Walk the renderer body for any continuationCommand.token.
      // Record which container it sits in; provenance is decided after the walk.
      const t = findFirstContinuationToken(node.continuationItemRenderer);
      if (t) rawTokens.push({ token: t, cid });
      return;
    }
    // v1.42.9 (H1): `named` propagates ONLY through playlist-specific renderers.
    // Generic continuation envelopes (LL_CONTINUATION_ENVELOPES) deliberately do NOT
    // set it, so a recommendation shelf wrapped in the same envelope can't earn the
    // primary-selection preference.
    //
    // (Codex 2026-07-11 R) `named` is conferred to a primary renderer's DIRECT item
    // array(s) only — it must not flood arbitrarily-deep nested objects. An array
    // inherits `named` (so `renderer.contents` stays named); descending into a nested
    // OBJECT drops inherited `named` and only re-confers it when THIS key is itself a
    // primary renderer. Otherwise a shelf nested under e.g.
    // `richGridRenderer.header.shelfRenderer.contents` would inherit `named` and, if it
    // held more lockups, hijack primary — the H1 bug re-entering via a descendant.
    for (const k in node) {
      const child = node[k];
      const isPrimaryKey = LL_PRIMARY_RENDERERS.has(k);
      walk(child, cid, Array.isArray(child) ? (named || isPrimaryKey) : isPrimaryKey);
    }
  }
  walk(data, 0, false);

  // --- Pick the primary container (the array the playlist items actually live in).
  // v1.42.9 (H1, Codex 2026-07-10): a container under a playlist-SPECIFIC renderer
  // (LL_PRIMARY_RENDERERS) is the structural anchor and wins outright — even over a
  // sibling that carries MORE items — because its name is real LL evidence. Item-count
  // comparison is only the last-resort fallback when no such anchor is present. When
  // that fallback is a tie (two unnamed arrays with the same top count, i.e. we can't
  // prove which is the LL body), `primaryUncertain` is set so the caller refuses to
  // trust the guess (drops the token, flags partial) instead of silently coin-flipping.
  const counts = new Map();
  const namedCids = new Set();
  for (const it of rawItems) {
    counts.set(it.cid, (counts.get(it.cid) || 0) + 1);
    if (it.named) namedCids.add(it.cid);
  }
  let primary = 0, bestNamed = -1;
  for (const [cid, n] of counts) {
    if (namedCids.has(cid) && n > bestNamed) { bestNamed = n; primary = cid; }
  }
  let primaryUncertain = false;
  if (bestNamed < 0) {
    // No playlist-specific anchor: fall back to the largest array, but track whether
    // the maximum is a tie among distinct containers (ambiguous provenance).
    let bestAny = -1, tieAtMax = 0;
    for (const [cid, n] of counts) {
      if (n > bestAny) { bestAny = n; primary = cid; tieAtMax = 1; }
      else if (n === bestAny) { tieAtMax++; }
    }
    // A single body (its array is the strict maximum) => tieAtMax === 1 => certain.
    // Two+ arrays tied at the top => can't prove which is the liked body => uncertain.
    if (tieAtMax > 1) primaryUncertain = true;
  }

  const items = rawItems.map(({ cid, named, ...it }) => ({
    ...it,
    source: cid === primary ? 'scoped' : 'loose',
  }));

  // --- Token provenance: only ever take a token from the primary container.
  // `rejectedTokenCount` lets the caller distinguish "this section genuinely has no
  // next page" (0) from "we refused a token that lived somewhere else" (>0). The
  // latter must surface as partial, otherwise refusing a token would masquerade as a
  // clean, complete sync.
  let continuation = '';
  let continuationSource = '';
  let continuationScoped = false;
  let rejectedTokenCount = 0;
  if (primary) {
    rejectedTokenCount = rawTokens.filter((t) => t.cid !== primary).length;
    const tok = rawTokens.find((t) => t.cid === primary);
    if (tok) {
      continuation = tok.token; continuationSource = 'structured'; continuationScoped = true;
    } else {
      // lockupViewModel continuation responses sometimes hide the token in a shape
      // the walker doesn't recognize. Regex it — but ONLY inside the primary
      // container's subtree, so we can never grab another section's token.
      try {
        const s = JSON.stringify(arrayByCid.get(primary));
        const m = s.match(/"continuationCommand":\{"token":"([^"]+)"/);
        if (m) { continuation = m[1]; continuationSource = 'regex-scoped'; continuationScoped = true; }
      } catch (_) {}
    }
  } else {
    // No items at all in this payload => no primary container to anchor to. Any
    // token here is unproven; expose it but flag it so callers refuse to paginate.
    // (Callers treat an item-less response as empty-page / fall through to browse.)
    if (rawTokens.length) {
      continuation = rawTokens[0].token; continuationSource = 'structured'; continuationScoped = false;
    } else {
      try {
        const s = JSON.stringify(data);
        const m = s.match(/"continuationCommand":\{"token":"([^"]+)"/);
        if (m) { continuation = m[1]; continuationSource = 'regex'; continuationScoped = false; }
      } catch (_) {}
    }
  }
  // v1.42.9 (H1): an ambiguous primary pick is a guess — never let its token paginate.
  // The token is still surfaced (so the caller can flag partial) but marked unproven.
  if (primaryUncertain) continuationScoped = false;
  return { items, continuation, continuationSource, continuationScoped, rejectedTokenCount, primaryUncertain };
}

// Balance-match a JSON object at/after `fromIndex`: skip forward to the first '{',
// then walk to its matching '}' respecting string literals and escapes. Returns the
// parsed object, or null when no balanced object is found or JSON.parse fails. Shared
// by INNERTUBE_CONTEXT and ytInitialData extraction so both survive assignment-form /
// wrapper variance instead of depending on a brittle end-anchored regex.
function matchBalancedJsonObject(html, fromIndex) {
  let p = fromIndex;
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
        try { return JSON.parse(html.slice(p, j + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

// Extract the full INNERTUBE_CONTEXT object from HTML by balanced-matching braces
// starting at the key. The minimal {client:{clientName,clientVersion}} subset
// is rejected by some browse endpoints, so we forward the complete context.
function extractInnertubeContext(html) {
  const key = '"INNERTUBE_CONTEXT":';
  const i = html.indexOf(key);
  if (i === -1) return null;
  return matchBalancedJsonObject(html, i + key.length);
}

// v1.42.10 (M1): locate ytInitialData across assignment-form / wrapper variants and
// balance-match the object. The old single end-anchored regex
// (`ytInitialData = {...};</script>`) broke whenever YouTube changed how it emits the
// initial data (window["ytInitialData"], minified boundary, extra trailing script
// content) — losing the object AND the owner identity, which then forced the
// account-unknown confirmation even though the data was present.
// Returns { data, matched }: matched=true means an assignment marker existed, so a
// null data is a genuine parse failure ('parse-failed') rather than absence
// ('no-ytInitialData'). Every marker occurrence is tried; the first that parses wins.
function extractYtInitialData(html) {
  const markers = [
    'window["ytInitialData"] =',
    "window['ytInitialData'] =",
    'window.ytInitialData =',
    'var ytInitialData =',
    'ytInitialData =',
  ];
  let sawMarker = false;
  for (const mk of markers) {
    let from = 0;
    let i;
    while ((i = html.indexOf(mk, from)) !== -1) {
      sawMarker = true;
      const obj = matchBalancedJsonObject(html, i + mk.length);
      if (obj) return { data: obj, matched: true };
      from = i + mk.length;
    }
  }
  return { data: null, matched: sawMarker };
}

// Extract the playlist owner identity (best-effort across UI variants). Runs on both
// the static-HTML ytInitialData and, in degraded/unknown cases, the authoritative
// VLLL browse response — both carry the same `header` shape — so identity is not lost
// just because the static HTML changed shape (M1).
function extractOwnerIdentity(data) {
  let ownerName = '';
  let ownerHandle = '';
  let ownerChannelId = '';
  try {
    const header = (data && data.header) || {};
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
  return { ownerName, ownerHandle, ownerChannelId };
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

  // v1.42.10 (M1): resist ytInitialData wrapper/assignment variance (see
  // extractYtInitialData). A parse failure here loses only the owner identity — the
  // authoritative VLLL browse still supplies items + token — and syncLikedPlaylist
  // now also tries to recover the owner from that browse response.
  const yt = extractYtInitialData(html);
  if (!yt.data) {
    return { items, ownerName, ownerHandle, ownerChannelId, continuation,
      error: yt.matched ? 'parse-failed' : 'no-ytInitialData' };
  }
  const data = yt.data;

  // Owner identity (best-effort across UI variants)
  const owner = extractOwnerIdentity(data);
  ownerName = owner.ownerName;
  ownerHandle = owner.ownerHandle;
  ownerChannelId = owner.ownerChannelId;

  const ext = extractItemsAndContinuation(data);
  for (const it of ext.items) items.push({ ...it, playlistIndex: it.playlistIndex || items.length + 1 });
  continuation = ext.continuation;

  // v1.42.7 (H1): the old "Fallback 1: stringify(data) regex" / "Fallback 2: raw HTML
  // regex" grabbed the FIRST continuationCommand anywhere on the page — routinely a
  // recommendation shelf's token on a modern LL page. Paginating that token silently
  // pulls another section's videos into the liked set, and no downstream check can
  // detect it (the responses are structurally identical). Both fallbacks are removed:
  // extractItemsAndContinuation now returns a token only when it is co-located with
  // the harvested items, and the authoritative VLLL browse below supplies the real
  // pagination token when the static HTML has none.
  return { items, ownerName, ownerHandle, ownerChannelId, continuation, continuationScoped: ext.continuationScoped };
}

async function syncLikedPlaylist({ confirmAccountChange, confirmUnknownAccount, maxPages } = {}) {
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
  const ytcfg = extractYtcfg(html);
  const errors = [];

  // v1.42.8 (M3): degraded mode. A ytInitialData parse failure is no longer a
  // full stop. Since v1.42.7 the static HTML is only a prelude — the authoritative
  // `browseId:'VLLL'` response supplies items AND the pagination token — so the only
  // thing lost with ytInitialData is the owner identity, which the existing
  // `account-unknown` confirmation guard already handles. Bailing here meant YouTube
  // merely changing how it assigns its initial data killed the whole sync.
  // We still hard-fail when neither the API key nor the InnerTube context survives:
  // that HTML is not a usable YouTube page (consent wall / error page), so browse
  // cannot run and prompting the user to save an unidentified account is pointless.
  const degraded = parsed.error || null;
  if (degraded) {
    if (!ytcfg.apiKey && !ytcfg.context) return { success: false, reason: parsed.error, degraded: true };
    errors.push('html: ' + parsed.error);
  }
  // NOTE: Do NOT bail on zero static-HTML items here. YouTube no longer embeds
  // liked-video items in the LL playlist's static HTML (they require an
  // authenticated browse POST). Fall through to the VLLL browse fallback below,
  // which populates items even when the initial HTML ships none. A final
  // no-items guard after pagination handles the genuinely-empty / logged-out case.

  // v1.42.7 (H1): never paginate an unproven token. `continuationScoped` means the
  // token was co-located with the items we accepted, so it belongs to the liked
  // playlist section. An unproven token is dropped; the authoritative VLLL browse
  // below then supplies the real one.
  let continuation = parsed.continuationScoped ? parsed.continuation : '';
  const cap = typeof maxPages === 'number' ? maxPages : 50; // 50 pages × ~100 = up to 5000 items
  let page = 1;

  // v1.42.7 (H1): keep only items from the response's primary container
  // (source==='scoped'). 'loose' items belong to some other array in the same payload
  // (a recommendation shelf, "up next", promoted lockups) and are dropped so unrelated
  // videoIds never persist as liked data.
  //
  // The v1.42.6 `allowFallback` / `scopeFallbacks` machinery is gone: it existed only
  // because scoping was decided by container *name*, so a response using an
  // unrecognized LL container yielded zero scoped items and needed a rescue path.
  // Primary-container selection is structural, so whenever a response has items at
  // least one of them is scoped — the zero-scoped-with-items case cannot occur.
  let droppedLoose = 0;
  function selectUsable(extItems) {
    const scoped = extItems.filter((it) => it.source !== 'loose');
    droppedLoose += extItems.length - scoped.length; // clean exclusion of pollution — not an error
    return scoped;
  }

  const allItems = selectUsable(parsed.items || []).map((it) => ({ ...it }));

  // Prefer the full INNERTUBE_CONTEXT extracted from HTML; fall back to a minimal one.
  const baseContext = ytcfg.context
    || { client: { clientName: ytcfg.clientName, clientVersion: ytcfg.clientVersion, hl: 'ja', gl: 'JP' } };

  // v1.42.10 (M1): owner identity may be recoverable from the authoritative VLLL
  // browse even when the static HTML lost it (degraded parse / header variant). Seed
  // mutable locals from the HTML so the browse block below can fill the gap, and track
  // how the identity was resolved for the confidence marker persisted later.
  let ownerName = parsed.ownerName || '';
  let ownerHandle = parsed.ownerHandle || '';
  let ownerChannelId = parsed.ownerChannelId || '';
  // v1.42.12 (M1): distinguish a STRONG html identity (channelId/handle) from a weak
  // html name-only one, so the browse-upgrade below can rank the two and replace a weak
  // html name with a strong browse channelId/handle.
  let identitySource = (ownerChannelId || ownerHandle) ? 'html-strong'
    : (ownerName ? 'html-name-only' : '');

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
        // v1.42.9 (H1): an ambiguous primary pick (tie among unnamed containers) means
        // we can't prove which array is the liked body. Keep the best-guess items but
        // flag partial so an unproven pick never reads as a clean, complete sync.
        if (ext0.primaryUncertain) errors.push('init-browse: primary-uncertain');
        // The browse response often carries a fuller item set than HTML; merge dedup.
        // H1: only merge items from this response's primary container.
        const usable0 = selectUsable(ext0.items);
        const seen = new Set(allItems.map(x => x.videoId));
        for (const it of usable0) {
          if (!seen.has(it.videoId)) {
            allItems.push({ ...it, playlistIndex: it.playlistIndex || allItems.length + 1 });
            seen.add(it.videoId);
          }
        }
        // v1.42.10 (M1): adopt the owner from this authoritative VLLL response when it is
        // a STRONGER identity than the static HTML gave us, so a recoverable identity
        // never falls to the account-unknown prompt.
        //
        // v1.42.12 (M1, Codex 2026-07-11 wrapup-review_10): the old guard only fired when
        // HTML gave NOTHING (!channelId && !handle && !name), so an HTML name-only state
        // was frozen even when this browse header carried a channelId/handle — defeating
        // the whole point of the name-only weakness marker (a weak name that COULD be
        // upgraded stayed weak). Rank by strength (channelId/handle = strong > displayName
        // > none) and upgrade on a STRICT increase. The VLLL browse is authoritative for
        // the user's own liked playlist, so adopting its identity wholesale is safe; a
        // differing display name is still caught by the account-change guard below.
        const identityRank = (cid, h, n) => ((cid || h) ? 2 : (n ? 1 : 0));
        const bo = extractOwnerIdentity(initResp.data);
        if (identityRank(bo.ownerChannelId, bo.ownerHandle, bo.ownerName)
            > identityRank(ownerChannelId, ownerHandle, ownerName)) {
          ownerName = bo.ownerName; ownerHandle = bo.ownerHandle; ownerChannelId = bo.ownerChannelId;
          identitySource = 'browse-upgraded';
        }
        // v1.42.7 (H1): the VLLL response is authoritative, so a token co-located with
        // its items is a proven LL token. Refuse anything else rather than paginating
        // into another section (that divergence is undetectable downstream).
        if (ext0.continuationScoped) {
          continuation = ext0.continuation;
        } else {
          continuation = '';
          // A token existed but not inside the items' container => refuse it AND warn,
          // so a refused (possibly legit) token never reads as a clean full sync.
          if (ext0.continuation || ext0.rejectedTokenCount) errors.push('init-browse: unproven-continuation');
        }
      } else if (initResp && !initResp.success) {
        errors.push('init-browse: ' + (initResp.reason || 'unknown'));
      }
    } catch (e) {
      errors.push('init-browse: ' + e.message);
    }
  }

  // Track seen videoIds across pages so a diverged/looping continuation token
  // (e.g. a mis-scoped regex fallback, M2) that returns only duplicates is
  // detected and treated as partial instead of silently spinning or diverging.
  const seenIds = new Set(allItems.map((x) => x.videoId));

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
    // v1.42.9 (H1): ambiguous primary pick on a continuation page => flag partial and
    // stop trusting the chain (the token was already dropped as unproven upstream).
    if (ext.primaryUncertain) errors.push('page-' + page + ': primary-uncertain');
    // H1: harvest only this page's primary-container items; anything in a sibling
    // shelf array is dropped. (With structural selection a page that has items
    // always has scoped ones, so `no-scoped-items` is a defensive guard.)
    const usable = selectUsable(ext.items);
    if (!usable.length) {
      errors.push('page-' + page + ': no-scoped-items');
      break;
    }
    let newOnPage = 0;
    for (const it of usable) {
      if (it.videoId && !seenIds.has(it.videoId)) {
        seenIds.add(it.videoId);
        newOnPage++;
      }
      allItems.push({ ...it, playlistIndex: it.playlistIndex || allItems.length + 1 });
    }
    // A page that contributes zero new videoIds means the continuation token has
    // diverged or is looping (M2). Stop and flag partial rather than trusting it.
    if (newOnPage === 0) {
      errors.push('page-' + page + ': all-duplicate');
      break;
    }
    // v1.42.7 (H1): carry the chain forward only through proven tokens. A refused
    // token also flags partial so an incomplete sync is never reported as complete.
    if (ext.continuationScoped) {
      continuation = ext.continuation;
    } else {
      if (ext.continuation || ext.rejectedTokenCount) errors.push('page-' + page + ': unproven-continuation');
      continuation = '';
    }
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

  const accountId = ownerChannelId || ownerHandle || ownerName || 'unknown';

  // Partial-sync detection (M1): pagination stopped before exhausting the
  // playlist. Either a continuation token still remained (cap hit / broke with a
  // live token) or a page-level / init-browse failure occurred mid-fetch.
  const hasMore = !!continuation;
  const partial = hasMore || errors.some((e) => /^(page-\d+|init-browse)/.test(e));

  // Account identity guard (H1): never persist an 'unknown' account silently.
  // A first sync — or a re-sync while the stored account is also 'unknown' —
  // would let a different account's likes merge in undetected (account-change
  // detection below can't distinguish unknown-vs-unknown). Require explicit opt-in.
  if (accountId === 'unknown' && !confirmUnknownAccount) {
    return {
      success: false,
      reason: 'account-unknown',
      partial,
      hasMore,
      degraded,
      pages: page,
      fetched: uniqueItems.length,
      errors,
    };
  }

  // Account-change detection
  const meta = await new Promise((r) => chrome.storage.local.get({ likedSyncMeta: null }, (x) => r(x.likedSyncMeta)));
  if (meta && meta.accountId && meta.accountId !== accountId && !confirmAccountChange) {
    return {
      success: false,
      reason: 'account-changed',
      previous: meta,
      current: { accountId, ownerName, ownerHandle, ownerChannelId, count: uniqueItems.length },
    };
  }

  // Approximate likedAt: assume newest-first ordering; assign decreasing offsets.
  // Strip the transient `source` tag (H1 scoping metadata) so it never lands in
  // the persisted liked record.
  const now = Date.now();
  const enriched = uniqueItems.map(({ source, ...it }, idx) => ({ ...it, likedAt: now - idx * 1000 }));

  let upsertResp;
  try {
    upsertResp = await sendToOffscreenDb('UPSERT_LIKED', { items: enriched, accountId });
  } catch (e) {
    return { success: false, reason: 'db-upsert-failed', error: e.message };
  }

  // v1.42.10 (M1): record how confident we are in the identity so a save made under
  // the account-unknown confirmation never renders like a normal, fully-identified sync
  // on the next open. 'unknown-confirmed' only reaches storage because the
  // account-unknown guard above already forced explicit opt-in.
  //
  // v1.42.11 (M2, Codex 2026-07-11 wrapup-review_9): a channelId/handle is a STRONG
  // identity; a bare display name (ownerName only, no browseEndpoint) is WEAK. A
  // name-only accountId is same-name-collision- and rename-prone, yet it skips the
  // account-unknown guard (it isn't 'unknown') and, before this, rendered like a
  // normal fully-identified sync. Mark it 'name-only' so the analyzer meta row can
  // distinguish it (a different account sharing the display name could merge in
  // undetected — account-change detection can't tell two same-name accounts apart).
  // Strength precedence: unknown-confirmed > name-only > browse-recovered/html. It is
  // deliberately NOT a blocking prompt: name-only is strictly better than unknown, and
  // the string-differs downgrade (strong -> name-only) is already caught by the
  // account-changed guard below.
  const strongIdentity = !!(ownerChannelId || ownerHandle);
  const identityConfidence = accountId === 'unknown'
    ? 'unknown-confirmed'
    : !strongIdentity
      ? 'name-only'
      : (identitySource === 'browse-upgraded' ? 'browse-recovered' : 'html');

  const newMeta = {
    accountId,
    ownerName,
    ownerHandle,
    ownerChannelId,
    identityConfidence,
    unknownConfirmedAt: accountId === 'unknown' ? now : null,
    lastSyncedAt: now,
    count: uniqueItems.length,
    partial,
    hasMore,
    degraded,
    droppedLoose,
    lastError: errors.length ? errors[errors.length - 1] : null,
  };
  await new Promise((r) => chrome.storage.local.set({ likedSyncMeta: newMeta }, r));

  return {
    success: true,
    partial,
    hasMore,
    degraded,
    droppedLoose,
    fetched: uniqueItems.length,
    added: upsertResp.added || 0,
    pages: page,
    errors,
    diagnostics: {
      initialContinuation: !!parsed.continuation,
      ytcfgApiKey: !!ytcfg.apiKey,
      ytcfgContext: !!ytcfg.context,
      clientVersion: ytcfg.clientVersion,
      droppedLoose,
      degraded,
      identitySource,
    },
    accountId,
    identityConfidence,
    ownerName,
    ownerHandle,
    ownerChannelId,
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
