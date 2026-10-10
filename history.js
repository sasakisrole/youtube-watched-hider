// Static history localization: keep the HTML fallback when a key is unavailable.
function applyStaticHistoryI18n() {
  if (typeof chrome === 'undefined' || !chrome.i18n?.getMessage) return;
  for (const target of ['', 'placeholder', 'title', 'aria-label']) {
    const attribute = target ? 'data-i18n-' + target : 'data-i18n';
    for (const element of document.querySelectorAll('[' + attribute + ']')) {
      const message = chrome.i18n.getMessage(element.getAttribute(attribute));
      if (!message) continue;
      if (target) element.setAttribute(target, message);
      else element.textContent = element.textContent.replace(/\S(?:[\s\S]*\S)?/, () => message);
    }
  }
}
applyStaticHistoryI18n();
// End static history localization

// History viewer script for YouTube Watched Hider
// Separated from history.html for Manifest V3 CSP compliance
// Uses incremental rendering to avoid UI freeze with large datasets

const content = document.getElementById('content');
const searchInput = document.getElementById('search');
const totalCountEl = document.getElementById('totalCount');
const totalCountOfEl = document.getElementById('totalCountOf');
const undoToast = document.getElementById('undoToast');
const undoToastText = document.getElementById('undoToastText');
const undoToastBtn = document.getElementById('undoToastBtn');
const backToTopBtn = document.getElementById('backToTop');
const sortBtns = document.querySelectorAll('.sort-btn');

let allData = [];
let historySortCache = null;
let currentSort = 'date-desc';
let noChannelOnly = false;
let sortedCache = [];  // cached sorted+filtered result
const PAGE_SIZE = 100; // render this many items at a time
let renderedCount = 0;
let lastDateKeyRendered = '';

// Format helpers
function formatDateGroup(ts) {
  const d = new Date(ts);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} (${days[d.getDay()]})`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function unwrapWatchedRecords(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && data.schemaVersion === 2 && Array.isArray(data.watchedVideos)) return data.watchedVideos;
  if (data && typeof data === 'object' && Array.isArray(data.records)) return data.records;
  return [];
}

function getSortedHistory() {
  if (!historySortCache || historySortCache.source !== allData || historySortCache.mode !== currentSort) {
    historySortCache = { source: allData, mode: currentSort, records: sortData(allData, currentSort) };
  }
  return historySortCache.records;
}

// Sort data
function sortData(data, mode) {
  const sorted = [...data];
  switch (mode) {
    case 'date-desc':
      sorted.sort((a, b) => b.watchedAt - a.watchedAt);
      break;
    case 'date-asc':
      sorted.sort((a, b) => a.watchedAt - b.watchedAt);
      break;
    case 'count-desc':
      sorted.sort((a, b) => (b.playCount || 1) - (a.playCount || 1) || b.watchedAt - a.watchedAt);
      break;
    case 'channel':
      sorted.sort((a, b) => (a.channel || '').localeCompare(b.channel || '') || b.watchedAt - a.watchedAt);
      break;
    case 'title':
      sorted.sort((a, b) => (a.title || a.videoId).localeCompare(b.title || b.videoId));
      break;
  }
  return sorted;
}

// 絞り込み中に母数が見えなくなるので、全体の件数を横に添える
function historyMessage(key, fallback, substitutions = []) {
  if (typeof chrome === 'undefined' || !chrome.i18n?.getMessage) return fallback;
  return chrome.i18n.getMessage(key, substitutions.map(String)) || fallback;
}

function historyUILanguage() {
  return typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage
    ? chrome.i18n.getUILanguage() : 'ja';
}

function updateTotalCount() {
  totalCountEl.textContent = sortedCache.length.toLocaleString();
  if (!totalCountOfEl) return;
  totalCountOfEl.textContent = sortedCache.length === allData.length
    ? ''
    : historyMessage(allData.length === 1 ? 'history_total_one' : 'history_total_many', `（全${allData.length.toLocaleString()}件）`, [allData.length.toLocaleString()]);
}

// 履歴の1件削除。押した瞬間には消さず、猶予の間だけ画面から隠しておいて、
// 猶予が切れてから実際の削除を送る。DBには1件を元どおり書き戻す口が無いので、
// 「消してから戻す」ではなく「まだ消さない」で取り消しを成立させている。
const UNDO_WINDOW_MS = 5000;
let pendingDeletes = [];
let deletionOrders = new WeakMap();
const unsettledDeletes = new Set();
let historyDataRevision = 0;
let historyLoadGeneration = 0;
let reloadAfterDeletes = false;

function getDeletionOrder(records) {
  let order = deletionOrders.get(records);
  if (!order) {
    // Replies can arrive out of order; mutable array offsets cannot identify the original position.
    order = new WeakMap(records.map((video, index) => [video, index]));
    deletionOrders.set(records, order);
  }
  return order;
}

function restoreInDeletionOrder(records, video, order) {
  const rank = order.get(video);
  let low = 0, high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (order.get(records[middle]) < rank) low = middle + 1;
    else high = middle;
  }
  records.splice(low, 0, video);
}

function settleDelete(entry) {
  unsettledDeletes.delete(entry);
  if (!unsettledDeletes.size) {
    deletionOrders = new WeakMap();
    if (reloadAfterDeletes) {
      reloadAfterDeletes = false;
      setTimeout(loadData, 0);
    }
  }
}

function renderUndoToast() {
  if (!undoToast) return;
  if (!pendingDeletes.length) {
    undoToast.hidden = true;
    return;
  }
  undoToastText.textContent = historyMessage(pendingDeletes.length === 1 ? 'history_removed_one' : 'history_removed_many', `${pendingDeletes.length}件を履歴から削除しました`, [pendingDeletes.length]);
  undoToast.hidden = false;
}

function restoreDelete(entry) {
  historyDataRevision++;
  clearTimeout(entry.timer);
  pendingDeletes = pendingDeletes.filter((e) => e !== entry);
  if (entry.allIndex >= 0) restoreInDeletionOrder(allData, entry.video, entry.allOrder);
  historySortCache = null;
  if (entry.sortedIndex >= 0 && entry.sortedSource === sortedCache) {
    restoreInDeletionOrder(sortedCache, entry.video, entry.sortedOrder);
    if (entry.row.isConnected) renderedCount++;
  }
  settleDelete(entry);
  entry.row.hidden = false;
  updateTotalCount();
  renderUndoToast();
  // 猶予の間に検索・並べ替えが走ると、隠しておいた行はもう画面に無い
  if (!entry.row.isConnected) render();
}

function removeEmptyDateHeaders() {
  const children = Array.from(content.children);
  for (let i = 0; i < children.length; i++) {
    const header = children[i];
    if (header.className !== 'date-header') continue;
    const next = children[i + 1];
    // Hidden rows still belong to their group until Undo or the DELETE reply settles.
    if (!next || next.className === 'date-header') {
      header.remove();
      if (!next) lastDateKeyRendered = '';
    }
  }
}

function commitDelete(entry) {
  pendingDeletes = pendingDeletes.filter((e) => e !== entry);
  renderUndoToast();
  function failDelete() {
    restoreDelete(entry);
    showJobMessage(historyMessage('history_delete_error', `履歴から削除できませんでした: ${entry.video.title || entry.video.videoId}`, [entry.video.title || entry.video.videoId]), { state: 'error' });
  }
  try {
    chrome.runtime.sendMessage({ type: 'DELETE_VIDEO', videoId: entry.video.videoId }, (res) => {
      if (chrome.runtime.lastError || !res || !res.success) {
        // A failed send or reply must restore the same record and release deferred reloads.
        failDelete();
        return;
      }
      historyDataRevision++;
      settleDelete(entry);
      const connected = entry.row.isConnected;
      entry.row.remove();
      if (connected) removeEmptyDateHeaders();
    });
  } catch (_e) {
    failDelete();
  }
}

function deleteVideo(video, rowEl) {
  historyDataRevision++;
  const allIndex = allData.indexOf(video);
  const sortedIndex = sortedCache.indexOf(video);
  const entry = { video, row: rowEl, allIndex, sortedIndex, timer: null,
    allOrder: getDeletionOrder(allData), sortedOrder: getDeletionOrder(sortedCache), sortedSource: sortedCache };
  unsettledDeletes.add(entry);
  if (allIndex >= 0) allData.splice(allIndex, 1);
  historySortCache = null;
  if (sortedIndex >= 0) {
    sortedCache.splice(sortedIndex, 1);
    // renderedCount は sortedCache の添字。手前が1件減ったら一緒に詰めないと、
    // 次に読み込む100件の先頭が1件ぶん飛んで黙って表示されなくなる
    if (sortedIndex < renderedCount) renderedCount--;
  }
  rowEl.hidden = true;
  updateTotalCount();
  entry.timer = setTimeout(() => commitDelete(entry), UNDO_WINDOW_MS);
  pendingDeletes.push(entry);
  renderUndoToast();
}

if (undoToastBtn) {
  undoToastBtn.addEventListener('click', () => {
    [...pendingDeletes].reverse().forEach(restoreDelete);
  });
}

// タブを閉じると猶予のタイマーごと消えるので、その場で実削除を送る。
// 送り切れなかった場合は削除されないだけで、次に開けば一覧に残っている（安全側）
window.addEventListener('pagehide', () => {
  pendingDeletes.forEach((entry) => {
    clearTimeout(entry.timer);
    try { chrome.runtime.sendMessage({ type: 'DELETE_VIDEO', videoId: entry.video.videoId }); } catch (_e) { /* 閉じる途中は失敗しうる */ }
  });
  pendingDeletes = [];
});

// Build a single video row element
function buildVideoRow(video) {
  const row = document.createElement('div');
  row.className = 'video-row';

  const a = document.createElement('a');
  a.className = 'video-link';
  a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
  a.target = '_blank';
  a.rel = 'noopener';

  if (video.source === 'seekbar' || video.source === 'history') {
    const badge = document.createElement('span');
    badge.className = 'badge badge-yt';
    badge.textContent = 'YT';
    badge.title = video.source === 'seekbar'
      ? historyMessage('history_source_seekbar', 'シークバーの動きから視聴を検出')
      : historyMessage('history_source_history', 'YouTubeの履歴から取り込み');
    a.appendChild(badge);
  }

  const count = video.playCount || 1;
  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-count';
    badge.textContent = `${count}x`;
    a.appendChild(badge);
  }

  const info = document.createElement('div');
  info.className = 'video-info';

  const title = document.createElement('div');
  title.className = 'video-title';
  title.textContent = video.title || video.videoId;
  info.appendChild(title);

  if (video.channel) {
    const ch = document.createElement('div');
    ch.className = 'video-channel';
    ch.textContent = video.channel;
    info.appendChild(ch);
  }

  a.appendChild(info);

  const time = document.createElement('span');
  time.className = 'video-time';
  time.textContent = formatTime(video.watchedAt);
  a.appendChild(time);

  const idEl = document.createElement('span');
  idEl.className = 'video-id';
  idEl.textContent = video.videoId;
  a.appendChild(idEl);

  row.appendChild(a);

  const delBtn = document.createElement('button');
  delBtn.className = 'delete-btn';
  delBtn.textContent = '\u00d7';
  delBtn.title = historyMessage('history_delete_title', '履歴から削除（削除後5秒は元に戻せます）');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteVideo(video, row);
  });
  row.appendChild(delBtn);

  return row;
}

// Render next batch of items (incremental)
function renderBatch() {
  if (renderedCount >= sortedCache.length) return;

  const showDateHeaders = currentSort === 'date-desc' || currentSort === 'date-asc';
  const end = Math.min(renderedCount + PAGE_SIZE, sortedCache.length);
  const fragment = document.createDocumentFragment();

  for (let i = renderedCount; i < end; i++) {
    const video = sortedCache[i];

    if (showDateHeaders) {
      const dk = dateKey(video.watchedAt);
      if (dk !== lastDateKeyRendered) {
        lastDateKeyRendered = dk;
        const header = document.createElement('div');
        header.className = 'date-header';
        header.textContent = formatDateGroup(video.watchedAt);
        fragment.appendChild(header);
      }
    }

    fragment.appendChild(buildVideoRow(video));
  }

  content.appendChild(fragment);
  renderedCount = end;
}

// Full render (reset + first batch)
function render() {
  const filter = searchInput.value.toLowerCase();
  const hasCachedOrder = historySortCache?.source === allData && historySortCache.mode === currentSort;
  let filtered = hasCachedOrder ? historySortCache.records : allData;
  if (filter) {
    filtered = filtered.filter(v =>
      (v.title || v.videoId).toLowerCase().includes(filter) ||
      (v.channel || '').toLowerCase().includes(filter) ||
      v.videoId.toLowerCase().includes(filter) ||
      (Array.isArray(v.participants) && v.participants.some(p => typeof p?.name === 'string' && p.name.toLowerCase().includes(filter)))
    );
  }
  if (noChannelOnly) {
    filtered = filtered.filter(v => !v.channel || v.channel.trim() === '');
  }

  // A cold filtered view need not sort records that cannot be displayed.
  sortedCache = hasCachedOrder ? filtered.slice() :
    filtered.length === allData.length ? getSortedHistory().slice() : sortData(filtered, currentSort);
  updateTotalCount();
  renderedCount = 0;
  lastDateKeyRendered = '';

  if (sortedCache.length === 0) {
    content.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = historyMessage('history_empty', '該当する動画はありません。検索語や絞り込みを外してみてください。');
    content.appendChild(empty);
    return;
  }

  content.textContent = '';
  renderBatch();
}

// Infinite scroll: load more when near bottom
window.addEventListener('scroll', () => {
  // 100件ずつ足していく一覧なので、下へ進むほど先頭が遠くなる
  if (backToTopBtn) backToTopBtn.hidden = window.scrollY < 600;
  if (renderedCount >= sortedCache.length) return;
  // Load more when within 300px of bottom
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 300) {
    renderBatch();
  }
});

if (backToTopBtn) {
  backToTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    searchInput.focus();
  });
}

// Sort buttons — `data-sort` 属性を持つボタンだけが並べ替え用
// （L2 fix: 旧コードは `.sort-btn` クラス全部を捕捉して filterNoChannel だけ id で除外
// していたが、Fix Durations / Fix Credits / Fix Channels / Analyze なども
// 視覚スタイル共有のため `.sort-btn` を付けており、クリックで currentSort=undefined と
// なり再描画が走っていた。data-sort 属性で限定する方が安全）
const sortOnlyBtns = document.querySelectorAll('.sort-btn[data-sort]');
sortOnlyBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    sortOnlyBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSort = btn.dataset.sort;
    render();
  });
});

// No-channel filter toggle
const filterNoChannelBtn = document.getElementById('filterNoChannel');
if (filterNoChannelBtn) {
  filterNoChannelBtn.addEventListener('click', () => {
    noChannelOnly = !noChannelOnly;
    filterNoChannelBtn.classList.toggle('active', noChannelOnly);
    render();
  });
}

// Fix channels via oEmbed API
const fixStatus = document.getElementById('fixStatus');
const jobProgressBar = document.getElementById('jobProgressBar');
const jobRecentList = document.getElementById('jobRecentList');
const jobRecentCount = document.getElementById('jobRecentCount');
const JOB_CURRENT_KEY = 'ytwh.job.current';
const JOB_RECENT_KEY = 'ytwh.job.recent';
let displayedJob = null;
let recentJobs = [];
let persistedRunningMaintenance = null;

function maintenanceKeyForJob(kind) {
  if (kind === 'bulkRemoveWatchLater' || kind === 'scanWatchLater') return 'scanWatchLater';
  return ['fixChannels', 'fixChannelsForce', 'fixCredits', 'fixDurations'].includes(kind) ? kind : null;
}

function renderJob(job, recent = recentJobs) {
  displayedJob = job || null;
  recentJobs = Array.isArray(recent) ? recent.slice(0, 5) : [];
  if (fixStatus) fixStatus.textContent = displayedJob && displayedJob.message ? displayedJob.message : '';

  if (jobProgressBar) {
    const total = Math.max(0, Number(displayedJob && displayedJob.total) || 0);
    const processed = Math.max(0, Number(displayedJob && displayedJob.processed) || 0);
    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    jobProgressBar.style.width = `${percent}%`;
  }

  if (jobRecentCount) jobRecentCount.textContent = recentJobs.length ? `(${recentJobs.length})` : '';
  if (jobRecentList) {
    jobRecentList.textContent = '';
    const stateLabels = {
      done: historyMessage('history_state_done', '完了'),
      aborted: historyMessage('history_state_aborted', '中止'),
      interrupted: historyMessage('history_state_interrupted', '中断'),
      error: historyMessage('history_state_error', '失敗'),
    };
    recentJobs.forEach(item => {
      if (!item) return;
      const li = document.createElement('li');
      const timestamp = Number(item.endedAt || item.updatedAt || item.startedAt) || 0;
      const when = timestamp
        ? new Date(timestamp).toLocaleString(historyUILanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : historyMessage('history_unknown_date', '日時不明');
      const label = item.label || item.kind || historyMessage('history_job_fallback', '処理');
      const state = stateLabels[item.state] || item.state || historyMessage('history_unknown_result', '結果不明');
      li.textContent = historyMessage('history_job_entry', `${when} ${label} — ${state}`, [when, label, state]);
      jobRecentList.appendChild(li);
    });
  }
}

function showJobMessage(message, options = {}) {
  renderJob({
    id: options.id || `page-${Date.now()}`,
    kind: options.kind || '',
    label: options.label || '',
    state: options.state || 'done',
    startedAt: options.startedAt || Date.now(),
    updatedAt: Date.now(),
    endedAt: options.state === 'running' ? null : Date.now(),
    total: Number(options.total) || 0,
    processed: Number(options.processed) || 0,
    counters: options.counters || {},
    message,
    error: options.error || null,
    abortable: !!options.abortable,
  });
}

function applyStoredJobState(current, recent) {
  persistedRunningMaintenance = current && current.state === 'running'
    ? maintenanceKeyForJob(current.kind)
    : null;
  renderJob(current || null, recent);
  updateMaintenanceButtons();
}

const maintenanceButtons = [
  { key: 'fixChannels', el: document.getElementById('fixChannels') },
  { key: 'fixChannelsForce', el: document.getElementById('fixChannelsForce') },
  { key: 'fixCredits', el: document.getElementById('fixCredits') },
  { key: 'repairCredits', el: document.getElementById('repairCredits') },
  { key: 'restoreCredits', el: document.getElementById('restoreCredits') },
  { key: 'enrichCredits', el: document.getElementById('enrichCredits') },
  { key: 'fixDurations', el: document.getElementById('fixDurations') },
  { key: 'scanWatchLater', el: document.getElementById('scanWatchLater') },
].filter(item => item.el).map(item => ({
  ...item,
  textEl: item.el.querySelector('span'),
  defaultText: item.el.querySelector('span') ? item.el.querySelector('span').textContent : item.el.textContent,
  defaultTitle: item.el.title,
}));
let runningMaintenance = null;
let runningMaintenanceActiveText = historyMessage('history_maintenance_running', '実行中…');
let runningMaintenanceAllowAbort = false;

function hasRunningMaintenance() {
  return !!(runningMaintenance || persistedRunningMaintenance);
}

function setMaintenanceButtonText(item, text) {
  if (item.textEl) item.textEl.textContent = text;
  else item.el.textContent = text;
}

function updateMaintenanceButtons() {
  const activeMaintenance = runningMaintenance || persistedRunningMaintenance;
  maintenanceButtons.forEach(item => {
    const btn = item.el;
    if (!activeMaintenance) {
      btn.disabled = false;
      setMaintenanceButtonText(item, item.defaultText);
      btn.title = item.defaultTitle;
      return;
    }
    if (item.key === activeMaintenance) {
      const locallyOwned = item.key === runningMaintenance;
      btn.disabled = !locallyOwned || !runningMaintenanceAllowAbort;
      setMaintenanceButtonText(item, locallyOwned ? runningMaintenanceActiveText : historyMessage('history_maintenance_running', '実行中…'));
      btn.title = locallyOwned && runningMaintenanceAllowAbort ? historyMessage('history_maintenance_cancel_hint', 'クリックして中止') : item.defaultTitle;
      return;
    }
    btn.disabled = true;
    setMaintenanceButtonText(item, item.defaultText);
    btn.title = historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中');
  });
  updateMaintToggleLock();
}

const maintToggle = document.getElementById('maintToggle');
const maintPanel = document.getElementById('maintPanel');
const MAINT_OPEN_KEY = 'ytwh.maintOpen';

function readMaintOpenPref() {
  try {
    return localStorage.getItem(MAINT_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function setMaintOpen(open, persist = true) {
  if (!maintToggle || !maintPanel) return;
  maintPanel.hidden = !open;
  maintToggle.setAttribute('aria-expanded', String(open));
  if (!persist) return;
  try {
    localStorage.setItem(MAINT_OPEN_KEY, open ? '1' : '0');
  } catch {
    // ストレージが使えなくても開閉自体は成立させる（次回開いたときの既定に戻るだけ）
  }
}

function updateMaintToggleLock() {
  if (!maintToggle) return;
  // 後で見るの操作は折り畳みの外にあり中止ボタンも持たないので、開いたまま固定する理由がない
  const running = runningMaintenance || persistedRunningMaintenance;
  const locked = !!running && running !== 'scanWatchLater';
  // 走っている処理の中止ボタンは折り畳みの中にあるので、実行中は閉じさせない
  if (locked) setMaintOpen(true, false);
  maintToggle.disabled = locked;
  // チャンネル名の再取得は中止ボタンがデータ修復の中にあるので、実行中はそちらも閉じさせない
  const repairToggleEl = document.getElementById('repairToggle');
  const repairPanelEl = document.getElementById('repairPanel');
  const repairLocked = running === 'fixChannelsForce';
  if (repairLocked && repairToggleEl && repairPanelEl) {
    repairPanelEl.hidden = false;
    repairToggleEl.setAttribute('aria-expanded', 'true');
  }
  if (repairToggleEl) repairToggleEl.disabled = repairLocked;
  maintToggle.title = locked ? historyMessage('history_maintenance_locked', '実行中は閉じられません') : '';
}

if (maintToggle && maintPanel) {
  setMaintOpen(readMaintOpenPref(), false);
  const analyzeToggle = document.getElementById('toggleAnalyze');
  // Runs after analyzer.js has flipped the button's active state.
  if (analyzeToggle) analyzeToggle.addEventListener('click', () => setTimeout(() => {
    if (hasRunningMaintenance()) return;
    setMaintOpen(analyzeToggle.classList.contains('active') ? false : readMaintOpenPref(), false);
  }, 0));
  maintToggle.addEventListener('click', () => {
    if (hasRunningMaintenance()) return;
    setMaintOpen(maintPanel.hidden);
  });
}

const repairToggle = document.getElementById('repairToggle');
const repairPanel = document.getElementById('repairPanel');
const repairLastRun = document.getElementById('repairLastRun');
const CREDIT_REPAIR_LAST_RUN_KEY = 'creditRepairLastRunV1';

function formatCreditRepairLastRun(lastRun) {
  if (!lastRun || !['repair', 'restore'].includes(lastRun.kind)) return historyMessage('history_maintenance_never', '最終実行: 未実行');
  const at = Number(lastRun.at);
  if (!Number.isFinite(at) || at <= 0) return historyMessage('history_maintenance_never', '最終実行: 未実行');
  const date = new Date(at);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const values = Math.max(0, Math.trunc(Number(lastRun.values) || 0));
  const videos = Math.max(0, Math.trunc(Number(lastRun.videos) || 0));
  const timestamp = `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  const counts = [values, videos].map(n => n.toLocaleString(historyUILanguage()));
  return lastRun.kind === 'repair'
    ? historyMessage('history_maintenance_last_repair', `最終実行: ${timestamp} · ${counts[0]}件（${counts[1]}動画）を修復`, [timestamp, ...counts])
    : historyMessage('history_maintenance_last_restore', `最終実行: ${timestamp} · ${counts[0]}件（${counts[1]}動画）を元に戻した`, [timestamp, ...counts]);
}

function renderCreditRepairLastRun(lastRun) {
  if (repairLastRun) repairLastRun.textContent = formatCreditRepairLastRun(lastRun);
}

async function loadCreditRepairLastRun() {
  try {
    const stored = await chrome.storage.local.get(CREDIT_REPAIR_LAST_RUN_KEY);
    renderCreditRepairLastRun(stored && stored[CREDIT_REPAIR_LAST_RUN_KEY]);
  } catch (_error) {
    renderCreditRepairLastRun(null);
  }
}

async function saveCreditRepairLastRun(kind, result) {
  const lastRun = {
    kind,
    at: Date.now(),
    runId: result && typeof result.runId === 'string' ? result.runId : null,
    values: Number(result && result.values) || 0,
    videos: Number(result && result.videos) || 0,
  };
  renderCreditRepairLastRun(lastRun);
  try {
    await chrome.storage.local.set({ [CREDIT_REPAIR_LAST_RUN_KEY]: lastRun });
  } catch (_error) {
    // 表示用記録の保存失敗だけで、完了済みの修復・復元を失敗扱いにはしない
  }
}

function setRepairOpen(open) {
  if (!repairToggle || !repairPanel) return;
  repairPanel.hidden = !open;
  repairToggle.setAttribute('aria-expanded', String(open));
  if (open) loadCreditRepairLastRun();
}

if (repairToggle && repairPanel) {
  setRepairOpen(false);
  repairToggle.addEventListener('click', () => setRepairOpen(repairPanel.hidden));
}

function beginMaintenance(key, options = {}) {
  if (hasRunningMaintenance()) return false;
  runningMaintenance = key;
  runningMaintenanceActiveText = options.activeText || historyMessage('history_maintenance_running', '実行中…');
  runningMaintenanceAllowAbort = !!options.allowAbort;
  updateMaintenanceButtons();
  return true;
}

function updateRunningMaintenance(key, options = {}) {
  if (runningMaintenance !== key) return;
  if (options.activeText) runningMaintenanceActiveText = options.activeText;
  if (Object.prototype.hasOwnProperty.call(options, 'allowAbort')) {
    runningMaintenanceAllowAbort = !!options.allowAbort;
  }
  updateMaintenanceButtons();
}

function endMaintenance(key) {
  if (runningMaintenance !== key) return;
  runningMaintenance = null;
  if (persistedRunningMaintenance === key) persistedRunningMaintenance = null;
  runningMaintenanceActiveText = historyMessage('history_maintenance_running', '実行中…');
  runningMaintenanceAllowAbort = false;
  updateMaintenanceButtons();
}

async function loadStoredJobState() {
  try {
    const stored = await chrome.storage.local.get([JOB_CURRENT_KEY, JOB_RECENT_KEY]);
    applyStoredJobState(stored && stored[JOB_CURRENT_KEY], stored && stored[JOB_RECENT_KEY]);
  } catch (_error) {
    renderJob(null, []);
  }
}

if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const current = changes[JOB_CURRENT_KEY] ? changes[JOB_CURRENT_KEY].newValue : displayedJob;
    const recent = changes[JOB_RECENT_KEY] ? changes[JOB_RECENT_KEY].newValue : recentJobs;
    applyStoredJobState(current, recent);
  });
}
loadStoredJobState();

// --- Watch Later 照合（読み取り専用） ---
// 後で見るを全件取得して視聴済みDBと突き合わせ、件数だけを出す。ここでは何も削除しない。
// 長時間ジョブの持ち主を service worker ではなくこの画面側にしているのは、MV3 の
// service worker が待機中に停止しうるため（削除段階でも同じ置き場を使う）。
const scanWatchLaterBtn = document.getElementById('scanWatchLater');

function describeWatchLaterFailure(res) {
  if (res && Array.isArray(res.errors) && res.errors.length) {
    const jp = res.errors.find(e => /[^\x00-\x7F]/.test(e));
    if (jp) return jp;
  }
  const reason = (res && (res.reason || res.error)) || 'unknown';
  const known = {
    'no-youtube-tab': historyMessage('history_wl_no_tab', 'YouTubeのタブを開いた状態で実行してください'),
    'no-items': historyMessage('history_wl_no_items', '後で見るに動画が見つかりません（ログイン状態を確認してください）'),
    'db-check-failed': historyMessage('history_wl_db_failed', '視聴済みデータベースを確認できないため中止しました'),
    'fetch-failed': historyMessage('history_wl_fetch_failed', '後で見るのページを取得できませんでした'),
  };
  return known[reason] || historyMessage('history_wl_failure', ('失敗: ' + reason), [reason]);
}

if (scanWatchLaterBtn) {
  scanWatchLaterBtn.addEventListener('click', () => {
    if (!beginMaintenance('scanWatchLater', { activeText: historyMessage('history_wl_scanning', '照合中…') })) {
      showJobMessage(historyMessage('history_wl_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }
    showJobMessage(historyMessage('history_wl_scan_running', '後で見るを照合中…'), { kind: 'scanWatchLater', label: historyMessage('history_wl_scan_label', '照合'), state: 'running' });
    chrome.runtime.sendMessage({ type: 'SCAN_WATCH_LATER' }, (res) => {
      endMaintenance('scanWatchLater');
      if (chrome.runtime.lastError) {
        showJobMessage(historyMessage('history_wl_failure', '失敗: ' + chrome.runtime.lastError.message, [chrome.runtime.lastError.message]), { kind: 'scanWatchLater', label: historyMessage('history_wl_scan_label', '照合'), state: 'error' });
        return;
      }
      if (!res || !res.success) {
        showJobMessage(describeWatchLaterFailure(res), { kind: 'scanWatchLater', label: historyMessage('history_wl_scan_label', '照合'), state: 'error' });
        return;
      }
      const c = res.counts || {};
      const parts = [
        historyMessage((c.total || 0) === 1 ? 'history_wl_total_one' : 'history_wl_total_many', `後で見る ${c.total || 0}件`, [(c.total || 0)]),
        historyMessage((c.candidates || 0) === 1 ? 'history_wl_matched_one' : 'history_wl_matched_many', `視聴済み一致 ${c.candidates || 0}件`, [(c.candidates || 0)]),
        historyMessage((c.notWatched || 0) === 1 ? 'history_wl_unwatched_one' : 'history_wl_unwatched_many', `未視聴 ${c.notWatched || 0}件`, [(c.notWatched || 0)]),
      ];
      // 判定不能・削除IDなしは0件でも黙らせない。ここを黙って落とすと「一致0件」が
      // 「本当に0件」なのか「DBを読めなかった」のか利用者から区別できなくなる。
      if (c.indeterminate) parts.push(historyMessage(c.indeterminate === 1 ? 'history_wl_indeterminate_one' : 'history_wl_indeterminate_many', `判定不能 ${c.indeterminate}件`, [c.indeterminate]));
      if (c.noSetVideoId) parts.push(historyMessage(c.noSetVideoId === 1 ? 'history_wl_missing_id_one' : 'history_wl_missing_id_many', `削除ID未取得 ${c.noSetVideoId}件`, [c.noSetVideoId]));
      if (c.duplicateVideoId) parts.push(historyMessage(c.duplicateVideoId === 1 ? 'history_wl_duplicates_one' : 'history_wl_duplicates_many', `重複登録 ${c.duplicateVideoId}件`, [c.duplicateVideoId]));
      if (res.partial) parts.push(historyMessage('history_wl_partial', '※全件を取得しきれていません'));
      // Round D の設計判断用の実測値。前回の照合が残っているときだけ出る。
      // 「削除ID変化 0件」が続けば、1回の照合で複数件消せる設計にできる。
      if (res.drift && res.drift.compared) {
        parts.push(historyMessage('history_wl_drift', `前回比 残存${res.drift.compared}件/削除ID変化${res.drift.changed}件`, [res.drift.compared, res.drift.changed]));
      }
      showJobMessage(historyMessage('history_wl_scanned', `後で見るを照合しました: ${parts.join(' / ')}`, [parts.join(' / ')]), { kind: 'scanWatchLater', label: historyMessage('history_wl_scan_label', '照合'), state: 'done' });
      armWatchLaterRemoval(res);
    });
  });
}

// --- Watch Later 1件削除（Round C・取り消せない） ---
// 「削除できるものを全部消す」ではなく、照合の先頭1件だけを名指しで消す。1件消すと
// 残りの setVideoId は YouTube 側で振り直されうるので、service worker 側は成功時に
// 照合結果ごと破棄する。つまりこのボタンは押すたびに照合が要る。
const removeOneWatchLaterBtn = document.getElementById('removeOneWatchLater');
let armedWatchLaterTarget = null;

function armWatchLaterRemoval(res) {
  const preview = res && Array.isArray(res.preview) ? res.preview : [];
  const first = preview[0] || null;
  armedWatchLaterTarget = (first && res.syncSessionId)
    ? { syncSessionId: res.syncSessionId, videoId: first.videoId, title: first.title, channel: first.channel }
    : null;
  if (removeOneWatchLaterBtn) removeOneWatchLaterBtn.disabled = !armedWatchLaterTarget;
  armWatchLaterBatch(res && res.syncSessionId ? res : null, preview);
}

function describeWatchLaterRemovalFailure(res) {
  const reason = (res && (res.reason || res.error)) || 'unknown';
  const known = {
    'no-scan': historyMessage('history_wl_no_scan', '先に「照合」を実行してください'),
    'scan-expired': historyMessage('history_wl_expired', '照合から時間が経ちました。もう一度「照合」してから実行してください'),
    'stale-scan': historyMessage('history_wl_stale', '照合結果が新しくなっています。もう一度「照合」してください'),
    'confirmation-mismatch': historyMessage('history_wl_mismatch', '確認した動画と削除対象が一致しないため中止しました'),
    'no-set-video-id': historyMessage('history_wl_no_id', '削除に必要なIDが取れていないため中止しました'),
    'sync-session-changed': historyMessage('history_wl_session_changed', 'YouTubeのタブまたはアカウントが変わったため中止しました'),
    'sync-tab-unavailable': historyMessage('history_wl_tab_unavailable', '開始時のYouTubeタブが閉じたか応答しないため中止しました'),
    'edit-not-confirmed': historyMessage('history_wl_unconfirmed', 'YouTubeが成功を返さなかったため、消えたかどうか不明です。照合し直して確認してください'),
  };
  return known[reason] || historyMessage('history_wl_failure', ('失敗: ' + reason), [reason]);
}

if (removeOneWatchLaterBtn) {
  removeOneWatchLaterBtn.addEventListener('click', () => {
    const target = armedWatchLaterTarget;
    if (!target) {
      showJobMessage(historyMessage('history_wl_no_scan', '先に「照合」を実行してください'), { state: 'error' });
      return;
    }
    const label = target.title || target.videoId;
    const by = target.channel ? `\n${target.channel}` : '';
    if (!confirm(historyMessage('history_wl_confirm_one', `次の1本を「後で見る」から削除します。取り消せません。\n\n${label}${by}`, [label, by]))) return;
    if (!beginMaintenance('scanWatchLater', { activeText: historyMessage('history_wl_deleting', '削除中…') })) {
      showJobMessage(historyMessage('history_wl_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }
    removeOneWatchLaterBtn.disabled = true;
    chrome.runtime.sendMessage({
      type: 'REMOVE_ONE_WATCH_LATER',
      syncSessionId: target.syncSessionId,
      videoId: target.videoId,
    }, (res) => {
      endMaintenance('scanWatchLater');
      // 成否にかかわらず武装解除する。失敗理由が「消えたか不明」のときに再クリックで
      // 二重削除を試みられるのが一番まずいので、必ず照合からやり直させる。
      armedWatchLaterTarget = null;
      if (chrome.runtime.lastError) {
        showJobMessage(historyMessage('history_wl_failure', '失敗: ' + chrome.runtime.lastError.message, [chrome.runtime.lastError.message]), { state: 'error' });
        return;
      }
      if (!res || !res.success) {
        showJobMessage(describeWatchLaterRemovalFailure(res), { state: 'error' });
        return;
      }
      const removed = res.removed || {};
      showJobMessage(historyMessage('history_wl_removed_single', `後で見るから1件だけ削除しました: ${removed.title || removed.videoId} / 残りを消すにはもう一度「照合」`, [removed.title || removed.videoId]), { state: 'done' });
    });
  });
}

// --- Watch Later まとめて削除（Round D・取り消せない） ---
// 取り消せない操作を10件超まとめて行うので、実行前に対象を全件画面に出して確認してもらう。
// 削除できるのはここに出した動画だけで、実行中に新しく視聴済みになった動画は入らない。
const bulkRemoveWatchLaterBtn = document.getElementById('bulkRemoveWatchLater');
const wlPanel = document.getElementById('wlPanel');
const wlPanelNote = document.getElementById('wlPanelNote');
const wlPanelList = document.getElementById('wlPanelList');
const wlPanelLimit = document.getElementById('wlPanelLimit');
const wlPanelRun = document.getElementById('wlPanelRun');
const wlPanelRunAll = document.getElementById('wlPanelRunAll');
const wlPanelCancel = document.getElementById('wlPanelCancel');
const wlPanelStatus = document.getElementById('wlPanelStatus');
let armedWatchLaterBatch = null;
// 削除中は進捗がこのダイアログの中にしか出ないので、閉じさせない
let wlPanelDeleting = false;
let wlPanelPreviousFocus = null;

function armWatchLaterBatch(res, preview) {
  armedWatchLaterBatch = (res && preview && preview.length)
    ? { syncSessionId: res.syncSessionId, rows: preview, truncated: !!res.previewTruncated }
    : null;
  if (bulkRemoveWatchLaterBtn) bulkRemoveWatchLaterBtn.disabled = !armedWatchLaterBatch;
  if (!armedWatchLaterBatch) closeWatchLaterPanel();
}

function closeWatchLaterPanel() {
  if (!wlPanel || wlPanel.hidden || wlPanelDeleting) return;
  wlPanel.hidden = true;
  wlPanel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('wl-modal-open');
  if (wlPanelStatus) wlPanelStatus.textContent = '';
  if (wlPanelPreviousFocus && typeof wlPanelPreviousFocus.focus === 'function') wlPanelPreviousFocus.focus();
  wlPanelPreviousFocus = null;
}

function openWatchLaterPanel() {
  if (!armedWatchLaterBatch || !wlPanel) return;
  const rows = armedWatchLaterBatch.rows;
  wlPanelList.textContent = '';
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    const idx = document.createElement('span');
    idx.className = 'wl-idx';
    idx.textContent = String(i + 1);
    const title = document.createElement('span');
    title.className = 'wl-title';
    title.textContent = row.title || row.videoId;
    const channel = document.createElement('span');
    channel.className = 'wl-channel';
    channel.textContent = row.channel || '';
    li.append(idx, title, channel);
    wlPanelList.appendChild(li);
  });
  const truncNote = armedWatchLaterBatch.truncated
    ? historyMessage('history_wl_truncated', '（候補が多いため先頭200件のみ表示・削除できるのもこの200件まで）')
    : '';
  wlPanelNote.textContent =
    historyMessage(rows.length === 1 ? 'history_wl_panel_note_one' : 'history_wl_panel_note_many', `視聴済みとして記録がある${rows.length}件です${truncNote}。上から順に削除します。取り消せません。`, [rows.length, truncNote]);
  wlPanelLimit.max = String(rows.length);
  wlPanelLimit.value = String(Math.min(5, rows.length));
  // 全件ボタンは件数まで文言に出す。押した後の確認ダイアログと同じ数がボタンにも見えていないと、
  // 「全件」が一覧の200件までなのか候補すべてなのか読み取れない
  if (wlPanelRunAll) wlPanelRunAll.textContent = `全${rows.length}件を削除`;
  if (wlPanelRunAll) wlPanelRunAll.textContent = historyMessage(rows.length === 1 ? 'history_wl_run_all_one' : 'history_wl_run_all_many', wlPanelRunAll.textContent, [rows.length]);
  wlPanelStatus.textContent = '';
  wlPanelPreviousFocus = document.activeElement || null;
  wlPanel.hidden = false;
  wlPanel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('wl-modal-open');
  wlPanelLimit.focus();
}

function describeBatchStop(stopped) {
  const known = {
    'setvideoid-reassigned': historyMessage('history_wl_reassigned', '削除IDが振り直されたため中止しました（想定外の変化です）'),
    'rescan-failed': historyMessage('history_wl_rescan_failed', '途中の再照合に失敗したため中止しました'),
    'scan-expired': historyMessage('history_wl_batch_expired', '照合から時間が経ったため中止しました'),
    'sync-session-changed': historyMessage('history_wl_session_changed', 'YouTubeのタブまたはアカウントが変わったため中止しました'),
    'sync-tab-unavailable': historyMessage('history_wl_batch_tab', 'YouTubeのタブが閉じたか応答しないため中止しました'),
    'edit-not-confirmed': historyMessage('history_wl_batch_unconfirmed', 'YouTubeが成功を返さなかったため中止しました。照合し直して確認してください'),
    'no-targets': historyMessage('history_wl_no_targets', '削除できる対象がありませんでした'),
    'no-scan': historyMessage('history_wl_scan_lost', '照合結果が失われたため中止しました'),
  };
  return known[stopped] || historyMessage('history_wl_stopped', ('中止: ' + stopped), [stopped]);
}

if (bulkRemoveWatchLaterBtn) {
  bulkRemoveWatchLaterBtn.addEventListener('click', openWatchLaterPanel);
}
if (wlPanelCancel) wlPanelCancel.addEventListener('click', closeWatchLaterPanel);
if (wlPanel) {
  // 背景を押したときだけ閉じる（ダイアログの中を押しても閉じない）
  wlPanel.addEventListener('click', (event) => {
    if (event.target === wlPanel) closeWatchLaterPanel();
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && wlPanel && !wlPanel.hidden) closeWatchLaterPanel();
});

// 数値欄をホイールで増減できるようにする。Chrome の既定はフォーカス中しか効かないので、
// 一覧を読んでから件数を決めるこの画面では「欄へ乗せて回す」だけで動くほうが手数が少ない。
// 取り消せない操作だが、実行前の確認ダイアログに必ず件数が出るので誤操作は止まる。
function attachWheelStepper(input) {
  if (!input) return;
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const step = Number(input.step) || 1;
    const min = input.min === '' ? -Infinity : Number(input.min);
    const max = input.max === '' ? Infinity : Number(input.max);
    const current = Number(input.value) || 0;
    const next = Math.min(max, Math.max(min, current + (event.deltaY < 0 ? step : -step)));
    if (next === current) return;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
}
attachWheelStepper(wlPanelLimit);

function startWatchLaterBatch(requestedLimit) {
  // This function is also run in isolation by the existing panel checks.
  const wlMessage = typeof historyMessage === 'function' ? historyMessage : (_key, fallback) => fallback;
  const armed = armedWatchLaterBatch;
  if (!armed) {
    wlPanelStatus.textContent = wlMessage('history_wl_no_scan', '先に「照合」を実行してください');
    return;
  }
  const rows = armed.rows;
  const limit = Math.max(1, Math.min(Number(requestedLimit) || 0, rows.length));
  const head = rows.slice(0, limit).map(r => r.title || r.videoId);
  const shown = head.slice(0, 5).join('\n');
  const more = head.length > 5 ? wlMessage((head.length - 5) === 1 ? 'history_wl_more_one' : 'history_wl_more_many', `\n… ほか${head.length - 5}件`, [(head.length - 5)]) : '';
  const confirmationKey = limit === rows.length
    ? (limit === 1 ? 'history_wl_confirm_all_one' : 'history_wl_confirm_all_many')
    : (limit === 1 ? 'history_wl_confirm_limited_one' : 'history_wl_confirm_limited_many');
  const fallback = `「後で見る」から${limit === rows.length ? '一覧の全' : ''}${limit}件を削除します。取り消せません。\n\n${shown}${more}`;
  if (!confirm(wlMessage(confirmationKey, fallback, [limit, shown, more]))) return;
  if (!beginMaintenance('scanWatchLater', { activeText: wlMessage('history_wl_deleting', '削除中…') })) {
    wlPanelStatus.textContent = wlMessage('history_wl_busy', '他のメンテナンス処理が実行中');
    return;
  }
  // 押し直しによる二重実行を防ぐ。武装解除は完了時にまとめて行う。
  wlPanelDeleting = true;
  wlPanelRun.disabled = true;
  if (wlPanelRunAll) wlPanelRunAll.disabled = true;
  if (wlPanelCancel) wlPanelCancel.disabled = true;
  if (bulkRemoveWatchLaterBtn) bulkRemoveWatchLaterBtn.disabled = true;
  if (removeOneWatchLaterBtn) removeOneWatchLaterBtn.disabled = true;
  wlPanelStatus.textContent = wlMessage('history_wl_deleting', '削除中…');

  const port = chrome.runtime.connect({ name: 'watch-later-batch' });
  let settled = false;
  const finish = (text, state = 'done', processed = 0, total = limit) => {
    if (settled) return;
    settled = true;
    wlPanelDeleting = false;
    endMaintenance('scanWatchLater');
    wlPanelRun.disabled = false;
    if (wlPanelRunAll) wlPanelRunAll.disabled = false;
    if (wlPanelCancel) wlPanelCancel.disabled = false;
    armedWatchLaterTarget = null;
    armWatchLaterBatch(null, null);
    showJobMessage(text, {
      kind: 'bulkRemoveWatchLater',
      label: wlMessage('history_wl_batch_label', 'まとめて削除'),
      state,
      processed,
      total,
      counters: { removed: processed },
    });
    wlPanelStatus.textContent = '';
    closeWatchLaterPanel();
  };
  port.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS') {
      wlPanelStatus.textContent = wlMessage('history_wl_progress_title', `${msg.done} / ${msg.total} 件目: ${msg.title}`, [msg.done, msg.total, msg.title]);
      showJobMessage(wlMessage(msg.done === 1 ? 'history_wl_progress_one' : 'history_wl_progress_many', `削除中... ${msg.done}/${msg.total}件（削除${msg.done}件）`, [msg.done, msg.total]), {
        kind: 'bulkRemoveWatchLater', label: wlMessage('history_wl_batch_label', 'まとめて削除'), state: 'running',
        processed: msg.done, total: msg.total, counters: { removed: msg.done }, abortable: true,
      });
      return;
    }
    if (msg.type === 'ERROR') {
      finish(wlMessage('history_wl_failure', '失敗: ' + (msg.error || 'unknown'), [msg.error || 'unknown']), 'error');
      return;
    }
    if (msg.type !== 'DONE') return;
    if (!msg.success) {
      finish(describeBatchStop(msg.reason), 'error');
      return;
    }
    const parts = [wlMessage(msg.removed.length === 1 ? 'history_wl_removed_one' : 'history_wl_removed_many', `後で見るから${msg.removed.length}件をまとめて削除しました`, [msg.removed.length])];
    if (msg.stopped) parts.push(describeBatchStop(msg.stopped));
    const c = msg.counts;
    if (c) parts.push(wlMessage('history_wl_remaining', `残り: 後で見る ${c.total}件 / 視聴済み一致 ${c.candidates}件 / 未視聴 ${c.notWatched}件`, [c.total, c.candidates, c.notWatched]));
    if (msg.drift && msg.drift.changed) parts.push(wlMessage(msg.drift.changed === 1 ? 'history_wl_changed_one' : 'history_wl_changed_many', `削除ID変化 ${msg.drift.changed}件`, [msg.drift.changed]));
    if (msg.finalScanFailed) parts.push(wlMessage('history_wl_final_scan_failed', '※削除後の再照合に失敗したため、件数は未確認です'));
    finish(parts.join(' / '), msg.aborted ? 'aborted' : 'done', msg.removed.length, msg.total || limit);
  });
  // service worker が落ちた場合、DONE が来ないまま切断される。
  port.onDisconnect.addListener(() => finish(wlMessage('history_wl_interrupted', '中断しました。照合し直して結果を確認してください'), 'interrupted'));

  // 応答が完全に途絶えたときに「削除中…」のまま固まらないための保険。
  // 削除が進んでいる間は PROGRESS ごとに延長するので、通常の実行では発火しない。
  // 発火時は「消えたか不明」なので、成功とも失敗とも書かず照合し直させる。
  let watchdog = null;
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      finish(wlMessage('history_wl_timeout', '応答がないため中断しました。どこまで削除できたかは照合し直して確認してください'), 'interrupted');
      try { port.disconnect(); } catch (_e) {}
    }, 60000);
  };
  const clearWatchdog = () => { if (watchdog) clearTimeout(watchdog); watchdog = null; };
  port.onMessage.addListener(armWatchdog);
  port.onDisconnect.addListener(clearWatchdog);
  armWatchdog();

  showJobMessage(wlMessage('history_wl_progress_many', `削除中... 0/${limit}件（削除0件）`, [0, limit]), {
    kind: 'bulkRemoveWatchLater', label: wlMessage('history_wl_batch_label', 'まとめて削除'), state: 'running',
    processed: 0, total: limit, counters: { removed: 0 }, abortable: true,
  });

  // 接続しただけでは background は動かない。承認済みの対象と件数を渡して開始する。
  port.postMessage({
    type: 'START',
    syncSessionId: armed.syncSessionId,
    videoIds: rows.map((r) => r.videoId),
    limit,
  });
}

if (wlPanelRun) {
  wlPanelRun.addEventListener('click', () => startWatchLaterBatch(wlPanelLimit.value));
}
if (wlPanelRunAll) {
  wlPanelRunAll.addEventListener('click', () => {
    startWatchLaterBatch(armedWatchLaterBatch ? armedWatchLaterBatch.rows.length : 0);
  });
}

function runFix(videoIds, force, label) {
  if (!videoIds.length) {
    showJobMessage(historyMessage('history_enrich_none', '対象なし'));
    return;
  }
  if (!confirm(historyMessage(force
    ? (videoIds.length === 1 ? 'history_enrich_overwrite_one' : 'history_enrich_overwrite_many')
    : (videoIds.length === 1 ? 'history_enrich_channels_one' : 'history_enrich_channels_many'),
  `${label}: ${videoIds.length}件のチャンネル名をYouTube oEmbed APIで${force ? '上書き' : '補完'}します。続行しますか？`, [label, videoIds.length]))) {
    return;
  }

  const maintenanceKey = force ? 'fixChannelsForce' : 'fixChannels';
  if (!beginMaintenance(maintenanceKey, { activeText: historyMessage('history_enrich_running', '実行中…') })) {
    showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
    return;
  }

  const total = videoIds.length;
  let remaining = total;
  const jobLabel = force ? historyMessage('history_enrich_refetch_label', 'チャンネル名を再取得') : historyMessage('history_enrich_channels_label', 'チャンネル名を補完');
  showJobMessage(historyMessage('history_enrich_channels_progress', `処理中... 残り${remaining}/${total}（更新0 / 失敗0）`, [remaining, total, 0, 0]), {
    kind: maintenanceKey, label: jobLabel,
    state: 'running', total, processed: 0, counters: { updated: 0, failed: 0 }, abortable: true,
  });

  const port = chrome.runtime.connect({ name: 'fix-channels' });
  const finish = () => {
    endMaintenance(maintenanceKey);
  };

  port.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS') {
      remaining = msg.total - msg.processed;

      // Live-update the entry in memory and DOM so the user sees it disappear
      // from the list (when filtered) or update its channel label.
      if (msg.wasUpdated) {
        const rec = allData.find(v => v.videoId === msg.videoId);
        if (rec) {
          if (msg.channel) rec.channel = msg.channel;
          if (msg.title && (force || !rec.title)) rec.title = msg.title;
          historySortCache = null;
        }
        const cacheIdx = sortedCache.findIndex(v => v.videoId === msg.videoId);
        if (cacheIdx !== -1) {
          const stillMatches = !noChannelOnly ||
            (!sortedCache[cacheIdx].channel || sortedCache[cacheIdx].channel.trim() === '');
          // Under noChannelOnly the updated row no longer qualifies — drop it.
          if (noChannelOnly && msg.channel) {
            sortedCache.splice(cacheIdx, 1);
            if (cacheIdx < renderedCount) renderedCount--;
            const rows = content.querySelectorAll('.video-row');
            // Find the row whose videoId matches and remove it.
            for (const row of rows) {
              const idEl = row.querySelector('.video-id');
              if (idEl && idEl.textContent === msg.videoId) {
                row.style.transition = 'opacity 0.2s';
                row.style.opacity = '0';
                setTimeout(() => row.remove(), 200);
                break;
              }
            }
          }
          stillMatches; // silence lint
        }
      }

      updateTotalCount();
      showJobMessage(historyMessage('history_enrich_channels_progress', `処理中... 残り${remaining}/${total}（更新${msg.updated} / 失敗${msg.failed}）`, [remaining, total, msg.updated, msg.failed]), {
        kind: maintenanceKey, label: jobLabel,
        state: 'running', total, processed: msg.processed,
        counters: { updated: msg.updated, failed: msg.failed }, abortable: true,
      });
      return;
    }

    if (msg.type === 'DONE') {
      const outcome = msg.aborted
        ? (force ? historyMessage('history_enrich_refetch_aborted', 'チャンネル名の再取得を中止しました') : historyMessage('history_enrich_channels_aborted', 'チャンネル名の補完を中止しました'))
        : (force ? historyMessage('history_enrich_refetch_done', 'チャンネル名を再取得しました') : historyMessage('history_enrich_channels_done', 'チャンネル名を補完しました'));
      showJobMessage(historyMessage('history_enrich_channels_result', `${outcome}: 更新${msg.updated}件 / 失敗${msg.failed}件 / 処理${msg.processed || 0}/${msg.total}件`, [outcome, msg.updated, msg.failed, msg.processed || 0, msg.total]), {
        kind: maintenanceKey, label: jobLabel,
        state: msg.aborted ? 'aborted' : 'done', total: msg.total, processed: msg.processed || 0,
        counters: { updated: msg.updated, failed: msg.failed },
      });
      // Full reload to re-sort and ensure consistency.
      setTimeout(loadData, 300);
      finish();
      return;
    }

    if (msg.type === 'ERROR') {
      showJobMessage(historyMessage('history_enrich_failed', `失敗: ${msg.error || 'unknown'}`, [msg.error || 'unknown']), {
        kind: maintenanceKey, label: jobLabel, state: 'error', error: msg.error,
      });
      finish();
      return;
    }
  });

  port.onDisconnect.addListener(finish);

  port.postMessage({ type: 'START', videoIds, force });
}

const fixBtn = document.getElementById('fixChannels');
if (fixBtn) {
  fixBtn.addEventListener('click', () => {
    if (hasRunningMaintenance()) {
      showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }
    // Only videos missing channel (across allData, not just visible)
    const targets = allData.filter(v => !v.channel || v.channel.trim() === '').map(v => v.videoId);
    runFix(targets, false, historyMessage('history_enrich_channels_button', 'チャンネル名補完'));
  });
}

// Fix credits (composer/lyricist/arranger) for Topic-channel videos.
let activeCreditsPort = null;
function runFixCredits(videoIds, sources, label, heldBack, participantsOnly = false) {
  // 間隔待ちで今回外れた件数を添える。設定の説明がツールチップにしか無く気づけないため。
  const held = Number(heldBack) > 0 ? Number(heldBack) : 0;
  const heldNote = held
    ? historyMessage(held === 1 ? 'history_enrich_held_one' : 'history_enrich_held_many', `\n\n※前に調べて情報が見つからなかった${held.toLocaleString()}件は、しばらく間隔を空けるため今回は対象外です（「チェック済みスキップ」を外すと全部やり直せます）。`, [held.toLocaleString(historyUILanguage())])
    : '';
  if (!videoIds.length) {
    showJobMessage(held
      ? historyMessage(held === 1 ? 'history_enrich_none_held_one' : 'history_enrich_none_held_many', `対象なし（間隔待ち ${held.toLocaleString()}件）`, [held.toLocaleString(historyUILanguage())])
      : historyMessage('history_enrich_none', '対象なし'));
    return;
  }
  if (!confirm(participantsOnly ? historyMessage('history_participantsConfirm', `${videoIds.length}件の概要欄から参加のみ補完します。作曲・作詞・編曲は変更しません。YouTubeタブを開いたまま続行してください。`, [videoIds.length]) : historyMessage(videoIds.length === 1 ? 'history_enrich_credits_one' : 'history_enrich_credits_many', `${label}: ${videoIds.length}件の動画から作曲/作詞/編曲を概要欄で補完します。続行しますか？${heldNote}\n\n※YouTubeタブを1つ以上開いたままにしてください（Cookie経由でfetchするため）。`, [label, videoIds.length, heldNote]))) {
    return;
  }

  if (!beginMaintenance('fixCredits', { activeText: historyMessage('history_enrich_running_abort', '実行中…（中止）'), allowAbort: true })) {
    showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
    return;
  }

  const total = videoIds.length;
  let remaining = total;
  const fixCreditsBtn = document.getElementById('fixCredits');
  const jobLabel = historyMessage('history_enrich_credits_label', '概要欄からクレジット補完');
  showJobMessage(historyMessage('history_enrich_credits_progress', `処理中... 残り${remaining}/${total}（更新0 / 情報なし0 / 取得失敗0）`, [remaining, total, 0, 0, 0]), {
    kind: 'fixCredits', label: jobLabel, state: 'running',
    total, processed: 0, counters: { updated: 0, noCredits: 0, fetchFailed: 0 }, abortable: true,
  });
  if (fixCreditsBtn) {
    fixCreditsBtn.dataset.mode = 'abort';
  }

  const port = chrome.runtime.connect({ name: 'fix-credits' });
  activeCreditsPort = port;
  const finish = () => {
    activeCreditsPort = null;
    if (fixCreditsBtn) {
      fixCreditsBtn.dataset.mode = '';
    }
    endMaintenance('fixCredits');
  };
  port.onDisconnect.addListener(finish);
  port.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS') {
      remaining = msg.total - msg.processed;
      if (msg.wasUpdated && msg.credits) {
        const rec = allData.find(v => v.videoId === msg.videoId);
        if (rec) {
          if (Array.isArray(msg.credits.participants)) rec.participants = msg.credits.participants;
          if (msg.credits.composer && !rec.composer) rec.composer = msg.credits.composer;
          if (msg.credits.lyricist && !rec.lyricist) rec.lyricist = msg.credits.lyricist;
          if (msg.credits.arranger && !rec.arranger) rec.arranger = msg.credits.arranger;
        }
      }
      showJobMessage(historyMessage('history_enrich_credits_progress', `処理中... 残り${remaining}/${total}（更新${msg.updated} / 情報なし${msg.noCredits} / 取得失敗${msg.fetchFailed}）`, [remaining, total, msg.updated, msg.noCredits, msg.fetchFailed]), {
        kind: 'fixCredits', label: jobLabel, state: 'running',
        total, processed: msg.processed,
        counters: { updated: msg.updated, noCredits: msg.noCredits, fetchFailed: msg.fetchFailed }, abortable: true,
      });
      if (msg.processed % 50 === 0 && msg.failReasons) {
        console.log('[Fix Credits] progress', msg.processed, 'failReasons:', msg.failReasons);
      }
      return;
    }
    if (msg.type === 'DONE') {
      const reasons = msg.failReasons && Object.keys(msg.failReasons).length
        ? ` [${Object.entries(msg.failReasons).map(([k, v]) => `${k}:${v}`).join(', ')}]`
        : '';
      let prefix = historyMessage('history_enrich_credits_done', '概要欄からクレジットを補完しました');
      if (msg.autoStopped) prefix = historyMessage('history_enrich_credits_stopped', '概要欄からのクレジット補完を自動停止しました（Googleのbot検知 / 時間を空けて再実行）');
      else if (msg.aborted) prefix = historyMessage('history_enrich_credits_aborted', '概要欄からのクレジット補完を中止しました');
      showJobMessage(historyMessage('history_enrich_credits_result', `${prefix}: 更新${msg.updated} / 情報なし${msg.noCredits} / 取得失敗${msg.fetchFailed} / 処理${msg.processed || 0}/${msg.total}${reasons}`, [prefix, msg.updated, msg.noCredits, msg.fetchFailed, msg.processed || 0, msg.total, reasons]), {
        kind: 'fixCredits', label: jobLabel, state: msg.aborted ? 'aborted' : 'done',
        total: msg.total, processed: msg.processed || 0,
        counters: { updated: msg.updated, noCredits: msg.noCredits, fetchFailed: msg.fetchFailed },
      });
      console.log('[Fix Credits] failReasons:', msg.failReasons);
      setTimeout(loadData, 300);
      finish();
      return;
    }
    if (msg.type === 'ERROR') {
      showJobMessage(historyMessage('history_enrich_failed', `失敗: ${msg.error || 'unknown'}`, [msg.error || 'unknown']), {
        kind: 'fixCredits', label: jobLabel, state: 'error', error: msg.error,
      });
      finish();
    }
  });
  port.postMessage({ type: 'START', videoIds, sources, force: false, participantsOnly });
}

const fixCreditsBtn = document.getElementById('fixCredits');
if (fixCreditsBtn) {
  fixCreditsBtn.addEventListener('click', () => {
    if (fixCreditsBtn.dataset.mode === 'abort' && activeCreditsPort) {
      try { activeCreditsPort.postMessage({ type: 'ABORT' }); } catch (_e) {}
      showJobMessage(historyMessage('history_enrich_aborting_status', '中止中...'), {
        kind: 'fixCredits', label: historyMessage('history_enrich_credits_label', '概要欄からクレジット補完'), state: 'running', abortable: true,
      });
      updateRunningMaintenance('fixCredits', { activeText: historyMessage('history_enrich_aborting_button', '中止中…'), allowAbort: true });
      return;
    }
    if (hasRunningMaintenance()) {
      showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }
    // Topicチャンネル優先。「一般も含める」ONなら非Topicも対象。
    const skipChecked = document.getElementById('skipCreditsChecked');
    const skip = !!(skipChecked && skipChecked.checked);
    const includeGeneral = document.getElementById('includeGeneralCredits');
    const includeGen = !!(includeGeneral && includeGeneral.checked);
    const sources = {};
    const participantsOnly = !!document.getElementById('participantsOnly')?.checked;
    const isTarget = participantsOnly ? window.CreditTarget.isParticipantCreditsTarget : window.CreditTarget.isFixCreditsTarget;
    // Role-unit targeting + re-fetch cool-down (HANDOFF §3.1/§3.4 lightweight).
    // OLD behavior excluded a video as soon as ANY role or creditsRaw was present,
    // permanently stranding partial-credit videos ("composer filled, arranger
    // blank"). CreditTarget.isFixCreditsTarget now includes a video while any of
    // composer/lyricist/arranger is blank, and (when "チェック済みスキップ" is on)
    // skips only videos re-checked within the cool-down window — so re-reading an
    // unchanged 概要欄 every run can't hammer YouTube, but a video checked long ago
    // (parser improved / description edited) becomes eligible again.
    const now = Date.now();
    const inScope = allData.filter(v => {
      if (!v.channel) return false;
      const isTopic = window.CreditTarget.isTopicChannelName(v.channel);
      return isTopic || includeGen;
    });
    const targets = inScope
      .filter(v => isTarget(v, { skipChecked: skip, now }))
      .map(v => {
        sources[v.videoId] = window.CreditTarget.isTopicChannelName(v.channel) ? 'topic' : 'general';
        return v.videoId;
      });
    // 役割は空いているのに、再取得の間隔待ちで今回だけ外れた数。
    const heldBack = skip
      ? inScope.filter(v => (participantsOnly || window.CreditTarget.hasMissingCreditRole(v))
          && !isTarget(v, { skipChecked: true, now })).length
      : 0;
    const label = includeGen ? historyMessage('history_enrich_general_label', 'クレジット補完（Topic+一般）') : historyMessage('history_enrich_topic_label', 'Topic動画のクレジット補完');
    runFixCredits(targets, sources, label, heldBack, participantsOnly);
  });
}

function sendHistoryDbRpc(op, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'DB_RPC', op, ...payload }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response || !response.success) {
        reject(new Error((response && response.error) || 'DB request failed'));
        return;
      }
      resolve(response.result);
    });
  });
}

const repairCreditsBtn = document.getElementById('repairCredits');
if (repairCreditsBtn) {
  repairCreditsBtn.addEventListener('click', async () => {
    if (!beginMaintenance('repairCredits', { activeText: historyMessage('history_repair_checking', '確認中…') })) {
      showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }

    try {
      showJobMessage(historyMessage('history_repair_preview', 'クレジットの不正値を確認中…'), {
        kind: 'repairCredits', label: historyMessage('history_repair_label', 'クレジットの不正値を修復'), state: 'running',
      });
      const preview = await sendHistoryDbRpc('REPAIR_INVALID_CREDITS', { dryRun: true });
      if (preview.mismatch) {
        showJobMessage(historyMessage('history_repair_preview_changed', '別の下見が開始されたため、もう一度確認してください。'), {
          kind: 'repairCredits', label: historyMessage('history_repair_label', 'クレジットの不正値を修復'), state: 'error',
        });
        return;
      }
      if (preview.values === 0) {
        showJobMessage(historyMessage('history_repair_none', '修復対象はありません'), {
          kind: 'repairCredits', label: historyMessage('history_repair_label', 'クレジットの不正値を修復'), state: 'done',
        });
        return;
      }

      const byRole = preview.byRole || {};
      const confirmed = confirm(
        historyMessage('history_repair_confirm',
        `クレジットの不正値 ${preview.values.toLocaleString()}件（${preview.videos.toLocaleString()}動画）を修復します。\n`
        + `内訳: 作曲 ${Number(byRole.composer || 0).toLocaleString()}件 / 作詞 ${Number(byRole.lyricist || 0).toLocaleString()}件 / 編曲 ${Number(byRole.arranger || 0).toLocaleString()}件\n\n`
        + '不正値を空欄へ戻し、補完対象に復帰させます。元の値は記録に残ります。続行しますか？',
        [preview.values, preview.videos, Number(byRole.composer || 0), Number(byRole.lyricist || 0), Number(byRole.arranger || 0)].map(n => n.toLocaleString(historyUILanguage())))
      );
      if (!confirmed) {
        showJobMessage(historyMessage('history_repair_canceled', 'クレジットの不正値修復をキャンセルしました'), {
          kind: 'repairCredits', label: historyMessage('history_repair_label', 'クレジットの不正値を修復'), state: 'aborted',
        });
        return;
      }

      updateRunningMaintenance('repairCredits', { activeText: historyMessage('history_repair_running_button', '修復中…') });
      showJobMessage(historyMessage('history_repair_running', 'クレジットの不正値を修復中…'), {
        kind: 'repairCredits', label: historyMessage('history_repair_label', 'クレジットの不正値を修復'), state: 'running',
      });
      const applied = await sendHistoryDbRpc('REPAIR_INVALID_CREDITS', {
        dryRun: false,
        expectedValues: preview.values,
        token: preview.token,
      });
      if (applied.mismatch) {
        showJobMessage(
          historyMessage('history_repair_mismatch', '下見情報が無効になったか対象が変わったため、修復しませんでした。もう一度確認してください。'),
          { kind: 'repairCredits', label: historyMessage('history_repair_label', 'クレジットの不正値を修復'), state: 'error' }
        );
        return;
      }
      await saveCreditRepairLastRun('repair', applied);
      const verified = await sendHistoryDbRpc('VERIFY_CREDIT_REPAIR', { runId: applied.runId });
      const verificationOk = verified.remainingInvalid === 0
        && verified.loggedTotal === applied.values
        && verified.loggedStillValid === 0
        && verified.restorable === verified.loggedTotal;
      showJobMessage(
        historyMessage('history_repair_result',
        `クレジットの不正値を修復しました: ${applied.values.toLocaleString()}件（${applied.videos.toLocaleString()}動画）\n`
        + `自己点検: 残存不正値 ${verified.remainingInvalid.toLocaleString()}件 / 記録 ${verified.loggedTotal.toLocaleString()}件 / 正常値の巻き込み ${verified.loggedStillValid.toLocaleString()}件 / 復元可能 ${verified.restorable.toLocaleString()}件\n`
        + 'この自己点検では、判定基準そのものは検証していません。',
        [applied.values, applied.videos, verified.remainingInvalid, verified.loggedTotal, verified.loggedStillValid, verified.restorable].map(n => n.toLocaleString(historyUILanguage()))),
        {
          kind: 'repairCredits', label: historyMessage('history_repair_label', 'クレジットの不正値を修復'), state: verificationOk ? 'done' : 'error',
          total: applied.values, processed: applied.values, counters: applied.byRole,
        }
      );
      setTimeout(loadData, 300);
    } catch (error) {
      showJobMessage(historyMessage('history_repair_failed', `クレジットの不正値修復に失敗しました: ${error.message}`, [error.message]), {
        kind: 'repairCredits', label: historyMessage('history_repair_label', 'クレジットの不正値を修復'), state: 'error', error: error.message,
      });
    } finally {
      endMaintenance('repairCredits');
    }
  });
}

const restoreCreditsBtn = document.getElementById('restoreCredits');
if (restoreCreditsBtn) {
  restoreCreditsBtn.addEventListener('click', async () => {
    if (!beginMaintenance('restoreCredits', { activeText: historyMessage('history_repair_checking', '確認中…') })) {
      showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }

    try {
      showJobMessage(historyMessage('history_restore_preview', '元に戻せるクレジットを確認中…'), {
        kind: 'restoreCredits', label: historyMessage('history_restore_label', '修復を元に戻す'), state: 'running',
      });
      const preview = await sendHistoryDbRpc('RESTORE_REPAIRED_CREDITS', { dryRun: true });
      if (preview.mismatch) {
        showJobMessage(historyMessage('history_repair_preview_changed', '別の下見が開始されたため、もう一度確認してください。'), {
          kind: 'restoreCredits', label: historyMessage('history_restore_label', '修復を元に戻す'), state: 'error',
        });
        return;
      }
      if (preview.values === 0) {
        const skipped = Number(preview.skipped) || 0;
        showJobMessage(
          skipped
            ? historyMessage('history_restore_none_skipped', `元に戻せるクレジットはありません（現在値が入っているため ${skipped.toLocaleString()}件スキップ）`, [skipped.toLocaleString(historyUILanguage())])
            : historyMessage('history_restore_none', '元に戻せるクレジットはありません'),
          { kind: 'restoreCredits', label: historyMessage('history_restore_label', '修復を元に戻す'), state: 'done' }
        );
        return;
      }

      const byRole = preview.byRole || {};
      const confirmed = confirm(
        historyMessage('history_restore_confirm',
        `修復前のクレジット ${preview.values.toLocaleString()}件（${preview.videos.toLocaleString()}動画）を元に戻します。\n`
        + `内訳: 作曲 ${Number(byRole.composer || 0).toLocaleString()}件 / 作詞 ${Number(byRole.lyricist || 0).toLocaleString()}件 / 編曲 ${Number(byRole.arranger || 0).toLocaleString()}件\n`
        + `現在値が入っているため上書きしない役割: ${Number(preview.skipped || 0).toLocaleString()}件\n\n続行しますか？`,
        [preview.values, preview.videos, Number(byRole.composer || 0), Number(byRole.lyricist || 0), Number(byRole.arranger || 0), Number(preview.skipped || 0)].map(n => n.toLocaleString(historyUILanguage())))
      );
      if (!confirmed) {
        showJobMessage(historyMessage('history_restore_canceled', 'クレジット修復の取り消しをキャンセルしました'), {
          kind: 'restoreCredits', label: historyMessage('history_restore_label', '修復を元に戻す'), state: 'aborted',
        });
        return;
      }

      updateRunningMaintenance('restoreCredits', { activeText: historyMessage('history_restore_running_button', '復元中…') });
      showJobMessage(historyMessage('history_restore_running', '修復前のクレジットを復元中…'), {
        kind: 'restoreCredits', label: historyMessage('history_restore_label', '修復を元に戻す'), state: 'running',
      });
      const restored = await sendHistoryDbRpc('RESTORE_REPAIRED_CREDITS', {
        dryRun: false,
        expectedValues: preview.values,
        token: preview.token,
      });
      if (restored.mismatch) {
        showJobMessage(
          historyMessage('history_restore_mismatch', '下見情報が無効になったか復元対象が変わったため、復元しませんでした。もう一度確認してください。'),
          { kind: 'restoreCredits', label: historyMessage('history_restore_label', '修復を元に戻す'), state: 'error' }
        );
        return;
      }
      await saveCreditRepairLastRun('restore', restored);
      showJobMessage(
        historyMessage('history_restore_result', `修復前のクレジットを復元しました: ${restored.values.toLocaleString()}件（${restored.videos.toLocaleString()}動画） / 上書きせずスキップ ${Number(restored.skipped || 0).toLocaleString()}件`,
          [restored.values, restored.videos, Number(restored.skipped || 0)].map(n => n.toLocaleString(historyUILanguage()))),
        {
          kind: 'restoreCredits', label: historyMessage('history_restore_label', '修復を元に戻す'), state: 'done',
          total: restored.values, processed: restored.values, counters: restored.byRole,
        }
      );
      setTimeout(loadData, 300);
    } catch (error) {
      showJobMessage(historyMessage('history_restore_failed', `クレジット修復の取り消しに失敗しました: ${error.message}`, [error.message]), {
        kind: 'restoreCredits', label: historyMessage('history_restore_label', '修復を元に戻す'), state: 'error', error: error.message,
      });
    } finally {
      endMaintenance('restoreCredits');
    }
  });
}

const enrichCreditsBtn = document.getElementById('enrichCredits');
let enrichCreditsController = null;
if (enrichCreditsBtn && window.EnrichCredits) {
  enrichCreditsController = window.EnrichCredits.create({
    getRecords: () => allData,
    notify: (message) => { showJobMessage(message, { label: historyMessage('history_repair_external_label', 'クレジット補完（外部DB）') }); },
    reloadData: () => loadData(),
    beginMaintenance: (activeText, allowAbort) => beginMaintenance('enrichCredits', { activeText, allowAbort }),
    updateMaintenance: (activeText, allowAbort) => updateRunningMaintenance('enrichCredits', { activeText, allowAbort }),
    endMaintenance: () => endMaintenance('enrichCredits'),
  });

  enrichCreditsBtn.addEventListener('click', () => {
    if (hasRunningMaintenance() && runningMaintenance !== 'enrichCredits') {
      showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }
    enrichCreditsController.open();
  });
}

const creditReviewBtn = document.getElementById('creditReviewOpen');
let creditReviewController = null;
if (creditReviewBtn && window.CreditReview && window.CreditMaintenanceUI) {
  creditReviewController = window.CreditMaintenanceUI.create({
    getRecords: () => allData,
    saveCreditRole: async payload => {
      const result = await sendHistoryDbRpc('SET_MANUAL_CREDIT_ROLE', payload);
      if (result && result.updated) loadData();
      return result;
    },
    markRechecked: async (videoId, stamp) => {
      const result = await sendHistoryDbRpc('MARK_CREDITS_RECHECKED', { videoId, stamp });
      const live = allData.find(record => record.videoId === videoId);
      if (live && result === true) live.creditsRecheck = stamp;
      return result;
    },
    begin: () => beginMaintenance('recheckCredits', { allowAbort: true }),
    end: () => endMaintenance('recheckCredits'),
  });
}

let activeDurationsPort = null;
function runFixDurations(videoIds) {
  if (!videoIds.length) {
    showJobMessage(historyMessage('history_enrich_none', '対象なし'));
    return;
  }
  if (!confirm(historyMessage(videoIds.length === 1 ? 'history_duration_confirm_one' : 'history_duration_confirm_many', `動画時間補完: ${videoIds.length}件の動画時間をwatchページから補完します。続行しますか？\n\n※YouTubeタブを1つ以上開いたままにしてください（Cookie経由でfetchするため）。ライブ動画は -1 として記録します。`, [videoIds.length]))) {
    return;
  }

  if (!beginMaintenance('fixDurations', { activeText: historyMessage('history_enrich_running_abort', '実行中…（中止）'), allowAbort: true })) {
    showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
    return;
  }

  const total = videoIds.length;
  let remaining = total;
  const btn = document.getElementById('fixDurations');
  showJobMessage(historyMessage('history_duration_progress', `処理中... 残り${remaining}/${total}（更新0 / ライブ0 / 取得失敗0）`, [remaining, total, 0, 0, 0]), {
    kind: 'fixDurations', label: historyMessage('history_duration_label', '動画の長さを補完'), state: 'running',
    total, processed: 0, counters: { updated: 0, live: 0, fetchFailed: 0 }, abortable: true,
  });
  if (btn) {
    btn.dataset.mode = 'abort';
  }

  const port = chrome.runtime.connect({ name: 'fix-durations' });
  activeDurationsPort = port;
  const finish = () => {
    activeDurationsPort = null;
    if (btn) {
      btn.dataset.mode = '';
    }
    endMaintenance('fixDurations');
  };
  port.onDisconnect.addListener(finish);
  port.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS') {
      remaining = msg.total - msg.processed;
      const rec = allData.find(v => v.videoId === msg.videoId);
      if (rec && msg.wasUpdated) {
        rec.durationSec = msg.durationSec;
        delete rec.durationFetchFailed;
      } else if (rec && msg.reason && msg.reason.startsWith('playability-')) {
        rec.durationSec = null;
        rec.durationFetchFailed = msg.reason;
      }
      showJobMessage(historyMessage('history_duration_progress', `処理中... 残り${remaining}/${total}（更新${msg.updated} / ライブ${msg.live} / 取得失敗${msg.fetchFailed}）`, [remaining, total, msg.updated, msg.live, msg.fetchFailed]), {
        kind: 'fixDurations', label: historyMessage('history_duration_label', '動画の長さを補完'), state: 'running',
        total, processed: msg.processed,
        counters: { updated: msg.updated, live: msg.live, fetchFailed: msg.fetchFailed }, abortable: true,
      });
      return;
    }
    if (msg.type === 'DONE') {
      const reasons = msg.failReasons && Object.keys(msg.failReasons).length
        ? ` [${Object.entries(msg.failReasons).map(([k, v]) => `${k}:${v}`).join(', ')}]`
        : '';
      let prefix = historyMessage('history_duration_done', '動画の長さを補完しました');
      if (msg.autoStopped) prefix = historyMessage('history_duration_stopped', '動画の長さの補完を自動停止しました（Googleのbot検知 / 時間を空けて再実行）');
      else if (msg.aborted) prefix = historyMessage('history_duration_aborted', '動画の長さの補完を中止しました');
      showJobMessage(historyMessage('history_duration_result', `${prefix}: 更新${msg.updated} / ライブ${msg.live} / 取得失敗${msg.fetchFailed} / 処理${msg.processed || 0}/${msg.total}${reasons}`, [prefix, msg.updated, msg.live, msg.fetchFailed, msg.processed || 0, msg.total, reasons]), {
        kind: 'fixDurations', label: historyMessage('history_duration_label', '動画の長さを補完'), state: msg.aborted ? 'aborted' : 'done',
        total: msg.total, processed: msg.processed || 0,
        counters: { updated: msg.updated, live: msg.live, fetchFailed: msg.fetchFailed },
      });
      setTimeout(loadData, 300);
      finish();
      return;
    }
    if (msg.type === 'ERROR') {
      showJobMessage(historyMessage('history_enrich_failed', `失敗: ${msg.error || 'unknown'}`, [msg.error || 'unknown']), {
        kind: 'fixDurations', label: historyMessage('history_duration_label', '動画の長さを補完'), state: 'error', error: msg.error,
      });
      finish();
    }
  });
  port.postMessage({ type: 'START', videoIds });
}

const fixDurationsBtn = document.getElementById('fixDurations');
if (fixDurationsBtn) {
  fixDurationsBtn.addEventListener('click', () => {
    if (fixDurationsBtn.dataset.mode === 'abort' && activeDurationsPort) {
      try { activeDurationsPort.postMessage({ type: 'ABORT' }); } catch (_e) {}
      showJobMessage(historyMessage('history_enrich_aborting_status', '中止中...'), {
        kind: 'fixDurations', label: historyMessage('history_duration_label', '動画の長さを補完'), state: 'running', abortable: true,
      });
      updateRunningMaintenance('fixDurations', { activeText: historyMessage('history_enrich_aborting_button', '中止中…'), allowAbort: true });
      return;
    }
    if (hasRunningMaintenance()) {
      showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }
    const targets = allData
      .filter(v => v.durationSec == null && !v.durationFetchFailed)
      .map(v => v.videoId);
    runFixDurations(targets);
  });
}

const fixForceBtn = document.getElementById('fixChannelsForce');
if (fixForceBtn) {
  fixForceBtn.addEventListener('click', () => {
    if (hasRunningMaintenance()) {
      showJobMessage(historyMessage('history_enrich_busy', '他のメンテナンス処理が実行中'), { state: 'error' });
      return;
    }
    // Force-overwrite for currently visible (filtered+sorted) entries
    const targets = sortedCache.map(v => v.videoId);
    runFix(targets, true, historyMessage('history_repair_force_label', '強制上書き補正（表示中の全件）'));
  });
}

// Search (debounced)
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 250);
});

// Load data from extension
function loadData() {
  // A fresh export must not replace the objects/ranks needed by pending Undo or failure recovery.
  if (unsettledDeletes.size) {
    reloadAfterDeletes = true;
    return;
  }
  const revision = historyDataRevision;
  const generation = ++historyLoadGeneration;
  let responded = false;
  function clearLoadedHistory() {
    allData = [];
    historySortCache = null;
    sortedCache = [];
    renderedCount = 0;
    lastDateKeyRendered = '';
    updateTotalCount();
  }

  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      if (generation !== historyLoadGeneration) return;
      if (revision !== historyDataRevision || unsettledDeletes.size) {
        loadData();
        return;
      }
      clearLoadedHistory();
      content.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = historyMessage('history_load_timeout', 'データを読み込めませんでした。拡張機能を再読み込みしてから、開き直してください。');
      content.appendChild(empty);
    }
  }, 5000);

  try {
    chrome.runtime.sendMessage({ type: 'EXPORT_DATA' }, (data) => {
      if (responded) return;
      responded = true;
      clearTimeout(timeout);
      if (generation !== historyLoadGeneration) return;
      // A delete may settle after this export captured its DB snapshot. Fetch again instead of resurrecting it.
      if (revision !== historyDataRevision || unsettledDeletes.size) {
        loadData();
        return;
      }

      if (chrome.runtime.lastError) {
        clearLoadedHistory();
        content.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'empty';
        errDiv.textContent = historyMessage('history_load_error', 'Error: ' + chrome.runtime.lastError.message, [chrome.runtime.lastError.message]);
        content.appendChild(errDiv);
        return;
      }

      if (data && data.__error) {
        clearLoadedHistory();
        content.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'empty';
        errDiv.style.padding = '24px';
        errDiv.style.lineHeight = '1.6';
        errDiv.style.whiteSpace = 'pre-line';
        errDiv.textContent = historyMessage('history_db_error', 'DB読み込みエラー: ' + (data.message || 'unknown') +
          '\n\n復旧手順:\n' +
          '1. すべてのYouTubeタブを閉じる（リロードではなく閉じる）\n' +
          '2. chrome://extensions で拡張をリロード\n' +
          '3. 新しくYouTubeを開いてからこの画面を再読込', [data.message || 'unknown']);
        content.appendChild(errDiv);
        return;
      }

      const records = unwrapWatchedRecords(data);
      if (records.length > 0) {
        allData = records;
      } else {
        allData = [];
      }
      render();
    });
  } catch (e) {
    responded = true;
    clearTimeout(timeout);
    if (generation !== historyLoadGeneration) return;
    clearLoadedHistory();
    content.textContent = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'empty';
    errDiv.textContent = historyMessage('history_load_error', 'Error: ' + e.message, [e.message]);
    content.appendChild(errDiv);
  }
}

loadData();
