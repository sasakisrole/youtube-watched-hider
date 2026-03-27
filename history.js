// History viewer script for YouTube Watched Hider
// Separated from history.html for Manifest V3 CSP compliance
// Uses incremental rendering to avoid UI freeze with large datasets

const content = document.getElementById('content');
const searchInput = document.getElementById('search');
const totalCountEl = document.getElementById('totalCount');
const sortBtns = document.querySelectorAll('.sort-btn');

let allData = [];
let currentSort = 'date-desc';
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
  a.href = `https://www.youtube.com/watch?v=${video.videoId}`;
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
    filtered = allData.filter(v =>
      (v.title || v.videoId).toLowerCase().includes(filter) ||
      (v.channel || '').toLowerCase().includes(filter) ||
      v.videoId.toLowerCase().includes(filter)
    );
  }

  sortedCache = sortData(filtered, currentSort);
  totalCountEl.textContent = sortedCache.length.toLocaleString();
  renderedCount = 0;
  lastDateKeyRendered = '';

  if (sortedCache.length === 0) {
    content.innerHTML = '<div class="empty">No videos found</div>';
    return;
  }

  content.innerHTML = '';
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

// Sort buttons
sortBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    sortBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSort = btn.dataset.sort;
    render();
  });
});

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
      content.innerHTML = '<div class="empty">Could not load data. Make sure a YouTube tab is open and try reloading this page.</div>';
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

      if (data && data.length > 0) {
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
