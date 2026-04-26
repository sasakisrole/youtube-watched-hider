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
    empty.textContent = 'No videos found';
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

// Sort buttons (exclude filter toggle)
sortBtns.forEach(btn => {
  if (btn.id === 'filterNoChannel') return;
  btn.addEventListener('click', () => {
    sortBtns.forEach(b => {
      if (b.id !== 'filterNoChannel') b.classList.remove('active');
    });
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

function runFix(videoIds, force, label) {
  if (!videoIds.length) {
    fixStatus.textContent = '対象なし';
    return;
  }
  if (!confirm(`${label}: ${videoIds.length}件のチャンネル名をYouTube oEmbed APIで${force ? '上書き' : '補完'}します。続行しますか？`)) {
    return;
  }

  const total = videoIds.length;
  let remaining = total;
  fixStatus.textContent = `処理中... 残り${remaining}/${total}（更新0 / 失敗0）`;

  const port = chrome.runtime.connect({ name: 'fix-channels' });

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
      return;
    }

    if (msg.type === 'ERROR') {
      fixStatus.textContent = `失敗: ${msg.error || 'unknown'}`;
      return;
    }
  });

  port.onDisconnect.addListener(() => {
    // no-op; DONE/ERROR already handled above
  });

  port.postMessage({ type: 'START', videoIds, force });
}

const fixBtn = document.getElementById('fixChannels');
if (fixBtn) {
  fixBtn.addEventListener('click', () => {
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

  const total = videoIds.length;
  let remaining = total;
  const fixCreditsBtn = document.getElementById('fixCredits');
  fixStatus.textContent = `処理中... 残り${remaining}/${total}（更新0 / 失敗0）`;
  if (fixCreditsBtn) {
    fixCreditsBtn.textContent = '■ 中止';
    fixCreditsBtn.dataset.mode = 'abort';
  }

  const port = chrome.runtime.connect({ name: 'fix-credits' });
  activeCreditsPort = port;
  const finish = () => {
    activeCreditsPort = null;
    if (fixCreditsBtn) {
      fixCreditsBtn.textContent = 'Fix Credits';
      fixCreditsBtn.dataset.mode = '';
    }
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
      return;
    }
    // Topicチャンネル優先。「一般も含める」ONなら非Topicも対象。
    const skipChecked = document.getElementById('skipCreditsChecked');
    const skip = !!(skipChecked && skipChecked.checked);
    const includeGeneral = document.getElementById('includeGeneralCredits');
    const includeGen = !!(includeGeneral && includeGeneral.checked);
    const sources = {};
    const targets = allData
      .filter(v => {
        if (!v.channel) return false;
        const isTopic = / - Topic$/.test(v.channel);
        return isTopic || includeGen;
      })
      .filter(v => !v.composer || !v.lyricist || !v.arranger)
      .filter(v => !(skip && v.creditsCheckedAt))
      .map(v => {
        sources[v.videoId] = / - Topic$/.test(v.channel) ? 'topic' : 'general';
        return v.videoId;
      });
    const label = includeGen ? 'クレジット補完（Topic+一般）' : 'Topic動画のクレジット補完';
    runFixCredits(targets, sources, label);
  });
}

const fixForceBtn = document.getElementById('fixChannelsForce');
if (fixForceBtn) {
  fixForceBtn.addEventListener('click', () => {
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
      empty.textContent = 'Could not load data. Make sure a YouTube tab is open and try reloading this page.';
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

      if (Array.isArray(data) && data.length > 0) {
        allData = data;
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
