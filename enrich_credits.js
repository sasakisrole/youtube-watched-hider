// Enrich Credits UI controller for history.html.
// Keeps all enrichment state in memory; IndexedDB writes go through existing DB_RPC UPDATE_CREDITS.
(function () {
  'use strict';

  const AUTO_SIM_THRESHOLD = 0.95;
  const REVIEW_SIM_THRESHOLD = 0.85;
  const RENDER_CHUNK_SIZE = 50;

  // DESIGN_enrich_credits.md test-case hooks:
  // Case 1: createRuleCandidate() returns source="rule", sim=null, selected=true.
  // Case 2: candidateFromSong() requires both sim >= 0.95 and source-provided auto eligibility.
  //         MusicBrainz only grants that eligibility to identity-checked strict matches.
  // Case 3: 0.85 <= sim < 0.95 stays selected=false; renderCandidateRow() creates a youtu.be link.
  // Case 4: candidateFromSong() returns null when sim < 0.85.
  // Case 6: needsCreditEnrichment() is the extraction gate — role-unit now, so a row with
  //         SOME roles filled (composer set, arranger blank) is still enriched (was: all-or-nothing).
  // Case 7: renderTabs() only sees channels present in candidatesByChannel, so zero-hit channels are hidden.
  // Case 8: generateCandidates() no longer short-circuits after a rule match — remaining missing roles
  //         still flow to MusicBrainz per video (HANDOFF §3.2/§3.3, role-unit waterfall).

  function unwrapWatchedRecords(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && data.schemaVersion === 2 && Array.isArray(data.watchedVideos)) return data.watchedVideos;
    if (data && typeof data === 'object' && Array.isArray(data.records)) return data.records;
    return [];
  }

  function isBlank(value) {
    return value == null || String(value).trim() === '';
  }

  function isUnassignedCreditRecord(record) {
    return !!(record && record.creditsRaw && isBlank(record.composer) && isBlank(record.lyricist) && isBlank(record.arranger));
  }

  const CREDIT_ROLES = ['composer', 'lyricist', 'arranger'];
  const CREDIT_ROLE_LABELS = Object.freeze({ composer: '作曲', lyricist: '作詞', arranger: '編曲' });
  const CREDIT_ROLE_SEARCH_LABELS = Object.freeze({ composer: '作曲者', lyricist: '作詞者', arranger: '編曲者' });
  const CREDIT_SOURCE_LABELS = Object.freeze({
    topic: 'Topic 概要欄', general: '一般動画の概要欄',
    'enrich:rule': '固定ルール', 'enrich:mb': 'MusicBrainz', manual: '手動入力',
    '': '由来なし',
  });

  // Role-unit gap detection (HANDOFF §3.1 / DESIGN B-1). Replaces the old
  // whole-video gate: a record with composer filled but arranger blank is now
  // "missing arranger" instead of "already assigned / skip".
  function getMissingCreditRoles(record) {
    return CREDIT_ROLES.filter((role) => isBlank(record && record[role]));
  }

  // Enrichment eligibility. requireRawHint keeps the conservative music-signal
  // gate (only records whose description carried credit-like text) so switching
  // to role-unit judgement does not suddenly target every non-music video.
  function needsCreditEnrichment(record, { requireRawHint = true } = {}) {
    if (!record) return false;
    if (getMissingCreditRoles(record).length === 0) return false;
    if (!requireRawHint) return true;
    return !isBlank(record.creditsRaw);
  }

  function getEnrichmentPreCount(records) {
    const targets = (Array.isArray(records) ? records : []).filter((record) => needsCreditEnrichment(record));
    return {
      videoCount: targets.length,
      channelCount: new Set(targets.map((record) => record.channel || '(no channel)')).size,
    };
  }

  function getLimitedVideoCount(videoCount, limit) {
    const count = Math.max(0, Math.floor(Number(videoCount) || 0));
    if (limit == null) return count;
    const parsedLimit = Math.floor(Number(limit));
    return Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(count, parsedLimit) : count;
  }

  // Each MusicBrainz lookup starts with one strict recording search. At most it
  // also performs one fallback search, one recording fetch, and three work fetches.
  const ENRICH_REQUESTS_PER_VIDEO_MIN = 1;
  const ENRICH_REQUESTS_PER_VIDEO_MAX = 6;

  function estimateEnrichmentMinutes(videoCount, rateLimitMs) {
    const count = Math.max(0, Math.floor(Number(videoCount) || 0));
    const interval = Math.max(0, Number(rateLimitMs) || 0);
    if (!count || !interval) return { minMinutes: 0, maxMinutes: 0 };
    const estimateForRequestCount = (requestsPerVideo) => (
      Math.max(1, Math.ceil((count * requestsPerVideo * interval) / 60000))
    );
    return {
      minMinutes: estimateForRequestCount(ENRICH_REQUESTS_PER_VIDEO_MIN),
      maxMinutes: estimateForRequestCount(ENRICH_REQUESTS_PER_VIDEO_MAX),
    };
  }

  function buildEnrichmentConfirmText(preCount, rateLimitMs, limit = null) {
    const videoCount = Number(preCount && preCount.videoCount) || 0;
    const channelCount = Number(preCount && preCount.channelCount) || 0;
    const processCount = getLimitedVideoCount(videoCount, limit);
    const { minMinutes, maxMinutes } = estimateEnrichmentMinutes(processCount, rateLimitMs);
    const maxRequests = processCount * ENRICH_REQUESTS_PER_VIDEO_MAX;
    return `${videoCount}動画 / ${channelCount}チャンネルを固定ルールとMusicBrainzで照合します。`
      + ` 処理予定 ${processCount}件、推定所要時間 約${minMinutes}〜${maxMinutes}分`
      + `（最大 約${maxRequests} 回の通信）。`;
  }

  function limitEnrichmentGroups(groups, limit) {
    if (limit == null) return groups;
    let remaining = Math.max(0, Math.floor(Number(limit) || 0));
    const limited = new Map();
    for (const [channel, videos] of groups) {
      if (!remaining) break;
      const selected = videos.slice(0, remaining);
      if (selected.length) limited.set(channel, selected);
      remaining -= selected.length;
    }
    return limited;
  }

  // Which of the still-missing roles does this candidate actually fill? Drives
  // (a) whether a candidate is worth adding and (b) which roles to drop from the
  // remaining set so the next source only chases what is still blank.
  function coveredNeededRoles(candidate, missing) {
    const has = missing instanceof Set ? (r) => missing.has(r) : (r) => (missing || []).includes(r);
    return CREDIT_ROLES.filter((role) => has(role) && candidate && !isBlank(candidate[role]));
  }

  function sharedMissingCreditRoles(record) {
    const api = window.CreditTarget;
    return api && typeof api.getMissingCreditRoles === 'function'
      ? api.getMissingCreditRoles(record)
      : getMissingCreditRoles(record);
  }

  function buildManualSearchQuery(record, role) {
    const api = window.CreditTarget;
    const title = String(record && record.title || '').trim();
    const channel = String(record && record.channel || '').trim();
    const artist = api && typeof api.stripTopicChannelSuffix === 'function'
      ? api.stripTopicChannelSuffix(channel)
      : channel.replace(/\s*-\s*(?:topic|トピック)\s*$/iu, '').trim();
    return [title, artist, CREDIT_ROLE_SEARCH_LABELS[role] || ''].filter(Boolean).join(' ');
  }

  function manualRecordMatchesSearch(record, search) {
    const needle = String(search || '').normalize('NFKC').trim().toLocaleLowerCase();
    if (!needle) return true;
    return ['title', 'channel', 'videoId'].some((field) => String(record && record[field] || '')
      .normalize('NFKC').toLocaleLowerCase().includes(needle));
  }

  function getManualReviewRows(records, search = '') {
    return (Array.isArray(records) ? records : []).filter((record) => {
      if (!record || sharedMissingCreditRoles(record).length === 0) return false;
      const hasContext = !isBlank(record.creditsRaw)
        || CREDIT_ROLES.some((role) => !isBlank(record[role]));
      return hasContext && manualRecordMatchesSearch(record, search);
    });
  }

  function validateManualCreditInput(value, options = {}) {
    const allowBlank = options.allowBlank === true;
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return allowBlank
      ? { valid: true, reason: '', hint: '' }
      : { valid: false, reason: '名前が空です。', hint: '作曲者・作詞者・編曲者の名前を入力してください。' };
    if (Array.from(text).length > 60) return { valid: false, reason: '名前が長すぎます。', hint: '60文字以内の名前に短くしてください。' };
    if (/(?:https?:)?\/\/|(?:^|\s)www\.|(?:[a-z0-9-]+\.)+(?:com|net|org|jp|co|io|tv|me)(?:\/|$)/iu.test(text)) return { valid: false, reason: 'URLやドメインは保存できません。', hint: 'リンクではなく人物・グループ名だけを入力してください。' };
    if (/^@[\p{L}\p{N}_.-]+$/u.test(text)) return { valid: false, reason: 'ハンドル名だけでは保存できません。', hint: '@を除いた正式な名前を入力してください。' };
    if (/copyright\s+control|all\s+rights\s+reserved/iu.test(text)) return { valid: false, reason: '権利管理用の仮名は保存できません。', hint: 'クレジットに記載された実名を確認してください。' };
    if (/(?:作詞(?:家|者)?|作曲(?:家|者)?|編曲(?:家|者)?|lyrics?(?:\s+by)?|compos(?:ed\s+by|er)|arrang(?:ed\s+by|er))\s*[:：]?/iu.test(text)) return { valid: false, reason: '役割ラベルを含む値は保存できません。', hint: '「作曲:」などを除き、名前だけを入力してください。' };
    const api = window.CreditTarget;
    if (!api || typeof api.isValidCreditValue !== 'function' || !api.isValidCreditValue(value)) return { valid: false, reason: 'この値は保存できません。', hint: '記号や制御文字を除き、名前だけを入力してください。' };
    return { valid: true, reason: '', hint: '' };
  }

  // Blank every role a candidate was NOT accepted for, so a source picked only
  // for (say) the lyricist cannot smuggle its composer value into display,
  // export, or the force-write commit (DESIGN B-2 "fill missing roles only").
  function limitCandidateToRoles(candidate, roles) {
    const limited = Object.assign({}, candidate);
    for (const role of CREDIT_ROLES) {
      if (!roles.includes(role)) limited[role] = '';
    }
    return limited;
  }

  // Pure reference for the source waterfall (HANDOFF §3.2/§3.3, DESIGN B-3/B-6):
  // consult sources in order, each fills only roles still missing, stop once
  // nothing is missing. The live generateCandidates() mirrors this decision rule
  // (including limitCandidateToRoles) but fetches lazily per source; this pure
  // form is what the tests pin to.
  function waterfallAccept(initialMissing, sourceCandidates) {
    const missing = new Set(initialMissing);
    const accepted = [];
    for (const entry of sourceCandidates || []) {
      if (!missing.size) break;
      const candidate = entry && entry.candidate;
      if (!candidate) continue;
      const roles = coveredNeededRoles(candidate, missing);
      if (!roles.length) continue;
      accepted.push({ id: entry.id, candidate: limitCandidateToRoles(candidate, roles), roles });
      roles.forEach((role) => missing.delete(role));
    }
    return { accepted, remaining: Array.from(missing) };
  }

  function cleanArtistFromChannel(channel) {
    return window.CreditTarget.stripTopicChannelSuffix(channel);
  }

  function normalizeTitle(value) {
    let s = String(value || '').normalize('NFKC');
    s = s.replace(/\s*[\(\[（【〜~][\s\S]*?[\)\]）】〜~]\s*/g, '');
    s = s.replace(/\s*[-–—]\s*(Live|Remix|Acoustic|Instrumental|Off\s*Vocal|.*Style|Ballade ver).*$/i, '');
    s = s.replace(/[\s・･.\-_!?！？♪♥]+/g, '');
    return s.toLowerCase();
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

  function similarity(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (na && nb && na === nb) return 1;
    return sequenceRatio(na, nb);
  }

  function bestMatch(title, songs) {
    let best = null;
    let bestSim = 0;
    for (const song of songs || []) {
      const sim = similarity(title, song.title || '');
      if (sim > bestSim) {
        best = song;
        bestSim = sim;
      }
      if (sim === 1) break;
    }
    return best ? { song: best, sim: bestSim } : null;
  }

  function roleEntries(candidate) {
    const roles = [];
    if (candidate.composer) roles.push({ key: 'composer', label: '作曲', value: candidate.composer });
    if (candidate.lyricist) roles.push({ key: 'lyricist', label: '作詞', value: candidate.lyricist });
    if (candidate.arranger) roles.push({ key: 'arranger', label: '編曲', value: candidate.arranger });
    return roles;
  }

  function sourceToCreditsSource(source) {
    return `enrich:${source}`;
  }

  function createCandidateId(videoId, source) {
    return `${videoId}:${source}`;
  }

  function createRuleCandidate(record, rule) {
    return {
      id: createCandidateId(record.videoId, 'rule'),
      videoId: record.videoId,
      title: record.title || record.videoId,
      channel: record.channel || '',
      composer: rule.composer || '',
      lyricist: rule.lyricist || '',
      arranger: rule.arranger || '',
      source: 'rule',
      sourceDetail: rule.evidence || '',
      matchedTitle: '',
      sim: null,
      selected: true,
    };
  }

  function candidateFromSong(record, song, sim, source, detail, matchPolicy) {
    if (!song || sim < REVIEW_SIM_THRESHOLD) return null;
    const policy = matchPolicy || {};
    const isMusicBrainz = source === 'mb';
    const autoEligible = isMusicBrainz
      ? detail === 'strict' && policy.autoEligible === true && policy.requiresManualReview === false
      : true;
    const candidate = {
      id: createCandidateId(record.videoId, source),
      videoId: record.videoId,
      title: record.title || record.videoId,
      channel: record.channel || '',
      composer: song.composer || '',
      lyricist: song.lyricist || '',
      arranger: song.arranger || '',
      source,
      sourceDetail: [detail, policy.manualReviewReason].filter(Boolean).join(' / '),
      matchedTitle: song.title || '',
      sim,
      autoEligible: autoEligible && sim >= AUTO_SIM_THRESHOLD,
      requiresManualReview: isMusicBrainz ? !autoEligible : false,
      recordingVersion: policy.recordingVersion || '',
      mbRecordingVersion: policy.mbRecordingVersion || '',
      versionMatch: policy.versionMatch !== false,
      manualReviewReason: policy.manualReviewReason || '',
      selected: autoEligible && sim >= AUTO_SIM_THRESHOLD,
    };
    return roleEntries(candidate).length ? candidate : null;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function setHidden(el, hidden) {
    if (!el) return;
    el.hidden = hidden;
  }

  function appendInlineIcon(button, paths) {
    if (!button || typeof document.createElementNS !== 'function') return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    button.appendChild(svg);
  }

  class EnrichCreditsController {
    constructor(env) {
      this.env = env || {};
      this.modal = document.getElementById('enrichModal');
      this.closeBtn = document.getElementById('enrichClose');
      this.cancelBtn = document.getElementById('enrichCancel');
      this.generateBtn = document.getElementById('enrichGenerate');
      this.abortBtn = document.getElementById('enrichAbort');
      this.commitBtn = document.getElementById('enrichCommit');
      this.downloadBtn = document.getElementById('enrichDownloadPlan');
      this.progressEl = document.getElementById('enrichProgress');
      this.progressBar = document.getElementById('enrichProgressBar');
      this.messageEl = document.getElementById('enrichMessage');
      this.tabsEl = document.getElementById('enrichTabs');
      this.bodyEl = document.getElementById('enrichCandidateBody');
      this.emptyEl = document.getElementById('enrichEmpty');
      this.tableWrap = document.getElementById('enrichTableWrap');
      this.totalEl = document.getElementById('enrichTotal');
      this.subtitleEl = document.getElementById('enrichSubtitle');
      this.autoViewTab = document.getElementById('enrichAutoViewTab');
      this.manualViewTab = document.getElementById('enrichManualViewTab');
      this.autoView = document.getElementById('enrichAutoView');
      this.manualView = document.getElementById('enrichManualView');
      this.manualSearchEl = document.getElementById('enrichManualSearch');
      this.manualListEl = document.getElementById('enrichManualList');
      this.manualEmptyEl = document.getElementById('enrichManualEmpty');
      this.manualCountEl = document.getElementById('enrichManualCount');
      this.manualStatusEl = document.getElementById('enrichManualStatus');


      this.rules = null;
      this.candidatesByChannel = new Map();
      this.activeChannel = '';
      this.sortKey = 'default';
      this.sortDir = 'asc';
      this.renderedRows = 0;
      this.generating = false;
      this.committing = false;
      this.abortRequested = false;
      this.confirmingGeneration = false;
      this.cancelGenerationConfirmation = null;
      this.errors = [];
      this.fetchCache = {
        mb: new Map(),
      };

      this.activeView = 'auto';
      this.manualSearch = '';
      this.manualMessages = new Map();
      this.manualUndoActions = new Map();
      this.manualEditing = new Set();
      this.manualPinnedVideoIds = new Set();
      this.manualBusy = new Set();
      this.previousFocus = null;
      this.bind();
      this.renderAll();
    }

    bind() {
      if (!this.modal) return;
      this.closeBtn && this.closeBtn.addEventListener('click', () => this.close());
      this.cancelBtn && this.cancelBtn.addEventListener('click', () => this.close());
      this.generateBtn && this.generateBtn.addEventListener('click', () => this.generateCandidates());
      this.abortBtn && this.abortBtn.addEventListener('click', () => this.abort());
      this.commitBtn && this.commitBtn.addEventListener('click', () => this.commitSelected());
      this.downloadBtn && this.downloadBtn.addEventListener('click', () => this.downloadPlan());
      this.autoViewTab && this.autoViewTab.addEventListener('click', () => this.switchView('auto'));
      this.manualViewTab && this.manualViewTab.addEventListener('click', () => this.switchView('manual'));
      for (const tab of [this.autoViewTab, this.manualViewTab].filter(Boolean)) {
        tab.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          this.switchView(this.activeView === 'auto' ? 'manual' : 'auto', true);
        });
      }
      this.manualSearchEl && this.manualSearchEl.addEventListener('input', () => {
        this.manualSearch = this.manualSearchEl.value || '';
        this.renderManualView();
      });
      this.tableWrap && this.tableWrap.addEventListener('scroll', () => {
        if (this.tableWrap.scrollTop + this.tableWrap.clientHeight >= this.tableWrap.scrollHeight - 80) {
          this.renderMoreRows();
        }
      });
      this.modal.querySelectorAll('[data-enrich-sort]').forEach((header) => {
        header.addEventListener('click', () => this.setSort(header.dataset.enrichSort));
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.modal && !this.modal.hidden && !this.committing) {
          this.close();
        }
      });
    }

    open() {
      if (!this.modal) return;
      this.previousFocus = document.activeElement || null;
      this.modal.hidden = false;
      this.modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('enrich-modal-open');
      if (this.activeView === 'manual') this.renderManualView();
      else this.renderAll();
    }

    close() {
      if (!this.modal || this.committing) return;
      if (this.cancelGenerationConfirmation) this.cancelGenerationConfirmation();
      this.modal.hidden = true;
      this.modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('enrich-modal-open');
      if (this.previousFocus && typeof this.previousFocus.focus === 'function') this.previousFocus.focus();
      this.previousFocus = null;
    }

    abort() {
      if (!this.generating) return;
      this.abortRequested = true;
      this.setMessage('中止要求を受け付けました。現在の取得が終わり次第停止します。');
      this.updateButtons();
    }

    switchView(view, focusTab = false) {
      if (view !== 'auto' && view !== 'manual') return;
      this.activeView = view;
      const manual = view === 'manual';
      setHidden(this.autoView, manual);
      setHidden(this.manualView, !manual);
      if (this.autoViewTab) {
        this.autoViewTab.classList.toggle('active', !manual);
        this.autoViewTab.setAttribute('aria-selected', manual ? 'false' : 'true');
        this.autoViewTab.tabIndex = manual ? -1 : 0;
      }
      if (this.manualViewTab) {
        this.manualViewTab.classList.toggle('active', manual);
        this.manualViewTab.setAttribute('aria-selected', manual ? 'true' : 'false');
        this.manualViewTab.tabIndex = manual ? 0 : -1;
      }
      if (this.subtitleEl) this.subtitleEl.textContent = manual
        ? '不足している作曲・作詞・編曲を確認し、役割ごとに保存します。'
        : '未割当 creditsRaw を固定ルール、MusicBrainz の順に照合します。';
      if (manual) this.renderManualView();
      else this.renderAll();
      const focusTarget = manual ? this.manualViewTab : this.autoViewTab;
      if (focusTab && focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
    }

    resetSession() {
      this.candidatesByChannel = new Map();
      this.activeChannel = '';
      this.renderedRows = 0;
      this.errors = [];
      this.fetchCache.mb.clear();
      this.updateProgress('待機中', 0);
      this.setMessage('候補生成を開始してください。');
      this.renderAll();
    }

    getRecords() {
      const provider = this.env.getRecords;
      return typeof provider === 'function' ? (provider() || []) : [];
    }

    setMessage(text, tone) {
      if (!this.messageEl) return;
      this.messageEl.textContent = text || '';
      this.messageEl.classList.toggle('error', tone === 'error');
      this.messageEl.classList.toggle('success', tone === 'success');
    }

    manualRoleKey(record, role) {
      return `${record && record.videoId || ''}:${role}`;
    }

    effectiveManualSource(record, role) {
      const api = window.CreditTarget;
      return api && typeof api.effectiveRoleSource === 'function'
        ? api.effectiveRoleSource(record, role)
        : String(record && record.creditsSource || '');
    }

    getManualDisplayRows() {
      const records = this.getRecords();
      const rows = getManualReviewRows(records, this.manualSearch);
      const seen = new Set(rows.map((record) => record.videoId));
      for (const record of records) {
        if (!record || seen.has(record.videoId) || !this.manualPinnedVideoIds.has(record.videoId)) continue;
        if (!manualRecordMatchesSearch(record, this.manualSearch)) continue;
        rows.push(record);
        seen.add(record.videoId);
      }
      return rows;
    }

    setManualRoleMessage(record, role, text, tone) {
      this.manualMessages.set(this.manualRoleKey(record, role), { text: text || '', tone: tone || '' });
    }

    applyManualState(record, role, post, restoreRoleSource, hasRestoreRoleSource) {
      if (!record || !post) return;
      record[role] = post.value;
      const sources = record.creditRoleSources && typeof record.creditRoleSources === 'object'
        && !Array.isArray(record.creditRoleSources) ? { ...record.creditRoleSources } : {};
      if (hasRestoreRoleSource) {
        if (restoreRoleSource === null) delete sources[role];
        else sources[role] = restoreRoleSource;
      } else if (isBlank(post.value)) {
        delete sources[role];
      } else if (post.source === 'manual') {
        sources[role] = 'manual';
      }
      if (Object.keys(sources).length) record.creditRoleSources = sources;
      else delete record.creditRoleSources;
    }

    async reloadManualData() {
      if (typeof this.env.reloadData === 'function') await Promise.resolve(this.env.reloadData());
    }

    async sendManualMutation(payload) {
      const message = { type: 'DB_RPC', op: 'SET_MANUAL_CREDIT_ROLE', ...payload };
      return typeof this.env.sendDbRpc === 'function'
        ? this.env.sendDbRpc(message)
        : sendRuntimeMessage(message);
    }

    async performManualMutation(record, role, value, options = {}) {
      const key = this.manualRoleKey(record, role);
      if (this.manualBusy.has(key)) return { error: 'busy' };
      const allowBlank = options.allowBlank === true;
      const validation = validateManualCreditInput(value, { allowBlank });
      if (!validation.valid) {
        this.setManualRoleMessage(record, role, `${validation.reason} ${validation.hint}`.trim(), 'error');
        this.renderManualView();
        return { error: 'invalid_value' };
      }

      const expected = options.expected || {
        value: record && record[role],
        source: this.effectiveManualSource(record, role),
      };
      const payload = {
        videoId: record.videoId,
        role,
        value,
        expectedCurrent: expected.value,
        expectedSource: expected.source,
      };
      const hasRestoreRoleSource = Object.prototype.hasOwnProperty.call(options, 'restoreRoleSource');
      if (hasRestoreRoleSource) payload.restoreRoleSource = options.restoreRoleSource;

      this.manualBusy.add(key);
      this.setManualRoleMessage(record, role, '保存しています。', '');
      this.renderManualView();
      try {
        const response = await this.sendManualMutation(payload);
        if (!response || response.success !== true) {
          const detail = response && response.error ? response.error : 'DB通信に失敗しました。';
          this.setManualRoleMessage(record, role, `保存できませんでした: ${detail}`, 'error');
          return { error: 'transport' };
        }

        const result = response.result || {};
        if (result.updated === true) {
          this.applyManualState(record, role, result.post, options.restoreRoleSource, hasRestoreRoleSource);
          this.manualPinnedVideoIds.add(record.videoId);
          if (options.isUndo) this.manualUndoActions.delete(key);
          else this.manualUndoActions.set(key, { previous: result.previous, post: result.post });
          this.manualEditing.delete(key);
          this.setManualRoleMessage(record, role, options.isUndo ? '元に戻しました。' : '保存しました。', 'success');
          await this.reloadManualData();
          return result;
        }

        if (result.conflict === true) {
          if (result.current) {
            record[role] = result.current.value;
            const sources = record.creditRoleSources && typeof record.creditRoleSources === 'object'
              && !Array.isArray(record.creditRoleSources) ? { ...record.creditRoleSources } : {};
            if (result.current.source) sources[role] = result.current.source;
            else delete sources[role];
            record.creditRoleSources = sources;
          }
          this.setManualRoleMessage(record, role, '他の更新が反映されました。最新値を確認して再試行してください。', 'error');
          await this.reloadManualData();
          return result;
        }

        const errorLabels = {
          invalid_value: '入力値を保存できません。名前だけを入力してください。',
          not_manual: '自動取得された値はこの画面から変更できません。',
          bad_role: '対象の役割が不正です。',
          not_found: '動画が見つかりません。データを再読み込みしてください。',
        };
        this.setManualRoleMessage(record, role,
          errorLabels[result.error] || '更新されませんでした。最新値を確認して再試行してください。', 'error');
        return result;
      } catch (error) {
        this.setManualRoleMessage(record, role, `保存できませんでした: ${error.message}`, 'error');
        return { error: 'transport' };
      } finally {
        this.manualBusy.delete(key);
        this.renderManualView();
      }
    }

    async undoManualMutation(record, role) {
      const action = this.manualUndoActions.get(this.manualRoleKey(record, role));
      if (!action) return { error: 'no_undo' };
      return this.performManualMutation(record, role, action.previous.value, {
        allowBlank: true,
        isUndo: true,
        expected: action.post,
        restoreRoleSource: action.previous.sourcePresent ? action.previous.source : null,
      });
    }

    async copyManualSearchQuery(record, role) {
      const query = buildManualSearchQuery(record, role);
      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard
          || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(query);
        this.setManualRoleMessage(record, role, '検索語をコピーしました。', 'success');
      } catch (_error) {
        this.setManualRoleMessage(record, role, '検索語をコピーできませんでした。ブラウザの権限を確認してください。', 'error');
      }
      this.renderManualView();
      return query;
    }

    createManualButton(label, action, iconPaths, className = '') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `sort-btn manual-action-btn ${className}`.trim();
      button.dataset.manualAction = action;
      appendInlineIcon(button, iconPaths);
      const text = document.createElement('span');
      text.textContent = label;
      button.appendChild(text);
      return button;
    }

    renderManualView() {
      if (!this.manualListEl) return;
      const rows = this.getManualDisplayRows();
      this.manualListEl.textContent = '';
      const fragment = document.createDocumentFragment();
      let missingCount = 0;
      for (const record of rows) {
        missingCount += sharedMissingCreditRoles(record).length;
        fragment.appendChild(this.renderManualVideoCard(record));
      }
      this.manualListEl.appendChild(fragment);
      setHidden(this.manualEmptyEl, rows.length > 0);
      if (this.manualCountEl) this.manualCountEl.textContent = `対象 ${rows.length}件 / 不足 ${missingCount}役割`;
      if (this.manualStatusEl) this.manualStatusEl.textContent = rows.length
        ? '検索語のコピーはクリップボードだけを使用します。'
        : '条件に一致する手動確認対象はありません。';
    }

    renderManualVideoCard(record) {
      const card = document.createElement('article');
      card.className = 'manual-video-card';
      card.dataset.videoId = record.videoId;

      const header = document.createElement('header');
      header.className = 'manual-video-header';
      const titleWrap = document.createElement('div');
      const title = document.createElement('a');
      title.className = 'manual-video-title';
      title.href = `https://youtu.be/${encodeURIComponent(record.videoId)}`;
      title.target = '_blank';
      title.rel = 'noopener';
      title.textContent = record.title || record.videoId;
      titleWrap.appendChild(title);
      const channel = document.createElement('span');
      channel.className = 'manual-video-channel';
      channel.textContent = record.channel || 'チャンネル名なし';
      titleWrap.appendChild(channel);
      header.appendChild(titleWrap);
      const videoId = document.createElement('code');
      videoId.className = 'manual-video-id';
      videoId.textContent = record.videoId;
      header.appendChild(videoId);
      card.appendChild(header);

      const current = document.createElement('div');
      current.className = 'manual-current-grid';
      for (const role of CREDIT_ROLES) current.appendChild(this.renderManualCurrentRole(record, role));
      card.appendChild(current);

      const missing = sharedMissingCreditRoles(record);
      if (missing.length) {
        const heading = document.createElement('h3');
        heading.className = 'manual-missing-heading';
        heading.textContent = '不足している役割';
        card.appendChild(heading);
        const list = document.createElement('div');
        list.className = 'manual-missing-list';
        for (const role of missing) list.appendChild(this.renderManualInputForm(record, role, '', false));
        card.appendChild(list);
      }
      return card;
    }

    renderManualCurrentRole(record, role) {
      const key = this.manualRoleKey(record, role);
      const source = this.effectiveManualSource(record, role);
      const item = document.createElement('section');
      item.className = 'manual-current-role';
      item.dataset.role = role;

      const label = document.createElement('strong');
      label.textContent = CREDIT_ROLE_LABELS[role];
      item.appendChild(label);
      const value = document.createElement('span');
      value.className = 'manual-current-value';
      value.textContent = isBlank(record[role]) ? '未入力' : record[role];
      item.appendChild(value);
      const sourceEl = document.createElement('span');
      sourceEl.className = 'manual-source-label';
      sourceEl.textContent = CREDIT_SOURCE_LABELS[source] || source || CREDIT_SOURCE_LABELS[''];
      item.appendChild(sourceEl);

      const actions = document.createElement('div');
      actions.className = 'manual-current-actions';
      if (source === 'manual') {
        const edit = this.createManualButton('修正', 'edit', ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z']);
        edit.setAttribute('aria-label', `${CREDIT_ROLE_LABELS[role]}を修正`);
        edit.addEventListener('click', () => {
          this.manualEditing.add(key);
          this.renderManualView();
        });
        actions.appendChild(edit);
        const cancel = this.createManualButton('手動入力を取り消す', 'cancel', ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'], 'manual-danger-btn');
        cancel.setAttribute('aria-label', `${CREDIT_ROLE_LABELS[role]}の手動入力を取り消す`);
        cancel.disabled = this.manualBusy.has(key);
        cancel.addEventListener('click', () => this.performManualMutation(record, role, '', { allowBlank: true }));
        actions.appendChild(cancel);
      }
      if (this.manualUndoActions.has(key)) {
        const undo = this.createManualButton('元に戻す', 'undo', ['M9 14 4 9l5-5', 'M4 9h9a7 7 0 0 1 7 7v1']);
        undo.setAttribute('aria-label', `${CREDIT_ROLE_LABELS[role]}の直前の操作を元に戻す`);
        undo.disabled = this.manualBusy.has(key);
        undo.addEventListener('click', () => this.undoManualMutation(record, role));
        actions.appendChild(undo);
      }
      item.appendChild(actions);

      const message = this.manualMessages.get(key);
      if (message && message.text) {
        const status = document.createElement('p');
        status.className = `manual-role-message ${message.tone || ''}`.trim();
        status.dataset.roleStatus = role;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = message.text;
        item.appendChild(status);
      }
      if (this.manualEditing.has(key) && source === 'manual') {
        item.appendChild(this.renderManualInputForm(record, role, record[role] || '', true));
      }
      return item;
    }

    renderManualInputForm(record, role, initialValue, editing) {
      const key = this.manualRoleKey(record, role);
      const form = document.createElement('div');
      form.className = editing ? 'manual-role-form manual-edit-form' : 'manual-role-form';
      form.dataset.role = role;
      form.dataset.formMode = editing ? 'edit' : 'missing';

      const roleLabel = document.createElement('strong');
      roleLabel.className = 'manual-role-label';
      roleLabel.textContent = CREDIT_ROLE_LABELS[role];
      form.appendChild(roleLabel);

      const copy = this.createManualButton('検索語をコピー', 'copy', ['M8 8h11v11H8z', 'M5 16H4V5h11v1']);
      copy.setAttribute('aria-label', `${CREDIT_ROLE_SEARCH_LABELS[role]}の検索語をコピー`);
      copy.addEventListener('click', () => this.copyManualSearchQuery(record, role));
      form.appendChild(copy);

      const inputId = `manual-${String(record.videoId).replace(/[^a-zA-Z0-9_-]/g, '-')}-${role}-${editing ? 'edit' : 'missing'}`;
      const inputWrap = document.createElement('div');
      inputWrap.className = 'manual-input-wrap';
      const label = document.createElement('label');
      label.setAttribute('for', inputId);
      label.textContent = `${CREDIT_ROLE_LABELS[role]}の名前`;
      inputWrap.appendChild(label);
      const input = document.createElement('input');
      input.type = 'text';
      input.id = inputId;
      input.value = initialValue || '';
      input.maxLength = 120;
      input.autocomplete = 'off';
      input.dataset.manualRoleInput = role;
      input.setAttribute('aria-describedby', `${inputId}-validation`);
      inputWrap.appendChild(input);
      const validationEl = document.createElement('p');
      validationEl.id = `${inputId}-validation`;
      validationEl.className = 'manual-validation';
      inputWrap.appendChild(validationEl);
      form.appendChild(inputWrap);

      const save = this.createManualButton(editing ? '修正を保存' : 'この役割を保存', editing ? 'save-edit' : 'save', ['M5 4h12l2 2v14H5z', 'M8 4v6h8V4', 'M8 17h8']);
      save.setAttribute('aria-label', `${CREDIT_ROLE_LABELS[role]}の入力値を保存`);
      form.appendChild(save);

      const updateValidation = () => {
        const validation = validateManualCreditInput(input.value);
        input.setAttribute('aria-invalid', validation.valid ? 'false' : 'true');
        validationEl.classList.toggle('error', !validation.valid);
        validationEl.textContent = validation.valid ? '保存できる形式です。' : `${validation.reason} ${validation.hint}`;
        save.disabled = !validation.valid || this.manualBusy.has(key);
        return validation;
      };
      input.addEventListener('input', updateValidation);
      save.addEventListener('click', () => {
        if (!updateValidation().valid) return;
        return this.performManualMutation(record, role, input.value, { allowBlank: false });
      });

      if (editing) {
        const close = this.createManualButton('編集を閉じる', 'close-edit', ['M18 6 6 18', 'm6 6 12 12']);
        close.setAttribute('aria-label', `${CREDIT_ROLE_LABELS[role]}の編集欄を閉じる`);
        close.addEventListener('click', () => {
          this.manualEditing.delete(key);
          this.renderManualView();
        });
        form.appendChild(close);
      }
      updateValidation();
      return form;
    }

    updateProgress(text, ratio) {
      if (this.progressEl) this.progressEl.textContent = text;
      if (this.progressBar) this.progressBar.style.width = `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`;
    }

    updateButtons() {
      const hasCandidates = this.getAllCandidates().length > 0;
      const selected = this.getSelectedCandidates().length;
      if (this.generateBtn) this.generateBtn.disabled = this.generating || this.committing || this.confirmingGeneration;
      if (this.abortBtn) this.abortBtn.disabled = !this.generating || this.abortRequested;
      if (this.commitBtn) this.commitBtn.disabled = this.generating || this.committing || selected === 0;
      if (this.downloadBtn) this.downloadBtn.disabled = this.generating || this.committing || selected === 0;
      if (this.cancelBtn) this.cancelBtn.disabled = this.committing;
      if (this.closeBtn) this.closeBtn.disabled = this.committing;
      if (!hasCandidates && !this.generating && this.commitBtn) this.commitBtn.disabled = true;
    }

    confirmGeneration(preCount, rateLimitMs) {
      const host = this.autoView || this.modal;
      if (!host || typeof document.createElement !== 'function') return Promise.resolve(false);

      const panel = document.createElement('div');
      panel.className = 'enrich-message enrich-precount-confirm';
      panel.setAttribute('role', 'alertdialog');
      panel.setAttribute('aria-labelledby', 'enrichPreCountTitle');
      panel.setAttribute('aria-describedby', 'enrichPreCountDescription');
      panel.style.padding = '16px 18px';
      panel.style.background = 'var(--surface)';

      const title = document.createElement('strong');
      title.id = 'enrichPreCountTitle';
      title.textContent = '候補生成の確認';
      panel.appendChild(title);

      const description = document.createElement('p');
      description.id = 'enrichPreCountDescription';
      description.textContent = buildEnrichmentConfirmText(preCount, rateLimitMs);
      description.style.margin = '8px 0 12px';
      panel.appendChild(description);

      const limitRow = document.createElement('div');
      limitRow.style.display = 'flex';
      limitRow.style.gap = '8px';
      limitRow.style.alignItems = 'center';
      limitRow.style.flexWrap = 'wrap';
      limitRow.style.margin = '0 0 12px';

      const limitLabel = document.createElement('label');
      limitLabel.setAttribute('for', 'enrichPreCountLimitMode');
      limitLabel.textContent = '処理件数:';

      const limitMode = document.createElement('select');
      limitMode.id = 'enrichPreCountLimitMode';
      limitMode.dataset.enrichPrecountLimitMode = 'true';
      limitMode.setAttribute('aria-label', '処理件数の指定方法');
      const allOption = document.createElement('option');
      allOption.value = 'all';
      allOption.textContent = '全件';
      const limitedOption = document.createElement('option');
      limitedOption.value = 'limited';
      limitedOption.textContent = '上位N件';
      limitMode.appendChild(allOption);
      limitMode.appendChild(limitedOption);
      limitMode.value = 'all';

      const limitInput = document.createElement('input');
      limitInput.type = 'number';
      limitInput.dataset.enrichPrecountLimit = 'true';
      limitInput.setAttribute('aria-label', '処理する上位件数');
      limitInput.min = '1';
      limitInput.max = String(preCount.videoCount);
      limitInput.step = '1';
      limitInput.value = String(Math.min(100, preCount.videoCount));
      limitInput.disabled = true;
      limitInput.style.width = '7em';
      limitInput.style.minHeight = '44px';

      limitRow.appendChild(limitLabel);
      limitRow.appendChild(limitMode);
      limitRow.appendChild(limitInput);
      panel.appendChild(limitRow);

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '8px';
      actions.style.flexWrap = 'wrap';

      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'sort-btn enrich-primary';
      start.dataset.enrichPrecountAction = 'start';
      start.setAttribute('aria-label', '候補生成を開始');
      start.textContent = '開始';
      start.style.minHeight = '44px';
      start.style.minWidth = '88px';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'sort-btn';
      cancel.dataset.enrichPrecountAction = 'cancel';
      cancel.setAttribute('aria-label', '候補生成をキャンセル');
      cancel.textContent = 'キャンセル';
      cancel.style.minHeight = '44px';
      cancel.style.minWidth = '88px';

      actions.appendChild(start);
      actions.appendChild(cancel);
      panel.appendChild(actions);
      host.appendChild(panel);

      const selectedLimit = () => {
        if (limitMode.value !== 'limited') return null;
        const value = Number(limitInput.value);
        return Number.isInteger(value) && value >= 1 && value <= preCount.videoCount ? value : undefined;
      };
      const updateEstimate = () => {
        const limit = selectedLimit();
        start.disabled = limitMode.value === 'limited' && limit === undefined;
        description.textContent = buildEnrichmentConfirmText(preCount, rateLimitMs, limit);
      };
      limitMode.addEventListener('change', () => {
        limitInput.disabled = limitMode.value !== 'limited';
        updateEstimate();
      });
      limitInput.addEventListener('input', updateEstimate);
      updateEstimate();

      const previousFocus = document.activeElement;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (confirmed) => {
          if (settled) return;
          settled = true;
          if (typeof panel.remove === 'function') panel.remove();
          this.cancelGenerationConfirmation = null;
          if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
          resolve(confirmed);
        };
        this.cancelGenerationConfirmation = () => finish(false);
        start.addEventListener('click', () => finish({ limit: selectedLimit() }));
        cancel.addEventListener('click', () => finish(false));
        panel.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
          finish(false);
        });
        if (typeof start.focus === 'function') start.focus();
      });
    }
    async loadRules() {
      if (this.rules) return this.rules;
      const url = chrome.runtime.getURL('composer_rules.json');
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`composer_rules.json HTTP ${response.status}`);
      const data = await response.json();
      this.rules = Array.isArray(data.rules) ? data.rules : [];
      return this.rules;
    }

    groupUnassigned(records) {
      const groups = new Map();
      for (const record of records) {
        // Role-unit gate: include records that still have ANY missing role
        // (was: only fully-unassigned records). creditsRaw stays required.
        if (!needsCreditEnrichment(record)) continue;
        const channel = record.channel || '(no channel)';
        if (!groups.has(channel)) groups.set(channel, []);
        groups.get(channel).push(record);
      }
      return new Map(Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])));
    }

    addCandidate(candidate) {
      if (!candidate || !candidate.videoId || !roleEntries(candidate).length) return false;
      const channel = candidate.channel || '(no channel)';
      if (!this.candidatesByChannel.has(channel)) this.candidatesByChannel.set(channel, []);
      const list = this.candidatesByChannel.get(channel);
      if (list.some((existing) => existing.id === candidate.id)) return false;
      list.push(candidate);
      return true;
    }

    async fetchMb(channel, title) {
      const artist = cleanArtistFromChannel(channel);
      const key = `${artist}\n${title}`;
      if (this.fetchCache.mb.has(key)) return this.fetchCache.mb.get(key);
      const response = await sendRuntimeMessage({ type: 'enrichCreditsMb', artist, title });
      if (!response || !response.success) {
        throw new Error((response && (response.error || response.reason)) || 'MusicBrainz fetch failed');
      }
      this.fetchCache.mb.set(key, response);
      return response;
    }

    async generateCandidates() {
      if (this.generating || this.committing || this.confirmingGeneration) return;
      const records = this.getRecords();
      const allGroups = this.groupUnassigned(records);
      if (!allGroups.size) {
        this.resetSession();
        this.setMessage('未割当 creditsRaw の対象行がありません。', 'success');
        return;
      }

      const preCount = getEnrichmentPreCount(records);
      this.confirmingGeneration = true;
      this.updateButtons();
      let confirmation = null;
      try {
        const config = await sendRuntimeMessage({ type: 'getEnrichCreditsConfig' });
        if (!config || !config.success || !(Number(config.rateLimitMs) > 0)) {
          throw new Error('通信間隔を取得できません');
        }
        confirmation = await this.confirmGeneration(preCount, Number(config.rateLimitMs));
      } catch (error) {
        this.setMessage(`候補生成の事前確認に失敗しました: ${error.message}`, 'error');
      } finally {
        this.confirmingGeneration = false;
        this.updateButtons();
      }
      if (!confirmation) return;
      const groups = limitEnrichmentGroups(allGroups, confirmation.limit);

      const beginOk = !this.env.beginMaintenance || this.env.beginMaintenance('生成中…（中止）', true);
      if (!beginOk) {
        this.setMessage('他のメンテナンス処理が実行中です。', 'error');
        return;
      }

      this.candidatesByChannel = new Map();
      this.activeChannel = '';
      this.renderedRows = 0;
      this.errors = [];
      this.abortRequested = false;
      this.generating = true;
      this.updateButtons();
      this.setMessage(`${groups.size}チャンネルを照合します。`);

      try {
        const rules = await this.loadRules();
        const ruleByChannel = new Map(rules.map((rule) => [rule.channel, rule]));
        const entries = Array.from(groups.entries());
        for (let i = 0; i < entries.length; i++) {
          const [channel, videos] = entries[i];
          if (this.abortRequested) break;
          const progressLabel = `${i + 1}/${entries.length}ch: ${channel}`;
          this.updateProgress(progressLabel, i / entries.length);
          if (this.env.updateMaintenance) this.env.updateMaintenance('生成中…（中止）', true);

          // Per-video remaining-role tracking. Each source below fills only the
          // roles still missing and hands the rest to the next source, so a
          // channel rule that only knows the composer no longer blocks
          // MusicBrainz for a missing lyricist/arranger (HANDOFF §3.2/§3.3).
          const states = videos.map((video) => ({ video, missing: new Set(getMissingCreditRoles(video)) }));
          const stillMissing = () => states.filter((s) => s.missing.size && !this.abortRequested);
          const applyCandidate = (state, candidate) => {
            if (this.abortRequested || !candidate) return;
            const roles = coveredNeededRoles(candidate, state.missing);
            if (!roles.length) return;
            // Add a role-limited copy so a candidate accepted for one role does
            // not carry (and later force-overwrite) another role's value.
            if (this.addCandidate(limitCandidateToRoles(candidate, roles))) {
              roles.forEach((role) => state.missing.delete(role));
            }
          };

          // Source 1: channel rule (no early `continue` — remaining roles flow on).
          const rule = ruleByChannel.get(channel);
          if (rule) {
            for (const state of states) {
              if (!state.missing.size) continue;
              applyCandidate(state, createRuleCandidate(state.video, rule));
            }
          }

          // Source 3: MusicBrainz per still-missing video (no channel-level gate —
          // one success elsewhere no longer starves the other videos, HANDOFF §3.3).
          for (const state of stillMissing()) {
            if (this.abortRequested) break;
            try {
              const mb = await this.fetchMb(channel, state.video.title || '');
              const m = mb && mb.candidate;
              const candidate = m && candidateFromSong(state.video, {
                title: m.mbTitle || mb.title || state.video.title || '',
                composer: m.composer || '',
                lyricist: m.lyricist || '',
                arranger: m.arranger || '',
              }, typeof m.sim === 'number' ? m.sim : similarity(state.video.title || '', m.mbTitle || ''), 'mb', m.stage || '', {
                autoEligible: m.autoEligible === true,
                requiresManualReview: m.requiresManualReview !== false,
                recordingVersion: m.recordingVersion || '',
                mbRecordingVersion: m.mbRecordingVersion || '',
                versionMatch: m.versionMatch === true,
                manualReviewReason: m.manualReviewReason || '',
              });
              applyCandidate(state, candidate);
            } catch (error) {
              this.errors.push(`${channel}: MusicBrainz ${error.message}`);
            }
          }
          this.renderAll();
        }

        this.updateProgress(this.abortRequested ? '中止しました' : '候補生成完了', 1);
        const candidates = this.getAllCandidates().length;
        const selected = this.getSelectedCandidates().length;
        const suffix = this.errors.length ? ` / エラー ${this.errors.length}件` : '';
        this.setMessage(`候補 ${candidates}件、確定予定 ${selected}件を生成しました${suffix}。`, this.errors.length ? undefined : 'success');
      } catch (error) {
        this.setMessage(`候補生成に失敗しました: ${error.message}`, 'error');
      } finally {
        this.generating = false;
        this.abortRequested = false;
        if (this.env.endMaintenance) this.env.endMaintenance();
        this.updateButtons();
        this.renderAll();
      }
    }

    getSortedChannels() {
      return Array.from(this.candidatesByChannel.entries())
        .filter((entry) => entry[1].length > 0)
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map((entry) => entry[0]);
    }

    getActiveCandidates() {
      if (!this.activeChannel || !this.candidatesByChannel.has(this.activeChannel)) return [];
      const list = [...(this.candidatesByChannel.get(this.activeChannel) || [])];
      if (this.sortKey === 'default') return list;
      const dir = this.sortDir === 'desc' ? -1 : 1;
      list.sort((a, b) => {
        const av = this.sortValue(a, this.sortKey);
        const bv = this.sortValue(b, this.sortKey);
        if (typeof av === 'number' || typeof bv === 'number') {
          return ((av || 0) - (bv || 0)) * dir;
        }
        return String(av || '').localeCompare(String(bv || '')) * dir;
      });
      return list;
    }

    sortValue(candidate, key) {
      if (key === 'title') return candidate.title || '';
      if (key === 'value') return roleEntries(candidate).map((role) => role.value).join(' ');
      if (key === 'role') return roleEntries(candidate).map((role) => role.label).join('/');
      if (key === 'source') return candidate.source || '';
      if (key === 'sim') return candidate.sim == null ? -1 : candidate.sim;
      return '';
    }

    setSort(key) {
      if (!key) return;
      if (this.sortKey === key) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        this.sortKey = key;
        this.sortDir = key === 'sim' ? 'desc' : 'asc';
      }
      this.renderTable(true);
      this.renderSortHeaders();
    }

    renderSortHeaders() {
      if (!this.modal) return;
      this.modal.querySelectorAll('[data-enrich-sort]').forEach((header) => {
        const active = header.dataset.enrichSort === this.sortKey;
        header.dataset.sortActive = active ? 'true' : 'false';
        header.title = active ? `クリックで${this.sortDir === 'asc' ? '降順' : '昇順'}に並べ替え` : 'クリックで並べ替え';
      });
    }

    getAllCandidates() {
      return Array.from(this.candidatesByChannel.values()).flat();
    }

    getSelectedCandidates() {
      return this.getAllCandidates().filter((candidate) => candidate.selected);
    }

    renderAll() {
      this.renderTabs();
      this.renderTable(true);
      this.renderSortHeaders();
      this.updateTotals();
      this.updateButtons();
    }

    renderTabs() {
      if (!this.tabsEl) return;
      const channels = this.getSortedChannels();
      if (!channels.length) {
        this.activeChannel = '';
        this.tabsEl.textContent = '';
        return;
      }
      if (!this.activeChannel || !this.candidatesByChannel.has(this.activeChannel)) {
        this.activeChannel = channels[0];
      }
      this.tabsEl.textContent = '';
      for (const channel of channels) {
        const candidates = this.candidatesByChannel.get(channel) || [];
        const selected = candidates.filter((candidate) => candidate.selected).length;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'enrich-tab';
        button.classList.toggle('active', channel === this.activeChannel);
        button.textContent = `${channel}(${selected}/${candidates.length})`;
        button.addEventListener('click', () => {
          this.activeChannel = channel;
          this.renderTable(true);
          this.renderTabs();
        });
        this.tabsEl.appendChild(button);
      }
    }

    renderTable(reset) {
      if (!this.bodyEl) return;
      if (reset) {
        this.bodyEl.textContent = '';
        this.renderedRows = 0;
        if (this.tableWrap) this.tableWrap.scrollTop = 0;
      }
      this.renderMoreRows();
      setHidden(this.emptyEl, this.getActiveCandidates().length > 0);
    }

    renderMoreRows() {
      if (!this.bodyEl) return;
      const candidates = this.getActiveCandidates();
      if (this.renderedRows >= candidates.length) return;
      const fragment = document.createDocumentFragment();
      const end = Math.min(this.renderedRows + RENDER_CHUNK_SIZE, candidates.length);
      for (let i = this.renderedRows; i < end; i++) {
        fragment.appendChild(this.renderCandidateRow(candidates[i]));
      }
      this.bodyEl.appendChild(fragment);
      this.renderedRows = end;
    }

    renderCandidateRow(candidate) {
      const row = document.createElement('tr');
      const auto = candidate.sim == null || candidate.autoEligible === true;
      row.className = auto ? 'enrich-row-auto' : 'enrich-row-review';

      const selectCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!candidate.selected;
      checkbox.addEventListener('change', () => {
        candidate.selected = checkbox.checked;
        this.updateTotals();
        this.renderTabs();
        this.updateButtons();
      });
      selectCell.appendChild(checkbox);
      row.appendChild(selectCell);

      const titleCell = document.createElement('td');
      const link = document.createElement('a');
      link.className = 'title-link';
      link.href = `https://youtu.be/${encodeURIComponent(candidate.videoId)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = candidate.title || candidate.videoId;
      titleCell.appendChild(link);
      if (candidate.matchedTitle) {
        const matched = document.createElement('span');
        matched.className = 'muted';
        matched.textContent = `matched: ${candidate.matchedTitle}`;
        titleCell.appendChild(matched);
      }
      row.appendChild(titleCell);

      const valueCell = document.createElement('td');
      valueCell.className = 'value-cell';
      const roles = roleEntries(candidate);
      for (const role of roles) {
        const line = document.createElement('div');
        line.textContent = `${role.label}: ${role.value}`;
        valueCell.appendChild(line);
      }
      row.appendChild(valueCell);

      const roleCell = document.createElement('td');
      roleCell.textContent = roles.map((role) => role.label).join('/');
      row.appendChild(roleCell);

      const sourceCell = document.createElement('td');
      sourceCell.textContent = candidate.sourceDetail
        ? `${candidate.source} (${candidate.sourceDetail})`
        : candidate.source;
      row.appendChild(sourceCell);

      const simCell = document.createElement('td');
      simCell.textContent = candidate.sim == null ? '-' : candidate.sim.toFixed(3);
      row.appendChild(simCell);

      return row;
    }

    updateTotals() {
      const all = this.getAllCandidates();
      const selected = all.filter((candidate) => candidate.selected);
      if (this.totalEl) this.totalEl.textContent = `確定予定 ${selected.length}件 / 候補 ${all.length}件`;
    }

    selectedPlan() {
      return this.getSelectedCandidates().map((candidate) => ({
        videoId: candidate.videoId,
        title: candidate.title,
        channel: candidate.channel,
        composer: candidate.composer || '',
        lyricist: candidate.lyricist || '',
        arranger: candidate.arranger || '',
        source: candidate.source,
        creditsSource: sourceToCreditsSource(candidate.source),
        sim: candidate.sim,
        matchedTitle: candidate.matchedTitle || '',
      }));
    }

    downloadPlan() {
      const plan = this.selectedPlan();
      if (!plan.length) return;
      const payload = {
        exportedAt: new Date().toISOString(),
        appVersion: chrome.runtime.getManifest().version,
        count: plan.length,
        rows: plan,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `yt-enrich-credits-plan-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async fetchFreshRecords() {
      const data = await sendRuntimeMessage({ type: 'EXPORT_DATA', source: 'enrich-credits' });
      if (data && data.__error) throw new Error(data.message || 'EXPORT_DATA failed');
      return unwrapWatchedRecords(data);
    }

    async updateCredits(candidate, freshRecord) {
      const credits = {};
      for (const field of ['composer', 'lyricist', 'arranger']) {
        if (candidate[field] && isBlank(freshRecord[field])) credits[field] = candidate[field];
      }
      if (!Object.keys(credits).length) return false;
      const response = await sendRuntimeMessage({
        type: 'DB_RPC',
        op: 'UPDATE_CREDITS',
        videoId: candidate.videoId,
        credits,
        creditsSource: sourceToCreditsSource(candidate.source),
        // force:false — honour the dialog's "only blank fields" promise and let
        // db.js re-check emptiness at write time, closing the stale-snapshot gap
        // where two same-video candidates could race on one blank role.
        force: false,
      });
      if (!response || !response.success) {
        throw new Error((response && response.error) || 'UPDATE_CREDITS failed');
      }
      return !!response.result;
    }

    async commitSelected() {
      if (this.committing || this.generating) return;
      const selected = this.getSelectedCandidates();
      if (!selected.length) return;
      if (!confirm(`${selected.length}件の動画にcomposer/lyricist/arrangerを書き込みます。既存値が空のフィールドのみ上書きされます。続行しますか？`)) {
        return;
      }

      this.committing = true;
      this.updateButtons();
      this.setMessage('書き戻し中です。');
      const beginOk = !this.env.beginMaintenance || this.env.beginMaintenance('書き戻し中…', false);
      if (!beginOk) {
        this.committing = false;
        this.setMessage('他のメンテナンス処理が実行中です。', 'error');
        this.updateButtons();
        return;
      }
      try {
        const fresh = await this.fetchFreshRecords();
        const byId = new Map(fresh.map((record) => [record.videoId, record]));
        let updated = 0;
        let skipped = 0;
        for (let i = 0; i < selected.length; i++) {
          const candidate = selected[i];
          const freshRecord = byId.get(candidate.videoId);
          if (!freshRecord) {
            skipped++;
            continue;
          }
          const didUpdate = await this.updateCredits(candidate, freshRecord);
          if (didUpdate) updated++;
          else skipped++;
          this.updateProgress(`書き戻し ${i + 1}/${selected.length}`, (i + 1) / selected.length);
        }
        this.setMessage(`${updated}件を更新しました。スキップ ${skipped}件。`, 'success');
        if (this.env.notify) this.env.notify(`${updated}件を更新しました`);
        if (this.env.reloadData) setTimeout(() => this.env.reloadData(), 300);
        setTimeout(() => {
          this.resetSession();
          this.close();
        }, 500);
      } catch (error) {
        this.setMessage(`書き戻しに失敗しました: ${error.message}`, 'error');
      } finally {
        this.committing = false;
        if (beginOk && this.env.endMaintenance) this.env.endMaintenance();
        this.updateButtons();
      }
    }
  }

  window.EnrichCredits = {
    create: (env) => new EnrichCreditsController(env),
  };

  window.EnrichCreditsTestHooks = {
    normalizeTitle,
    sequenceRatio,
    similarity,
    bestMatch,
    isBlank,
    isUnassignedCreditRecord,
    CREDIT_ROLES,
    getMissingCreditRoles,
    CREDIT_ROLE_LABELS,
    CREDIT_ROLE_SEARCH_LABELS,
    CREDIT_SOURCE_LABELS,
    buildManualSearchQuery,
    getManualReviewRows,
    validateManualCreditInput,
    manualRecordMatchesSearch,
    needsCreditEnrichment,
    getEnrichmentPreCount,
    getLimitedVideoCount,
    ENRICH_REQUESTS_PER_VIDEO_MIN,
    ENRICH_REQUESTS_PER_VIDEO_MAX,
    estimateEnrichmentMinutes,
    buildEnrichmentConfirmText,
    limitEnrichmentGroups,
    coveredNeededRoles,
    limitCandidateToRoles,
    waterfallAccept,
    createRuleCandidate,
    candidateFromSong,
    sourceToCreditsSource,
  };
}());
