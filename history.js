// History viewer script for YouTube Watched Hider
// Separated from history.html for Manifest V3 CSP compliance
// Uses incremental rendering to avoid UI freeze with large datasets

const content = document.getElementById('content');
const searchInput = document.getElementById('search');
const totalCountEl = document.getElementById('totalCount');
const sortBtns = document.querySelectorAll('.sort-btn');

let allData = [];
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

// Delete a video entry
function deleteVideo(videoId, rowEl) {
  chrome.runtime.sendMessage({ type: 'DELETE_VIDEO', videoId }, (res) => {
    if (res && res.success) {
      // Remove from data arrays
      allData = allData.filter(v => v.videoId !== videoId);
      sortedCache = sortedCache.filter(v => v.videoId !== videoId);
      totalCountEl.textContent = sortedCache.length.toLocaleString();
      // Fade out and remove from DOM
      rowEl.style.transition = 'opacity 0.2s';
      rowEl.style.opacity = '0';
      setTimeout(() => rowEl.remove(), 200);
    }
  });
}

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
      ? 'Detected via YouTube seekbar'
      : 'Imported from YouTube history';
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
  delBtn.title = 'Remove from history';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteVideo(video.videoId, row);
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
  let filtered = allData;
  if (filter) {
    filtered = filtered.filter(v =>
      (v.title || v.videoId).toLowerCase().includes(filter) ||
      (v.channel || '').toLowerCase().includes(filter) ||
      v.videoId.toLowerCase().includes(filter)
    );
  }
  if (noChannelOnly) {
    filtered = filtered.filter(v => !v.channel || v.channel.trim() === '');
  }

  sortedCache = sortData(filtered, currentSort);
  totalCountEl.textContent = sortedCache.length.toLocaleString();
  renderedCount = 0;
  lastDateKeyRendered = '';

  if (sortedCache.length === 0) {
    content.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '該当する動画はありません。検索語や絞り込みを外してみてください。';
    content.appendChild(empty);
    return;
  }

  content.textContent = '';
  renderBatch();
}

// Infinite scroll: load more when near bottom
window.addEventListener('scroll', () => {
  if (renderedCount >= sortedCache.length) return;
  // Load more when within 300px of bottom
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 300) {
    renderBatch();
  }
});

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

const maintenanceButtons = [
  { key: 'fixChannels', el: document.getElementById('fixChannels') },
  { key: 'fixChannelsForce', el: document.getElementById('fixChannelsForce') },
  { key: 'fixCredits', el: document.getElementById('fixCredits') },
  { key: 'enrichCredits', el: document.getElementById('enrichCredits') },
  { key: 'fixDurations', el: document.getElementById('fixDurations') },
  { key: 'scanWatchLater', el: document.getElementById('scanWatchLater') },
].filter(item => item.el).map(item => ({
  ...item,
  defaultText: item.el.textContent,
  defaultTitle: item.el.title,
}));
let runningMaintenance = null;
let runningMaintenanceActiveText = '実行中…';
let runningMaintenanceAllowAbort = false;

function updateMaintenanceButtons() {
  maintenanceButtons.forEach(item => {
    const btn = item.el;
    if (!runningMaintenance) {
      btn.disabled = false;
      btn.textContent = item.defaultText;
      btn.title = item.defaultTitle;
      return;
    }
    if (item.key === runningMaintenance) {
      btn.disabled = !runningMaintenanceAllowAbort;
      btn.textContent = runningMaintenanceActiveText;
      btn.title = runningMaintenanceAllowAbort ? 'クリックして中止' : item.defaultTitle;
      return;
    }
    btn.disabled = true;
    btn.textContent = item.defaultText;
    btn.title = '他のメンテナンス処理が実行中';
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
  const locked = !!runningMaintenance;
  // 走っている処理の中止ボタンは折り畳みの中にあるので、実行中は閉じさせない
  if (locked) setMaintOpen(true, false);
  maintToggle.disabled = locked;
  maintToggle.title = locked ? '実行中は閉じられません' : '';
}

if (maintToggle && maintPanel) {
  setMaintOpen(readMaintOpenPref(), false);
  maintToggle.addEventListener('click', () => {
    if (runningMaintenance) return;
    setMaintOpen(maintPanel.hidden);
  });
}

function beginMaintenance(key, options = {}) {
  if (runningMaintenance) return false;
  runningMaintenance = key;
  runningMaintenanceActiveText = options.activeText || '実行中…';
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
  runningMaintenanceActiveText = '実行中…';
  runningMaintenanceAllowAbort = false;
  updateMaintenanceButtons();
}

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
    'no-youtube-tab': 'YouTubeのタブを開いた状態で実行してください',
    'no-items': '後で見るに動画が見つかりません（ログイン状態を確認してください）',
    'db-check-failed': '視聴済みデータベースを確認できないため中止しました',
    'fetch-failed': '後で見るのページを取得できませんでした',
  };
  return known[reason] || ('失敗: ' + reason);
}

if (scanWatchLaterBtn) {
  scanWatchLaterBtn.addEventListener('click', () => {
    if (!beginMaintenance('scanWatchLater', { activeText: '照合中…' })) {
      fixStatus.textContent = '他のメンテナンス処理が実行中';
      return;
    }
    fixStatus.textContent = '後で見るを取得中…';
    chrome.runtime.sendMessage({ type: 'SCAN_WATCH_LATER' }, (res) => {
      endMaintenance('scanWatchLater');
      if (chrome.runtime.lastError) {
        fixStatus.textContent = '失敗: ' + chrome.runtime.lastError.message;
        return;
      }
      if (!res || !res.success) {
        fixStatus.textContent = describeWatchLaterFailure(res);
        return;
      }
      const c = res.counts || {};
      const parts = [
        `後で見る ${c.total || 0}件`,
        `視聴済み一致 ${c.candidates || 0}件`,
        `未視聴 ${c.notWatched || 0}件`,
      ];
      // 判定不能・削除IDなしは0件でも黙らせない。ここを黙って落とすと「一致0件」が
      // 「本当に0件」なのか「DBを読めなかった」のか利用者から区別できなくなる。
      if (c.indeterminate) parts.push(`判定不能 ${c.indeterminate}件`);
      if (c.noSetVideoId) parts.push(`削除ID未取得 ${c.noSetVideoId}件`);
      if (c.duplicateVideoId) parts.push(`重複登録 ${c.duplicateVideoId}件`);
      if (res.partial) parts.push('※全件を取得しきれていません');
      // Round D の設計判断用の実測値。前回の照合が残っているときだけ出る。
      // 「削除ID変化 0件」が続けば、1回の照合で複数件消せる設計にできる。
      if (res.drift && res.drift.compared) {
        parts.push(`前回比 残存${res.drift.compared}件/削除ID変化${res.drift.changed}件`);
      }
      fixStatus.textContent = parts.join(' / ');
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
    'no-scan': '先に「照合」を実行してください',
    'scan-expired': '照合から時間が経ちました。もう一度「照合」してから実行してください',
    'stale-scan': '照合結果が新しくなっています。もう一度「照合」してください',
    'confirmation-mismatch': '確認した動画と削除対象が一致しないため中止しました',
    'no-set-video-id': '削除に必要なIDが取れていないため中止しました',
    'sync-session-changed': 'YouTubeのタブまたはアカウントが変わったため中止しました',
    'sync-tab-unavailable': '開始時のYouTubeタブが閉じたか応答しないため中止しました',
    'edit-not-confirmed': 'YouTubeが成功を返さなかったため、消えたかどうか不明です。照合し直して確認してください',
  };
  return known[reason] || ('失敗: ' + reason);
}

if (removeOneWatchLaterBtn) {
  removeOneWatchLaterBtn.addEventListener('click', () => {
    const target = armedWatchLaterTarget;
    if (!target) {
      fixStatus.textContent = '先に「照合」を実行してください';
      return;
    }
    const label = target.title || target.videoId;
    const by = target.channel ? `\n${target.channel}` : '';
    if (!confirm(`次の1本を「後で見る」から削除します。取り消せません。\n\n${label}${by}`)) return;
    if (!beginMaintenance('scanWatchLater', { activeText: '削除中…' })) {
      fixStatus.textContent = '他のメンテナンス処理が実行中';
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
        fixStatus.textContent = '失敗: ' + chrome.runtime.lastError.message;
        return;
      }
      if (!res || !res.success) {
        fixStatus.textContent = describeWatchLaterRemovalFailure(res);
        return;
      }
      const removed = res.removed || {};
      fixStatus.textContent = `削除しました: ${removed.title || removed.videoId} / 残りを消すにはもう一度「照合」`;
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
const wlPanelCancel = document.getElementById('wlPanelCancel');
const wlPanelStatus = document.getElementById('wlPanelStatus');
let armedWatchLaterBatch = null;

function armWatchLaterBatch(res, preview) {
  armedWatchLaterBatch = (res && preview && preview.length)
    ? { syncSessionId: res.syncSessionId, rows: preview, truncated: !!res.previewTruncated }
    : null;
  if (bulkRemoveWatchLaterBtn) bulkRemoveWatchLaterBtn.disabled = !armedWatchLaterBatch;
  if (wlPanel && !armedWatchLaterBatch) wlPanel.hidden = true;
}

function closeWatchLaterPanel() {
  if (wlPanel) wlPanel.hidden = true;
  if (wlPanelStatus) wlPanelStatus.textContent = '';
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
    ? '（候補が多いため先頭200件のみ表示・削除できるのもこの200件まで）'
    : '';
  wlPanelNote.textContent =
    `視聴済みとして記録がある${rows.length}件です${truncNote}。上から順に削除します。取り消せません。`;
  wlPanelLimit.max = String(rows.length);
  wlPanelLimit.value = String(Math.min(5, rows.length));
  wlPanelStatus.textContent = '';
  wlPanel.hidden = false;
  wlPanelLimit.focus();
}

function describeBatchStop(stopped) {
  const known = {
    'setvideoid-reassigned': '削除IDが振り直されたため中止しました（想定外の変化です）',
    'rescan-failed': '途中の再照合に失敗したため中止しました',
    'scan-expired': '照合から時間が経ったため中止しました',
    'sync-session-changed': 'YouTubeのタブまたはアカウントが変わったため中止しました',
    'sync-tab-unavailable': 'YouTubeのタブが閉じたか応答しないため中止しました',
    'edit-not-confirmed': 'YouTubeが成功を返さなかったため中止しました。照合し直して確認してください',
    'no-targets': '削除できる対象がありませんでした',
    'no-scan': '照合結果が失われたため中止しました',
  };
  return known[stopped] || ('中止: ' + stopped);
}

if (bulkRemoveWatchLaterBtn) {
  bulkRemoveWatchLaterBtn.addEventListener('click', openWatchLaterPanel);
}
if (wlPanelCancel) wlPanelCancel.addEventListener('click', closeWatchLaterPanel);

if (wlPanelRun) {
  wlPanelRun.addEventListener('click', () => {
    const armed = armedWatchLaterBatch;
    if (!armed) {
      wlPanelStatus.textContent = '先に「照合」を実行してください';
      return;
    }
    const rows = armed.rows;
    const limit = Math.max(1, Math.min(Number(wlPanelLimit.value) || 0, rows.length));
    const head = rows.slice(0, limit).map(r => r.title || r.videoId);
    const shown = head.slice(0, 5).join('\n');
    const more = head.length > 5 ? `\n… ほか${head.length - 5}件` : '';
    if (!confirm(`「後で見る」から${limit}件を削除します。取り消せません。\n\n${shown}${more}`)) return;
    if (!beginMaintenance('scanWatchLater', { activeText: '削除中…' })) {
      wlPanelStatus.textContent = '他のメンテナンス処理が実行中';
      return;
    }
    // 押し直しによる二重実行を防ぐ。武装解除は完了時にまとめて行う。
    wlPanelRun.disabled = true;
    if (bulkRemoveWatchLaterBtn) bulkRemoveWatchLaterBtn.disabled = true;
    if (removeOneWatchLaterBtn) removeOneWatchLaterBtn.disabled = true;
    wlPanelStatus.textContent = '削除中…';

    const port = chrome.runtime.connect({ name: 'watch-later-batch' });
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      endMaintenance('scanWatchLater');
      wlPanelRun.disabled = false;
      armedWatchLaterTarget = null;
      armWatchLaterBatch(null, null);
      fixStatus.textContent = text;
      wlPanelStatus.textContent = '';
      closeWatchLaterPanel();
    };
    port.onMessage.addListener((msg) => {
      if (msg.type === 'PROGRESS') {
        wlPanelStatus.textContent = `${msg.done} / ${msg.total} 件目: ${msg.title}`;
        return;
      }
      if (msg.type === 'ERROR') {
        finish('失敗: ' + (msg.error || 'unknown'));
        return;
      }
      if (msg.type !== 'DONE') return;
      if (!msg.success) {
        finish(describeBatchStop(msg.reason));
        return;
      }
      const parts = [`${msg.removed.length}件を削除しました`];
      if (msg.stopped) parts.push(describeBatchStop(msg.stopped));
      const c = msg.counts;
      if (c) parts.push(`残り: 後で見る ${c.total}件 / 視聴済み一致 ${c.candidates}件 / 未視聴 ${c.notWatched}件`);
      if (msg.drift && msg.drift.changed) parts.push(`⚠ 削除ID変化 ${msg.drift.changed}件`);
      if (msg.finalScanFailed) parts.push('※削除後の再照合に失敗したため、件数は未確認です');
      finish(parts.join(' / '));
    });
    // service worker が落ちた場合、DONE が来ないまま切断される。
    port.onDisconnect.addListener(() => finish('中断しました。照合し直して結果を確認してください'));

    // 応答が完全に途絶えたときに「削除中…」のまま固まらないための保険。
    // 削除が進んでいる間は PROGRESS ごとに延長するので、通常の実行では発火しない。
    // 発火時は「消えたか不明」なので、成功とも失敗とも書かず照合し直させる。
    let watchdog = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        finish('応答がないため中断しました。どこまで削除できたかは照合し直して確認してください');
        try { port.disconnect(); } catch (_e) {}
      }, 60000);
    };
    const clearWatchdog = () => { if (watchdog) clearTimeout(watchdog); watchdog = null; };
    port.onMessage.addListener(armWatchdog);
    port.onDisconnect.addListener(clearWatchdog);
    armWatchdog();

    // 接続しただけでは background は動かない。承認済みの対象と件数を渡して開始する。
    port.postMessage({
      type: 'START',
      syncSessionId: armed.syncSessionId,
      videoIds: rows.map((r) => r.videoId),
      limit,
    });
  });
}

function runFix(videoIds, force, label) {
  if (!videoIds.length) {
    fixStatus.textContent = '対象なし';
    return;
  }
  if (!confirm(`${label}: ${videoIds.length}件のチャンネル名をYouTube oEmbed APIで${force ? '上書き' : '補完'}します。続行しますか？`)) {
    return;
  }

  const maintenanceKey = force ? 'fixChannelsForce' : 'fixChannels';
  if (!beginMaintenance(maintenanceKey, { activeText: '実行中…' })) {
    fixStatus.textContent = '他のメンテナンス処理が実行中';
    return;
  }

  const total = videoIds.length;
  let remaining = total;
  fixStatus.textContent = `処理中... 残り${remaining}/${total}（更新0 / 失敗0）`;

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
        }
        const cacheIdx = sortedCache.findIndex(v => v.videoId === msg.videoId);
        if (cacheIdx !== -1) {
          const stillMatches = !noChannelOnly ||
            (!sortedCache[cacheIdx].channel || sortedCache[cacheIdx].channel.trim() === '');
          // Under noChannelOnly the updated row no longer qualifies — drop it.
          if (noChannelOnly && msg.channel) {
            sortedCache.splice(cacheIdx, 1);
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

      totalCountEl.textContent = sortedCache.length.toLocaleString();
      fixStatus.textContent = `処理中... 残り${remaining}/${total}（更新${msg.updated} / 失敗${msg.failed}）`;
      return;
    }

    if (msg.type === 'DONE') {
      fixStatus.textContent = `完了: 更新${msg.updated}件 / 失敗${msg.failed}件 / 合計${msg.total}件`;
      // Full reload to re-sort and ensure consistency.
      setTimeout(loadData, 300);
      finish();
      return;
    }

    if (msg.type === 'ERROR') {
      fixStatus.textContent = `失敗: ${msg.error || 'unknown'}`;
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
    if (runningMaintenance) {
      fixStatus.textContent = '他のメンテナンス処理が実行中';
      return;
    }
    // Only videos missing channel (across allData, not just visible)
    const targets = allData.filter(v => !v.channel || v.channel.trim() === '').map(v => v.videoId);
    runFix(targets, false, 'チャンネル名補完');
  });
}

// Fix credits (composer/lyricist/arranger) for Topic-channel videos.
let activeCreditsPort = null;
function runFixCredits(videoIds, sources, label) {
  if (!videoIds.length) {
    fixStatus.textContent = '対象なし';
    return;
  }
  if (!confirm(`${label}: ${videoIds.length}件の動画から作曲/作詞/編曲を概要欄で補完します。続行しますか？\n\n※YouTubeタブを1つ以上開いたままにしてください（Cookie経由でfetchするため）。`)) {
    return;
  }

  if (!beginMaintenance('fixCredits', { activeText: '実行中…（中止）', allowAbort: true })) {
    fixStatus.textContent = '他のメンテナンス処理が実行中';
    return;
  }

  const total = videoIds.length;
  let remaining = total;
  const fixCreditsBtn = document.getElementById('fixCredits');
  fixStatus.textContent = `処理中... 残り${remaining}/${total}（更新0 / 失敗0）`;
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
          if (msg.credits.composer && !rec.composer) rec.composer = msg.credits.composer;
          if (msg.credits.lyricist && !rec.lyricist) rec.lyricist = msg.credits.lyricist;
          if (msg.credits.arranger && !rec.arranger) rec.arranger = msg.credits.arranger;
        }
      }
      fixStatus.textContent = `処理中... 残り${remaining}/${total}（更新${msg.updated} / 情報なし${msg.noCredits} / 取得失敗${msg.fetchFailed}）`;
      if (msg.processed % 50 === 0 && msg.failReasons) {
        console.log('[Fix Credits] progress', msg.processed, 'failReasons:', msg.failReasons);
      }
      return;
    }
    if (msg.type === 'DONE') {
      const reasons = msg.failReasons && Object.keys(msg.failReasons).length
        ? ` [${Object.entries(msg.failReasons).map(([k, v]) => `${k}:${v}`).join(', ')}]`
        : '';
      let prefix = '完了';
      if (msg.autoStopped) prefix = '⚠ 自動停止（Googleのbot検知 / 時間を空けて再実行）';
      else if (msg.aborted) prefix = '⏸ 中止';
      fixStatus.textContent = `${prefix}: 更新${msg.updated} / 情報なし${msg.noCredits} / 取得失敗${msg.fetchFailed} / 処理${msg.processed || 0}/${msg.total}${reasons}`;
      console.log('[Fix Credits] failReasons:', msg.failReasons);
      setTimeout(loadData, 300);
      finish();
      return;
    }
    if (msg.type === 'ERROR') {
      fixStatus.textContent = `失敗: ${msg.error || 'unknown'}`;
      finish();
    }
  });
  port.postMessage({ type: 'START', videoIds, sources, force: false });
}

const fixCreditsBtn = document.getElementById('fixCredits');
if (fixCreditsBtn) {
  fixCreditsBtn.addEventListener('click', () => {
    if (fixCreditsBtn.dataset.mode === 'abort' && activeCreditsPort) {
      try { activeCreditsPort.postMessage({ type: 'ABORT' }); } catch (_e) {}
      fixStatus.textContent = '中止中...';
      updateRunningMaintenance('fixCredits', { activeText: '中止中…', allowAbort: true });
      return;
    }
    if (runningMaintenance) {
      fixStatus.textContent = '他のメンテナンス処理が実行中';
      return;
    }
    // Topicチャンネル優先。「一般も含める」ONなら非Topicも対象。
    const skipChecked = document.getElementById('skipCreditsChecked');
    const skip = !!(skipChecked && skipChecked.checked);
    const includeGeneral = document.getElementById('includeGeneralCredits');
    const includeGen = !!(includeGeneral && includeGeneral.checked);
    const sources = {};
    // Role-unit targeting + re-fetch cool-down (HANDOFF §3.1/§3.4 lightweight).
    // OLD behavior excluded a video as soon as ANY role or creditsRaw was present,
    // permanently stranding partial-credit videos ("composer filled, arranger
    // blank"). CreditTarget.isFixCreditsTarget now includes a video while any of
    // composer/lyricist/arranger is blank, and (when "チェック済みスキップ" is on)
    // skips only videos re-checked within the cool-down window — so re-reading an
    // unchanged 概要欄 every run can't hammer YouTube, but a video checked long ago
    // (parser improved / description edited) becomes eligible again.
    const now = Date.now();
    const targets = allData
      .filter(v => {
        if (!v.channel) return false;
        const isTopic = window.CreditTarget.isTopicChannelName(v.channel);
        return isTopic || includeGen;
      })
      .filter(v => window.CreditTarget.isFixCreditsTarget(v, { skipChecked: skip, now }))
      .map(v => {
        sources[v.videoId] = window.CreditTarget.isTopicChannelName(v.channel) ? 'topic' : 'general';
        return v.videoId;
      });
    const label = includeGen ? 'クレジット補完（Topic+一般）' : 'Topic動画のクレジット補完';
    runFixCredits(targets, sources, label);
  });
}

const enrichCreditsBtn = document.getElementById('enrichCredits');
let enrichCreditsController = null;
if (enrichCreditsBtn && window.EnrichCredits) {
  enrichCreditsController = window.EnrichCredits.create({
    getRecords: () => allData,
    notify: (message) => { fixStatus.textContent = message; },
    reloadData: () => loadData(),
    beginMaintenance: (activeText, allowAbort) => beginMaintenance('enrichCredits', { activeText, allowAbort }),
    updateMaintenance: (activeText, allowAbort) => updateRunningMaintenance('enrichCredits', { activeText, allowAbort }),
    endMaintenance: () => endMaintenance('enrichCredits'),
  });

  enrichCreditsBtn.addEventListener('click', () => {
    if (runningMaintenance && runningMaintenance !== 'enrichCredits') {
      fixStatus.textContent = '他のメンテナンス処理が実行中';
      return;
    }
    enrichCreditsController.open();
  });
}

let activeDurationsPort = null;
function runFixDurations(videoIds) {
  if (!videoIds.length) {
    fixStatus.textContent = '対象なし';
    return;
  }
  if (!confirm(`動画時間補完: ${videoIds.length}件の動画時間をwatchページから補完します。続行しますか？\n\n※YouTubeタブを1つ以上開いたままにしてください（Cookie経由でfetchするため）。ライブ動画は -1 として記録します。`)) {
    return;
  }

  if (!beginMaintenance('fixDurations', { activeText: '実行中…（中止）', allowAbort: true })) {
    fixStatus.textContent = '他のメンテナンス処理が実行中';
    return;
  }

  const total = videoIds.length;
  let remaining = total;
  const btn = document.getElementById('fixDurations');
  fixStatus.textContent = `処理中... 残り${remaining}/${total}（更新0 / ライブ0 / 取得失敗0）`;
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
      fixStatus.textContent = `処理中... 残り${remaining}/${total}（更新${msg.updated} / ライブ${msg.live} / 取得失敗${msg.fetchFailed}）`;
      return;
    }
    if (msg.type === 'DONE') {
      const reasons = msg.failReasons && Object.keys(msg.failReasons).length
        ? ` [${Object.entries(msg.failReasons).map(([k, v]) => `${k}:${v}`).join(', ')}]`
        : '';
      let prefix = '完了';
      if (msg.autoStopped) prefix = '⚠ 自動停止（Googleのbot検知 / 時間を空けて再実行）';
      else if (msg.aborted) prefix = '⏸ 中止';
      fixStatus.textContent = `${prefix}: 更新${msg.updated} / ライブ${msg.live} / 取得失敗${msg.fetchFailed} / 処理${msg.processed || 0}/${msg.total}${reasons}`;
      setTimeout(loadData, 300);
      finish();
      return;
    }
    if (msg.type === 'ERROR') {
      fixStatus.textContent = `失敗: ${msg.error || 'unknown'}`;
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
      fixStatus.textContent = '中止中...';
      updateRunningMaintenance('fixDurations', { activeText: '中止中…', allowAbort: true });
      return;
    }
    if (runningMaintenance) {
      fixStatus.textContent = '他のメンテナンス処理が実行中';
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
    if (runningMaintenance) {
      fixStatus.textContent = '他のメンテナンス処理が実行中';
      return;
    }
    // Force-overwrite for currently visible (filtered+sorted) entries
    const targets = sortedCache.map(v => v.videoId);
    runFix(targets, true, '強制上書き補正（表示中の全件）');
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
  let responded = false;

  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      content.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Could not load data. Reload the extension and try again.';
      content.appendChild(empty);
    }
  }, 5000);

  try {
    chrome.runtime.sendMessage({ type: 'EXPORT_DATA' }, (data) => {
      if (responded) return;
      responded = true;
      clearTimeout(timeout);

      if (chrome.runtime.lastError) {
        content.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'empty';
        errDiv.textContent = 'Error: ' + chrome.runtime.lastError.message;
        content.appendChild(errDiv);
        return;
      }

      if (data && data.__error) {
        content.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'empty';
        errDiv.style.padding = '24px';
        errDiv.style.lineHeight = '1.6';
        errDiv.style.whiteSpace = 'pre-line';
        errDiv.textContent = 'DB読み込みエラー: ' + (data.message || 'unknown') +
          '\n\n復旧手順:\n' +
          '1. すべてのYouTubeタブを閉じる（リロードではなく閉じる）\n' +
          '2. chrome://extensions で拡張をリロード\n' +
          '3. 新しくYouTubeを開いてからこの画面を再読込';
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
    content.textContent = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'empty';
    errDiv.textContent = 'Error: ' + e.message;
    content.appendChild(errDiv);
  }
}

loadData();
