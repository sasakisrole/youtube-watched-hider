// Analyzer view for YouTube Watched Hider
// Reads from allData (loaded by history.js) and renders music taste analysis.

(function () {
  const STOP = new Set([
    'する','した','して','さん','こと','もの','ため','これ','それ','あれ',
    'です','ます','ない','ある','いる','から','まで','より',
    '公式','Official','Music','Video','Audio','MV','feat','ft',
    'ver','Ver','version','Version','Live','LIVE','Remix','REMIX',
    'Cover','cover','カバー','Topic','topic'
  ]);

  function appendCell(row, value) {
    const td = document.createElement('td');
    td.textContent = String(value);
    row.appendChild(td);
    return td;
  }

  function appendLink(cell, href, label) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    cell.appendChild(a);
    return a;
  }

  function getDurationSec(d) {
    return typeof d.durationSec === 'number' && Number.isFinite(d.durationSec) ? d.durationSec : null;
  }

  function addDurationStat(stat, d) {
    const durationSec = getDurationSec(d);
    if (durationSec == null) {
      stat.unknown++;
    } else if (durationSec > 0) {
      stat.totalSec += durationSec;
      stat.known++;
    }
  }

  function formatDurationMain(totalSec) {
    const sec = Math.max(0, Math.round(totalSec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}時間${m}分`;
    if (m > 0) return `${m}分`;
    return `${s}秒`;
  }

  function formatDurationStat(stat) {
    if (!stat || !stat.known) return '—';
    const main = formatDurationMain(stat.totalSec);
    return stat.unknown ? `${main}（うち ${stat.unknown}件 不明）` : main;
  }

  function sortByCountThenName(a, b) {
    const d = b[1].count - a[1].count;
    return d || a[0].localeCompare(b[0], 'ja');
  }

  function sortByDurationThenCount(a, b) {
    const d = b[1].totalSec - a[1].totalSec;
    return d || (b[1].known - a[1].known) || (b[1].count - a[1].count) || a[0].localeCompare(b[0], 'ja');
  }

  function setSortHeaderState(tableSelector, activeSort) {
    document.querySelectorAll(`${tableSelector} th[data-sort]`).forEach(th => {
      const active = th.dataset.sort === activeSort;
      th.style.cursor = 'pointer';
      th.setAttribute('aria-sort', active ? 'descending' : 'none');
      th.style.textDecoration = active ? 'underline' : '';
    });
  }

  function extractKeywords(titles) {
    const cnt = new Map();
    for (const t of titles) {
      const cleaned = String(t)
        .replace(/[【\[（(].*?[】\])）]/g, ' ')
        .replace(/[「」『』"'"'／\/#\-–—|｜]/g, ' ');
      const tokens = cleaned.split(/[\s、。,.!！?？:：;；]+/);
      for (let tok of tokens) {
        tok = tok.trim();
        if (tok.length < 2 || tok.length > 20) continue;
        if (/^\d+$/.test(tok)) continue;
        if (STOP.has(tok)) continue;
        cnt.set(tok, (cnt.get(tok) || 0) + 1);
      }
    }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]);
  }

  function buildChannelCount(data) {
    const m = new Map();
    for (const d of data) {
      if (!d.channel) continue;
      const cur = m.get(d.channel) || { count: 0, totalSec: 0, unknown: 0, known: 0 };
      cur.count++;
      addDurationStat(cur, d);
      m.set(d.channel, cur);
    }
    return m;
  }

  function renderArtists(chCount) {
    const tbody = document.querySelector('#azArtistsTable tbody');
    const q = document.getElementById('azArtistFilter').value.trim().toLowerCase();
    const topicOnly = document.getElementById('azTopicOnly').checked;
    let list = [...chCount.entries()];
    if (topicOnly) list = list.filter(([k]) => window.CreditTarget.isTopicChannelName(k));
    if (q) list = list.filter(([k]) => k.toLowerCase().includes(q));
    list.sort(sortByCountThenName);

    tbody.textContent = '';
    const frag = document.createDocumentFragment();
    list.slice(0, 300).forEach(([name, stat], i) => {
      const clean = window.CreditTarget.stripTopicChannelSuffix(name);
      const qn = encodeURIComponent(clean);
      const qTopic = encodeURIComponent(clean + ' - Topic');
      const tr = document.createElement('tr');
      appendCell(tr, i + 1);
      appendCell(tr, name);
      appendCell(tr, stat.count);
      const links = appendCell(tr, '');
      appendLink(links, `https://www.youtube.com/results?search_query=${qTopic}&sp=EgIQAQ==`, 'Topic検索');
      appendLink(links, `https://www.youtube.com/results?search_query=${qn}`, 'YT');
      appendLink(links, `https://www.google.com/search?q=${qn}+similar+artists`, '類似');
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  let currentChannelSort = 'count';

  function renderChannels(chCount) {
    setSortHeaderState('#azChannelsTable', currentChannelSort);
    const tbody = document.querySelector('#azChannelsTable tbody');
    const q = document.getElementById('azChannelFilter').value.trim().toLowerCase();
    let list = [...chCount.entries()];
    if (q) list = list.filter(([k]) => k.toLowerCase().includes(q));
    list.sort(currentChannelSort === 'duration' ? sortByDurationThenCount : sortByCountThenName);

    tbody.textContent = '';
    const frag = document.createDocumentFragment();
    list.slice(0, 500).forEach(([name, stat], i) => {
      const tr = document.createElement('tr');
      appendCell(tr, i + 1);
      appendCell(tr, name);
      appendCell(tr, stat.count);
      const durationCell = appendCell(tr, formatDurationStat(stat));
      if (!stat.known) durationCell.style.color = 'var(--text-muted)';
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function renderKeywords(data, chCount) {
    const topicSet = new Set([...chCount.keys()].filter(k => window.CreditTarget.isTopicChannelName(k)));
    const titles = data.filter(d => topicSet.has(d.channel)).map(d => d.title || '');
    const kws = extractKeywords(titles).slice(0, 80);
    const box = document.getElementById('azKwList');
    box.textContent = '';
    kws.forEach(([w, c]) => {
      const el = document.createElement('div');
      el.className = 'az-kw';
      const word = document.createElement('span');
      word.textContent = w;
      const count = document.createElement('span');
      count.className = 'w';
      count.textContent = c;
      el.appendChild(word);
      el.appendChild(count);
      box.appendChild(el);
    });
  }

  // Split a credit field by common separators ("A, B", "A / B", "A & B", "A・B", "A · B").
  // U+00B7 (· middle dot, used by Topic Phase B `creditsRaw`) and U+30FB (・ Japanese middle dot) are both handled.
  function splitCreditField(s) {
    if (!s) return [];
    return String(s)
      .split(/[,、，\/／&＆;；]|\s+and\s+|[・·]/i)
      .map(x => x.trim())
      .filter(Boolean);
  }

  // 動画の creditsSource を判定（未記録は channel から後方互換推定）
  function sourceOf(d) {
    if (d.creditsSource === 'topic' || d.creditsSource === 'general') return d.creditsSource;
    if (d.channel && window.CreditTarget.isTopicChannelName(d.channel)) return 'topic';
    return 'general';
  }

  // Build credit -> {count, duration, selfArrangeCount} filtered by source ('all'|'topic'|'general').
  // field === 'raw' = role-unassigned creditsRaw names (Phase B `·` parser output that did not resolve to a role).
  function buildCreditCount(data, field, sourceFilter) {
    const m = new Map();
    const isRaw = field === 'raw';
    // self列（セルフアレンジ曲数）は作曲・編曲タブのみ計算する。
    // 作詞/未割当タブで「その人が関わった曲が作曲＝編曲だったか」を表示しても
    // 当該人物の指標として意味を成さないため、ここでは集計しない。
    const computeSelf = field === 'composer' || field === 'arranger';
    for (const d of data) {
      if (isRaw) {
        if (!d.creditsRaw) continue;
        if (d.composer || d.lyricist || d.arranger) continue;
      } else {
        if (!d.composer && !d.lyricist && !d.arranger) continue;
      }
      if (sourceFilter && sourceFilter !== 'all' && sourceOf(d) !== sourceFilter) continue;
      const names = splitCreditField(isRaw ? d.creditsRaw : d[field]);
      if (!names.length) continue;
      let isSelfArrange = false;
      if (computeSelf) {
        const composers = new Set(splitCreditField(d.composer));
        const arrangers = new Set(splitCreditField(d.arranger));
        isSelfArrange = composers.size > 0 && arrangers.size > 0 &&
          [...composers].some(c => arrangers.has(c));
      }
      for (const name of names) {
        const cur = m.get(name) || { count: 0, totalSec: 0, unknown: 0, known: 0, self: 0, hasSelf: computeSelf };
        cur.count++;
        addDurationStat(cur, d);
        if (isSelfArrange) cur.self++;
        m.set(name, cur);
      }
    }
    return m;
  }

  let currentCreditField = 'composer';
  let currentCreditSource = 'topic';
  let currentCreditSort = 'count';

  function renderCredits(data) {
    setSortHeaderState('#azCreditsTable', currentCreditSort);
    const cm = buildCreditCount(data, currentCreditField, currentCreditSource);
    const q = document.getElementById('azCreditFilter').value.trim().toLowerCase();
    let list = [...cm.entries()];
    if (q) list = list.filter(([k]) => k.toLowerCase().includes(q));
    list.sort(currentCreditSort === 'duration' ? sortByDurationThenCount : sortByCountThenName);

    const totalPeople = cm.size;
    const totalPlays = [...cm.values()].reduce((s, v) => s + v.count, 0);
    document.getElementById('azCreditStats').textContent =
      `${totalPeople.toLocaleString()}人 / ${totalPlays.toLocaleString()}再生`;

    const tbody = document.querySelector('#azCreditsTable tbody');
    tbody.textContent = '';
    const frag = document.createDocumentFragment();
    list.slice(0, 500).forEach(([name, v], i) => {
      const tr = document.createElement('tr');
      let selfCell;
      if (!v.hasSelf) {
        selfCell = '—';
      } else if (v.self) {
        const rate = v.count ? Math.round(v.self / v.count * 100) : 0;
        selfCell = `${v.self} (${rate}%)`;
      } else {
        selfCell = '-';
      }
      appendCell(tr, i + 1);
      appendCell(tr, name);
      appendCell(tr, v.count);
      const durationCell = appendCell(tr, formatDurationStat(v));
      if (!v.known) durationCell.style.color = 'var(--text-muted)';
      appendCell(tr, selfCell).style.color = 'var(--text-muted)';
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  // Music-likeness of a non-Topic channel: ratio of plays that have credits.
  function buildChannelMusicScore(data) {
    const total = new Map();
    const credited = new Map();
    for (const d of data) {
      if (!d.channel) continue;
      if (window.CreditTarget.isTopicChannelName(d.channel)) continue;
      total.set(d.channel, (total.get(d.channel) || 0) + 1);
      if (d.composer || d.lyricist || d.arranger) {
        credited.set(d.channel, (credited.get(d.channel) || 0) + 1);
      }
    }
    return { total, credited };
  }

  // Filter out junk credit names (Twitter URLs, stray parens, etc.) that leak in from upstream extraction.
  function isCleanCreditName(name) {
    if (!window.CreditTarget.isValidCreditValue(name)) return false;
    if (!name || name.length < 2 || name.length > 60) return false;
    if (/https?:|twitter\.com|x\.com|t\.co\//i.test(name)) return false;
    if (/^[\(\)\[\]【】（）]/.test(name) || /[\(\[【（][^\)\]】）]*$/.test(name)) return false;
    if (/^[\)\]】）]/.test(name)) return false;
    if (/Twitter\s*[:：]/i.test(name)) return false;
    // Unbalanced parens (e.g. "triplebullets)", "mitsukiyo_5)") signal upstream split errors.
    const opens = (name.match(/[\(（\[【]/g) || []).length;
    const closes = (name.match(/[\)）\]】]/g) || []).length;
    if (opens !== closes) return false;
    return true;
  }

  function topCredits(data, field, sourceFilter, limit) {
    const m = buildCreditCount(data, field, sourceFilter);
    return [...m.entries()]
      .filter(([k]) => isCleanCreditName(k))
      .sort(sortByCountThenName)
      .slice(0, limit);
  }

  let likedRecords = [];
  let likedMeta = null; // M1: cache of likedSyncMeta so renderPrompt can note partial state
  // M2b (v1.42.6, Codex 2026-07-10): likedMeta must be loaded BEFORE renderPrompt()
  // runs. Previously renderLikedPanel() fetched GET_LIKED_META asynchronously while
  // renderPrompt() was called synchronously right after, so the prompt read a stale
  // (usually null) likedMeta and the partial-sync note never made it into the copied
  // recommendation prompt. Promise-ify the meta load and await it at every call site.
  let loadLikedMetaSeq = 0;

  function loadLikedMeta(onLate) {
    const mySeq = ++loadLikedMetaSeq;
    return new Promise((resolve) => {
      let done = false;
      const finish = (loaded = false) => { if (!done) { done = true; resolve(loaded); } };
      const timer = setTimeout(() => finish(false), 3000); // never hang the analyzer
      try {
        chrome.runtime.sendMessage({ type: 'GET_LIKED_META' }, (resp) => {
          const late = done; // response arrived after the 3s timeout already resolved
          clearTimeout(timer);
          // Same generation guard as loadLiked: a superseded response must not
          // clobber newer meta.
          if (mySeq !== loadLikedMetaSeq) { finish(false); return; }
          likedMeta = (resp && resp.meta) || null;
          finish(true);
          // M1/l1cm: a slow GET_LIKED_META can land after the timeout. Re-render so
          // the meta row and the copied prompt reflect the freshly-loaded partial flag.
          if (late && typeof onLate === 'function') { try { onLate(); } catch (_) {} }
        });
      } catch (_e) { clearTimeout(timer); finish(false); }
    });
  }
  // M2: monotonic generation id. Each loadLiked() call bumps it; a response is
  // only applied if it belongs to the newest call. This stops a slow earlier
  // GET_LIKED (e.g. the 3s-timeout initial load) from landing after a newer load
  // (e.g. the post-sync await loadLiked()) and overwriting fresh likedRecords
  // with stale/empty data.
  let loadLikedSeq = 0;

  function loadLiked(onLate) {
    const mySeq = ++loadLikedSeq;
    return new Promise((resolve) => {
      let done = false;
      const finish = (loaded = false) => { if (!done) { done = true; resolve(loaded); } };
      // Hard timeout so the analyzer never hangs even if no YouTube tab is open.
      const timer = setTimeout(() => finish(false), 3000);
      try {
        chrome.runtime.sendMessage({ type: 'GET_LIKED' }, (resp) => {
          const late = done; // response arrived after the 3s timeout already resolved
          clearTimeout(timer);
          // M2: a superseded request must never clobber a newer load's data or
          // trigger a stale re-render.
          if (mySeq !== loadLikedSeq) { finish(false); return; }
          likedRecords = (resp && resp.success && resp.rows) ? resp.rows : [];
          finish(true);
          // L2: a slow GET_LIKED (large liked set) can land after the timeout.
          // Re-render so the analyzer doesn't keep showing stale/empty liked data.
          if (late && typeof onLate === 'function') { try { onLate(); } catch (_) {} }
        });
      } catch (_e) { clearTimeout(timer); finish(false); }
    });
  }

  // l1cm: single refresh path shared by the initial analysis and the post-sync
  // reload. Re-reads allData at call time (not a captured snapshot) so a late
  // GET_LIKED / GET_LIKED_META response re-renders both the liked panel and the
  // copied recommendation prompt with the full, current dataset.
  function refreshLikedViews() {
    const d = (typeof allData !== 'undefined' && allData) ? allData : [];
    renderLikedPanel();
    renderPrompt(d, buildChannelCount(d));
  }

  function setPromptCopyStale(stale) {
    const button = document.getElementById('azCopyPrompt');
    const message = document.getElementById('azCopyMsg');
    if (button) {
      button.disabled = stale;
      button.title = stale ? '高評価データを再読込中です' : '';
    }
    if (message) {
      if (stale) message.textContent = '高評価データを再読込中のため、コピーできません';
      else if (message.textContent === '高評価データを再読込中のため、コピーできません') message.textContent = '';
    }
  }

  // Keep the exported prompt unavailable until both post-sync responses have
  // actually arrived. A loader timeout unblocks the analyzer, but does not make
  // the currently-rendered prompt fresh; its existing late callback clears the
  // corresponding pending flag when the response eventually lands.
  async function reloadLikedAfterSync() {
    setPromptCopyStale(true);
    const pending = { rows: true, meta: true };
    const arrivedLate = { rows: false, meta: false };
    const onLate = (key) => () => {
      arrivedLate[key] = true;
      pending[key] = false;
      refreshLikedViews();
      if (!pending.rows && !pending.meta) setPromptCopyStale(false);
    };
    const [rowsLoaded, metaLoaded] = await Promise.all([
      loadLiked(onLate('rows')),
      loadLikedMeta(onLate('meta')),
    ]);
    pending.rows = !rowsLoaded && !arrivedLate.rows;
    pending.meta = !metaLoaded && !arrivedLate.meta;
    refreshLikedViews();
    setPromptCopyStale(pending.rows || pending.meta);
  }

  function buildLikedArtistCount() {
    const m = new Map();
    for (const r of likedRecords) {
      if (!r.channel) continue;
      m.set(r.channel, (m.get(r.channel) || 0) + 1);
    }
    return m;
  }

  function renderLikedPanel() {
    const ch = buildLikedArtistCount();
    document.getElementById('azLikedTotal').textContent = likedRecords.length.toLocaleString();
    document.getElementById('azLikedArtists').textContent = ch.size.toLocaleString();

    const tbody = document.querySelector('#azLikedTable tbody');
    tbody.textContent = '';
    const list = [...ch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200);
    const frag = document.createDocumentFragment();
    list.forEach(([name, cnt], i) => {
      const tr = document.createElement('tr');
      appendCell(tr, i + 1);
      appendCell(tr, name);
      appendCell(tr, cnt);
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);

    // Account meta line — reads the cached likedMeta synchronously (M2b).
    // Callers must `await loadLikedMeta()` before renderLikedPanel()/renderPrompt().
    {
      const meta = likedMeta;
      const el = document.getElementById('azLikedAccount');
      // L1: clear the partial danger color when there is no meta at all, so a
      // previously-partial state doesn't leave '未同期' rendered in red.
      if (!meta) { el.textContent = '未同期'; el.classList.remove('liked-partial'); } else {
        const when = new Date(meta.lastSyncedAt || 0).toLocaleString();
        const acc = meta.ownerHandle || meta.ownerName || meta.accountId || '(unknown)';
        let line = `アカウント: ${acc} / 最終同期: ${when} / ${(meta.count || 0).toLocaleString()}件`;
        // M1: persist the partial-sync warning across reloads. v1.42.5 saved
        // partial/hasMore/lastError to likedSyncMeta but only surfaced it in the
        // transient post-sync toast, so reopening the analyzer hid the warning
        // and the user could trust incomplete liked data. Show it on the meta row.
        if (meta.partial) {
          line += ' / ⚠️ 部分同期（全件取得できていません・再同期推奨）';
          if (meta.lastError) line += ` [${meta.lastError}]`;
        }
        // v1.42.10 (M1): a save made while the account could not be identified must not
        // look identical to a normal, fully-identified sync — surface the confidence so
        // the user knows a different account's likes could have merged in.
        if (meta.identityConfidence === 'unknown-confirmed') {
          line += ' / ⚠️ アカウント未識別のまま保存（確認済・別アカウント混入に注意）';
        } else if (meta.identityConfidence === 'name-only') {
          // v1.42.11 (M2): identity is a bare display name (no channelId/handle) — weak.
          // A different account sharing the display name could merge in undetected, so
          // this must not read like a normal, fully-identified sync.
          line += ' / ⚠️ 表示名のみで識別（同名の別アカウント混入に注意・再同期で強い識別が付けば解消）';
        } else if (meta.identityConfidence === 'browse-recovered') {
          line += ' / ℹ️ アカウントはブラウズ応答から復元';
        }
        el.textContent = line;
        el.classList.toggle('liked-partial', !!meta.partial
          || meta.identityConfidence === 'unknown-confirmed'
          || meta.identityConfidence === 'name-only');
      }
    }
  }

  function topLikedArtists(limit) {
    const m = buildLikedArtistCount();
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  // v1.42.12 (M2, Codex 2026-07-11 wrapup-review_10): pure note-builder for the copied
  // prompt's 高評価Top30 section. The partial / weak-identity warnings shown on the
  // analyzer meta row (renderLikedPanel) previously did NOT survive into the exported
  // prompt — renderPrompt only noted `partial` and ignored identityConfidence. That Top30
  // is exactly the data carried out to an external recommender, so a name-only /
  // unknown-confirmed liked set must not read as a clean, fully-identified set downstream.
  // Kept pure (no DOM / closure deps) so it can be unit-tested without a renderPrompt DOM
  // harness.
  function likedPromptNotes(meta) {
    const notes = [];
    if (!meta) return notes;
    if (meta.partial) {
      notes.push('⚠️ 注記: 高評価データは**部分同期**です（全件取得できていません）。以下の集計は不完全な可能性があるため、参考程度に扱ってください。');
    }
    if (meta.identityConfidence === 'unknown-confirmed') {
      notes.push('⚠️ 注記: 高評価データは**アカウント未識別のまま保存**されています（別アカウントの高評価が混入している可能性があります）。集計の帰属が不確実なため、参考程度に扱ってください。');
    } else if (meta.identityConfidence === 'name-only') {
      notes.push('⚠️ 注記: 高評価データのアカウント識別が**表示名のみ（弱識別）**です。同名の別アカウントの高評価が混入している可能性があるため、参考程度に扱ってください。');
    }
    return notes;
  }

  // Drive the SYNC_LIKED confirmation escalation. The background raises its guards
  // in sequence — first `account-unknown` (this sync's owner couldn't be identified),
  // then `account-changed` (the stored account differs from this sync's). Each guard
  // is confirmed SEPARATELY and its flag accumulated: approving an unidentifiable
  // account must NOT also silently pre-approve a known→unknown account CHANGE, or a
  // degraded sync belonging to a different account would merge into a known account's
  // likes undetected (Codex 2026-07-11 wrapup-review_9 M1). So confirming
  // 'account-unknown' re-runs with confirmUnknownAccount ONLY; if the stored account
  // was known, the background then returns 'account-changed', which is confirmed on
  // its own before the final save. Pure (deps injected) so it is unit-testable.
  async function resolveLikedSync({ doSync, confirm }) {
    const flags = {};
    let resp = await doSync({ ...flags });
    if (resp && !resp.success && resp.reason === 'account-unknown') {
      if (!confirm('account-unknown', resp)) return { cancelled: true, resp };
      flags.confirmUnknownAccount = true;
      resp = await doSync({ ...flags });
    }
    if (resp && !resp.success && resp.reason === 'account-changed') {
      if (!confirm('account-changed', resp)) return { cancelled: true, resp };
      flags.confirmAccountChange = true;
      resp = await doSync({ ...flags });
    }
    return { cancelled: false, resp };
  }

  function renderPrompt(data, chCount) {
    const topic = [...chCount.entries()]
      .filter(([k]) => window.CreditTarget.isTopicChannelName(k))
      .sort(sortByCountThenName)
      .slice(0, 40);

    // Credit-based music channel filter: >=5 credited plays AND >=40% credit coverage.
    const { total, credited } = buildChannelMusicScore(data);
    const musicGeneral = [...total.entries()]
      .map(([k, n]) => {
        const c = credited.get(k) || 0;
        return { name: k, plays: n, credited: c, rate: n ? c / n : 0 };
      })
      .filter(x => x.credited >= 5 && x.rate >= 0.4)
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 15);

    // Recent trend: use the most recent 1/3 of the watched time span
    // (data may only cover a few weeks, so a fixed N-day window is unreliable).
    const tsList = data.map(d => d.watchedAt || d.firstWatchedAt || 0).filter(t => t > 0);
    let topicRecent = [];
    if (tsList.length) {
      const maxTs = Math.max(...tsList);
      const minTs = Math.min(...tsList);
      const span = maxTs - minTs;
      const cutoff = span > 0 ? maxTs - span / 3 : 0;
      const recentCh = new Map();
      for (const d of data) {
        if (!d.channel || !window.CreditTarget.isTopicChannelName(d.channel)) continue;
        const ts = d.watchedAt || d.firstWatchedAt || 0;
        if (ts < cutoff) continue;
        recentCh.set(d.channel, (recentCh.get(d.channel) || 0) + 1);
      }
      topicRecent = [...recentCh.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
    }

    // Composers / arrangers (topic + general combined)
    const composers = topCredits(data, 'composer', 'all', 20);
    const arrangers = topCredits(data, 'arranger', 'all', 10);

    const lines = [];
    lines.push('あなたは音楽キュレーターです。');
    lines.push('以下は私のYouTube視聴履歴から抽出した音楽嗜好データです。');
    lines.push('');
    lines.push('## 用語注釈');
    lines.push('- **Topic** = YouTubeが自動生成するアーティスト公式チャンネル（純粋な楽曲再生指標）');
    lines.push('- **自編曲率** = その作曲家の楽曲のうち、作曲者と編曲者が同一人物だった曲の割合（高い＝独立性が高い／低い＝外部編曲家との協業が多い）');
    lines.push('- **クレジット率** = そのチャンネルの動画でクレジット情報（作曲・作詞・編曲）が取得できた割合（高い＝楽曲制作主体の音楽チャンネルである可能性が高い）');
    lines.push('');
    lines.push('## 再生数Top40アーティスト（YouTube Topicチャンネル由来）');
    topic.forEach(([k, v], i) => lines.push(`${i + 1}. ${window.CreditTarget.stripTopicChannelSuffix(k)} (${v.count}回)`));
    lines.push('');
    if (topicRecent.length) {
      lines.push('## 直近の傾向 Top15（視聴期間の後半1/3）');
      topicRecent.forEach(([k, v], i) => lines.push(`${i + 1}. ${window.CreditTarget.stripTopicChannelSuffix(k)} (${v}回)`));
      lines.push('');
    }
    lines.push('## よく聴いた作曲家 Top20（クレジット集計）');
    composers.forEach(([name, v], i) => {
      const rate = v.count ? Math.round(v.self / v.count * 100) : 0;
      const selfTag = v.self ? `, 自編曲率${rate}%` : '';
      lines.push(`${i + 1}. ${name} (${v.count}回${selfTag})`);
    });
    lines.push('');
    lines.push('## よく聴いた編曲家 Top10');
    arrangers.forEach(([name, v], i) => lines.push(`${i + 1}. ${name} (${v.count}回)`));
    lines.push('');
    const liked = topLikedArtists(30);
    const promptNotes = likedPromptNotes(likedMeta);
    if (liked.length || promptNotes.length) {
      lines.push('## 高評価Top30アーティスト（YouTubeで高評価した動画のチャンネル別集計）');
      // M1 / v1.42.12 (M2): warn in-prompt when the liked data is a partial sync OR was
      // saved under a weak identity (name-only / unknown-confirmed), so the model (and
      // reader) knows the ranking may be incomplete or account-ambiguous rather than
      // treating it as the complete, cleanly-attributed liked set. See likedPromptNotes.
      promptNotes.forEach((n) => lines.push(n));
      if (!liked.length) {
        const metaCount = likedMeta && typeof likedMeta.count === 'number'
          && Number.isFinite(likedMeta.count) ? likedMeta.count : null;
        lines.push(metaCount === 0
          ? '高評価動画は同期メタ情報上0件です。'
          : `⚠️ 高評価動画一覧はまだ読み込まれていません${metaCount === null ? '' : `（同期メタ情報では${metaCount.toLocaleString()}件）`}。`);
      }
      liked.forEach(([k, v], i) => lines.push(`${i + 1}. ${window.CreditTarget.stripTopicChannelSuffix(k)} (${v}回)`));
      lines.push('');
    }
    if (musicGeneral.length) {
      lines.push('## 音楽系の一般チャンネル Top15（クレジット紐づき率40%以上）');
      musicGeneral.forEach((x, i) => {
        const pct = Math.round(x.rate * 100);
        lines.push(`${i + 1}. ${x.name} (${x.plays}回, クレジット率${pct}%)`);
      });
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('## タスク');
    lines.push('上記データを分析し、まだ聴いていない「次に聴くべきアーティスト/作曲家」を **10名** 推薦してください。');
    lines.push('');
    lines.push('## 多様性要件（必須）');
    lines.push('- 上記リストに既出の人物・チャンネルは**除外**（既に聴いています）');
    lines.push('- 10名のうち**最低3名**は作曲家・編曲家など裏方クレジット系の人物を含める');
    lines.push('- 10名のうち**最低2名**は既存リストと別ジャンル・別シーンからの越境推薦（隣接領域から1歩外）');
    lines.push('- 「直近の傾向」（視聴期間後半1/3）を主軸に置きつつ、Top40の長期嗜好も考慮');
    lines.push('');
    lines.push('## 推薦の根拠（各推薦に必ず1つ以上明示）');
    lines.push('- 共通する作曲家・編曲家・レーベル・所属事務所');
    lines.push('- 楽曲構造・編曲手法・コード進行の共通点');
    lines.push('- 活動コミュニティ・コラボ関係・出自');
    lines.push('- 歌詞テーマ・世界観・サウンドの方向性');
    lines.push('');
    lines.push('※「人気だから」「なんとなく似ている」だけの推薦は不可。上記4観点のどれに該当するかを具体的に書いてください。');
    lines.push('');
    lines.push('## ハルシネーション対策');
    lines.push('- 楽曲名・人物の存在に確信が持てない場合は推薦から除外してください');
    lines.push('- 不確かな10名より、確度の高い7〜8名のほうが望ましい');
    lines.push('- 検索URLは `https://www.youtube.com/results?search_query=...` 形式で実在検索可能なものに');
    lines.push('');
    lines.push('## 出力形式（各推薦ごとに以下のMarkdown構造で）');
    lines.push('');
    lines.push('### 1. アーティスト/作曲家名');
    lines.push('- **代表曲**: 1〜2曲');
    lines.push('- **既存お気に入りとの関連性**: （上記4観点のどれに該当するか明記）');
    lines.push('- **YouTube検索URL**: https://www.youtube.com/results?search_query=...');
    lines.push('- **確度**: 高 / 中 / 低（データから演繹可能なら高、飛躍があれば低）');
    document.getElementById('azPromptText').textContent = lines.join('\n');
  }

  let currentOfficialCandidate = null;
  let currentOfficialChannelName = '';

  function setOfficialRegistrationStatus(message, isError = false) {
    const status = document.getElementById('azOfficialStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? 'var(--danger, #e66)' : 'var(--text-muted)';
  }

  async function openOfficialCandidateReview(candidate) {
    const api = window.YWHAnalyzeOfficialProfiles;
    const review = document.getElementById('azOfficialReview');
    if (!api || !review) return;

    currentOfficialCandidate = candidate;
    currentOfficialChannelName = candidate.channelName;
    review.hidden = false;
    document.getElementById('azOfficialProfileName').value = candidate.profileName;
    document.getElementById('azOfficialChannelUrl').value = '';
    document.getElementById('azOfficialConfirmed').checked = false;

    const sample = document.getElementById('azOfficialSample');
    sample.href = candidate.sampleVideoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(candidate.sampleVideoId)}`
      : `https://www.youtube.com/results?search_query=${encodeURIComponent(candidate.channelName)}`;
    const target = document.getElementById('azOfficialTarget');
    target.removeAttribute('href');
    setOfficialRegistrationStatus('候補元動画からチャンネルURLを取得しています…');

    try {
      const channel = await api.resolveCandidateChannel(candidate);
      if (currentOfficialCandidate !== candidate) return;
      if (!channel) throw new Error('チャンネルURLを取得できませんでした');
      currentOfficialChannelName = channel.displayName || candidate.channelName;
      const url = `https://www.youtube.com${channel.canonicalPath}`;
      document.getElementById('azOfficialChannelUrl').value = url;
      target.href = url;
      setOfficialRegistrationStatus('リンク先を開き、本人の公式またはTopicチャンネルか確認してください。');
    } catch (error) {
      if (currentOfficialCandidate !== candidate) return;
      setOfficialRegistrationStatus(
        `自動取得できませんでした。確認したチャンネルURLを入力してください（${error.message}）。`,
        true
      );
    }
  }

  function renderOfficialProfileCandidates(data) {
    const api = window.YWHAnalyzeOfficialProfiles;
    const store = window.YWHOfficialProfileStore;
    const container = document.getElementById('azOfficialCandidates');
    const saveButton = document.getElementById('azOfficialSave');
    if (!api || !store || !container || !saveButton) return;

    const allCandidates = api.buildCandidates(data).slice(0, 50);

    // 登録済み・除外済みを一覧から外して描き直す。保存直後にも呼ぶので、
    // 登録した候補はその場で消える（＝二重登録の入口を塞ぐ）。
    async function paint() {
      let settings = null;
      try {
        settings = await store.loadSettings();
      } catch {
        settings = null;
      }
      const parts = api.partitionCandidates(allCandidates, settings, store);
      api.renderCandidateRows(
        container,
        parts.visible,
        {
          onReview: (candidate) => void openOfficialCandidateReview(candidate),
          onExclude: (candidate) => void excludeCandidate(candidate),
        },
        {
          registeredCount: parts.registered.length,
          excludedCount: parts.excluded.length,
        }
      );
      renderExcludedFooter(parts);
    }

    function renderExcludedFooter(parts) {
      const footer = document.getElementById('azOfficialHidden');
      if (!footer) return;
      footer.textContent = '';
      const registered = parts.registered.length;
      const excluded = parts.excluded;
      if (!registered && !excluded.length) return;

      const note = document.createElement('span');
      const pieces = [];
      if (registered) pieces.push(`登録済み ${registered} 件`);
      if (excluded.length) {
        pieces.push(`除外 ${excluded.length} 件（${excluded.map((c) => c.channelName).join('、')}）`);
      }
      note.textContent = `非表示: ${pieces.join(' / ')}`;
      footer.appendChild(note);

      if (excluded.length) {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'sort-btn';
        restore.id = 'azOfficialRestore';
        restore.textContent = '除外をすべて戻す';
        restore.addEventListener('click', async () => {
          restore.disabled = true;
          try {
            for (const candidate of excluded) {
              await store.updateCandidateExclusion(candidate.channelName, false);
            }
            setOfficialRegistrationStatus('除外を戻しました。');
            await paint();
          } catch (error) {
            setOfficialRegistrationStatus(`除外を戻せませんでした: ${error.message}`, true);
            restore.disabled = false;
          }
        });
        footer.appendChild(restore);
      }
    }

    async function excludeCandidate(candidate) {
      try {
        const result = await store.updateCandidateExclusion(candidate.channelName, true);
        if (!result.saved && result.reason !== 'unchanged') {
          throw new Error(result.reason || '保存できませんでした');
        }
        if (currentOfficialCandidate === candidate) {
          const review = document.getElementById('azOfficialReview');
          if (review) review.hidden = true;
          currentOfficialCandidate = null;
        }
        setOfficialRegistrationStatus(`「${candidate.channelName}」を候補から外しました。`);
        await paint();
      } catch (error) {
        setOfficialRegistrationStatus(`候補から外せませんでした: ${error.message}`, true);
      }
    }

    void paint();

    saveButton.onclick = async () => {
      if (!currentOfficialCandidate) {
        setOfficialRegistrationStatus('先に候補を選んでください。', true);
        return;
      }
      const profileName = document.getElementById('azOfficialProfileName').value.trim();
      const channel = api.channelFromInput(
        document.getElementById('azOfficialChannelUrl').value,
        currentOfficialChannelName || currentOfficialCandidate.channelName
      );
      if (!profileName || !channel) {
        setOfficialRegistrationStatus('プロフィール名とYouTubeチャンネルURLを確認してください。', true);
        return;
      }
      if (!document.getElementById('azOfficialConfirmed').checked) {
        setOfficialRegistrationStatus('リンク先を確認し、確認欄をチェックしてください。', true);
        return;
      }
      const approved = window.confirm(
        `次の内容を公式プロファイルとして登録しますか？\n` +
        `プロフィール: ${profileName}\n` +
        `チャンネル: ${channel.displayName}\n` +
        `URL: https://www.youtube.com${channel.canonicalPath}`
      );
      if (!approved) {
        setOfficialRegistrationStatus('登録をキャンセルしました。');
        return;
      }

      saveButton.disabled = true;
      setOfficialRegistrationStatus('保存中です…');
      try {
        const result = await store.registerConfirmed({
          profileName,
          channel: {
            ...channel,
            // 候補一覧の出どころを残す＝登録後にその候補を一覧から外すための鍵
            sourceChannelName: currentOfficialCandidate.channelName,
          },
          confirmed: true,
          bindQuery: false,
        });
        if (!result.saved && result.reason === 'already-registered') {
          document.getElementById('azOfficialConfirmed').checked = false;
          const review = document.getElementById('azOfficialReview');
          if (review) review.hidden = true;
          currentOfficialCandidate = null;
          setOfficialRegistrationStatus('このチャンネルは登録済みです（重複登録は行いませんでした）。');
          await paint();
          return;
        }
        if (!result.saved) throw new Error(result.reason || '保存できませんでした');
        document.getElementById('azOfficialConfirmed').checked = false;
        const review = document.getElementById('azOfficialReview');
        if (review) review.hidden = true;
        currentOfficialCandidate = null;
        setOfficialRegistrationStatus('プロフィールとチャンネルを登録しました。');
        await paint();
      } catch (error) {
        setOfficialRegistrationStatus(`保存できませんでした: ${error.message}`, true);
      } finally {
        saveButton.disabled = false;
      }
    };
  }

  async function runAnalysis() {
    const data = (typeof allData !== 'undefined' && allData) ? allData : [];
    const chCount = buildChannelCount(data);
    // L2: if the liked data arrives after the 3s timeout, re-render the liked
    // panel and the recommendation prompt so they reflect the full dataset.
    // Re-read allData at callback time (not the captured `data`) so a late
    // response doesn't re-render with a stale snapshot.
    // M2b: load meta alongside rows so renderPrompt() below sees the partial flag.
    // l1cm: both loaders get refreshLikedViews as their late callback so a slow
    // rows OR meta response re-renders the panel and prompt.
    await Promise.all([loadLikedMeta(refreshLikedViews), loadLiked(refreshLikedViews)]);
    const topicCh = [...chCount.entries()].filter(([k]) => window.CreditTarget.isTopicChannelName(k));
    const musicPlays = topicCh.reduce((s, [, v]) => s + v.count, 0);

    document.getElementById('azTotal').textContent = data.length.toLocaleString();
    document.getElementById('azCh').textContent = chCount.size.toLocaleString();
    document.getElementById('azArtist').textContent = topicCh.length.toLocaleString();
    document.getElementById('azMusic').textContent = musicPlays.toLocaleString();

    renderOfficialProfileCandidates(data);
    renderArtists(chCount);
    renderChannels(chCount);
    renderKeywords(data, chCount);
    renderCredits(data);
    renderLikedPanel();
    renderPrompt(data, chCount);

    // Re-wire filters to current chCount
    document.getElementById('azArtistFilter').oninput = () => renderArtists(chCount);
    document.getElementById('azTopicOnly').onchange = () => renderArtists(chCount);
    document.getElementById('azChannelFilter').oninput = () => renderChannels(chCount);
    document.getElementById('azCreditFilter').oninput = () => renderCredits(data);
    document.querySelectorAll('#azChannelsTable th[data-sort]').forEach(th => {
      th.onclick = () => {
        currentChannelSort = th.dataset.sort || 'count';
        renderChannels(chCount);
      };
    });
    document.querySelectorAll('#azCreditsTable th[data-sort]').forEach(th => {
      th.onclick = () => {
        currentCreditSort = th.dataset.sort || 'count';
        renderCredits(data);
      };
    });
    document.querySelectorAll('.az-credit-tab').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('.az-credit-tab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        currentCreditField = b.dataset.credit;
        renderCredits(data);
      };
    });
    const includeGenCb = document.getElementById('azIncludeGeneral');
    if (includeGenCb) {
      includeGenCb.checked = (currentCreditSource === 'all');
      includeGenCb.onchange = () => {
        currentCreditSource = includeGenCb.checked ? 'all' : 'topic';
        renderCredits(data);
      };
    }
  }

  // Tab switching
  document.querySelectorAll('.az-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.az-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const map = { artists: 'azArtistsPanel', channels: 'azChannelsPanel', keywords: 'azKeywordsPanel', credits: 'azCreditsPanel', liked: 'azLikedPanel', trends: 'azTrendsPanel', prompt: 'azPromptPanel', official: 'azOfficialPanel' };
      Object.values(map).forEach(id => { document.getElementById(id).style.display = 'none'; });
      document.getElementById(map[t.dataset.aztab]).style.display = '';
      if (t.dataset.aztab === 'trends' && typeof renderTrends === 'function') {
        renderTrends();
      }
    });
  });

  // Sync liked playlist button
  const syncLikedBtn = document.getElementById('azSyncLiked');
  if (syncLikedBtn) {
    syncLikedBtn.addEventListener('click', async () => {
      const msg = document.getElementById('azLikedMsg');
      const doSync = (opts = {}) => new Promise((res) => {
        chrome.runtime.sendMessage({
          type: 'SYNC_LIKED',
          confirmAccountChange: !!opts.confirmAccountChange,
          confirmUnknownAccount: !!opts.confirmUnknownAccount,
        }, res);
      });
      msg.textContent = '同期中...（全件取得まで数十秒〜2分かかる場合があります）';
      syncLikedBtn.disabled = true;
      try {
        // H1/M1: account identity guards. The owner may be unidentifiable
        // (account-unknown) and/or differ from the stored account (account-changed).
        // Each guard gets its OWN confirmation — see resolveLikedSync — so approving
        // an unidentified save can't silently approve a known→unknown account change.
        const confirmGuard = (kind, r) => {
          if (kind === 'account-unknown') {
            return window.confirm('アカウントを識別できませんでした（YouTubeに未ログイン、またはページ構造の変更の可能性）。\nこのまま高評価データを保存しますか？\n※別アカウントのデータと混ざる恐れがあります。');
          }
          // account-changed
          const prev = (r.previous && (r.previous.ownerHandle || r.previous.ownerName)) || r.previous?.accountId || '(unknown)';
          const cur = r.current?.ownerHandle || r.current?.ownerName || r.current?.accountId || '(unknown)';
          return window.confirm(`アカウントが変更されています:\n旧: ${prev}\n新: ${cur}\nこのまま新アカウントの高評価を追加しますか？\n（旧アカウントのデータは保持されます。クリアしたい場合は別途「Clear」操作を追加予定）`);
        };
        const { cancelled, resp } = await resolveLikedSync({ doSync, confirm: confirmGuard });
        if (cancelled) {
          msg.textContent = 'キャンセルしました';
          return;
        }
        if (!resp || !resp.success) {
          const r = resp && resp.reason ? resp.reason : 'unknown';
          const errDetail = resp && resp.errors && resp.errors.length
            ? ` [${resp.errors.join(' / ')}]` : '';
          msg.textContent = `同期失敗: ${r}${errDetail}（YouTubeタブを開いて再試行してください）`;
          if (resp && resp.errors && resp.errors.length) console.warn('[liked-sync errors]', resp.errors);
          if (resp && resp.diagnostics) console.info('[liked-sync diagnostics]', resp.diagnostics);
          return;
        }
        const errTag = resp.errors && resp.errors.length ? ` / 警告${resp.errors.length}件` : '';
        // M1: pagination stopped before exhausting the playlist — surface it as a
        // partial sync so the user knows to re-sync rather than trusting the count.
        if (resp.partial) {
          msg.textContent = `⚠️ 部分同期: 取得${resp.fetched}件 / 新規${resp.added}件 / ${resp.pages || 1}ページ${errTag}（全件を取得できていません。時間をおいて再同期してください）`;
        } else {
          msg.textContent = `同期完了: 取得${resp.fetched}件 / 新規${resp.added}件 / ${resp.pages || 1}ページ${errTag}`;
        }
        if (resp.errors && resp.errors.length) console.warn('[liked-sync errors]', resp.errors);
        if (resp.diagnostics) console.info('[liked-sync diagnostics]', resp.diagnostics);
        // Refresh rows and meta together. If either loader times out, its existing
        // late callback still re-renders the views; copying stays disabled until
        // both responses have actually arrived.
        await reloadLikedAfterSync();
      } catch (e) {
        msg.textContent = '同期エラー: ' + e.message;
      } finally {
        syncLikedBtn.disabled = false;
      }
    });
  }

  // Copy prompt button
  document.getElementById('azCopyPrompt').addEventListener('click', async () => {
    const text = document.getElementById('azPromptText').textContent;
    try {
      await navigator.clipboard.writeText(text);
      const msg = document.getElementById('azCopyMsg');
      msg.textContent = 'コピーしました';
      setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (e) {
      alert('コピー失敗: ' + e.message);
    }
  });

  // Toggle between list view and analyze view
  const btn = document.getElementById('toggleAnalyze');
  const listView = document.getElementById('content');
  const analyzeView = document.getElementById('analyzeView');
  let analyzeMode = false;

  btn.addEventListener('click', () => {
    analyzeMode = !analyzeMode;
    btn.classList.toggle('active', analyzeMode);
    if (analyzeMode) {
      listView.style.display = 'none';
      analyzeView.style.display = '';
      runAnalysis();
    } else {
      listView.style.display = '';
      analyzeView.style.display = 'none';
    }
  });
})();
