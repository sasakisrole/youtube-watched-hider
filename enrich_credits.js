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

  // Which of the still-missing roles does this candidate actually fill? Drives
  // (a) whether a candidate is worth adding and (b) which roles to drop from the
  // remaining set so the next source only chases what is still blank.
  function coveredNeededRoles(candidate, missing) {
    const has = missing instanceof Set ? (r) => missing.has(r) : (r) => (missing || []).includes(r);
    return CREDIT_ROLES.filter((role) => has(role) && candidate && !isBlank(candidate[role]));
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

      this.rules = null;
      this.candidatesByChannel = new Map();
      this.activeChannel = '';
      this.sortKey = 'default';
      this.sortDir = 'asc';
      this.renderedRows = 0;
      this.generating = false;
      this.committing = false;
      this.abortRequested = false;
      this.errors = [];
      this.fetchCache = {
        mb: new Map(),
      };

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
      this.modal.hidden = false;
      this.modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('enrich-modal-open');
      this.renderAll();
    }

    close() {
      if (!this.modal || this.committing) return;
      this.modal.hidden = true;
      this.modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('enrich-modal-open');
    }

    abort() {
      if (!this.generating) return;
      this.abortRequested = true;
      this.setMessage('中止要求を受け付けました。現在の取得が終わり次第停止します。');
      this.updateButtons();
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

    updateProgress(text, ratio) {
      if (this.progressEl) this.progressEl.textContent = text;
      if (this.progressBar) this.progressBar.style.width = `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`;
    }

    updateButtons() {
      const hasCandidates = this.getAllCandidates().length > 0;
      const selected = this.getSelectedCandidates().length;
      if (this.generateBtn) this.generateBtn.disabled = this.generating || this.committing;
      if (this.abortBtn) this.abortBtn.disabled = !this.generating || this.abortRequested;
      if (this.commitBtn) this.commitBtn.disabled = this.generating || this.committing || selected === 0;
      if (this.downloadBtn) this.downloadBtn.disabled = this.generating || this.committing || selected === 0;
      if (this.cancelBtn) this.cancelBtn.disabled = this.committing;
      if (this.closeBtn) this.closeBtn.disabled = this.committing;
      if (!hasCandidates && !this.generating && this.commitBtn) this.commitBtn.disabled = true;
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
      if (this.generating || this.committing) return;
      const records = this.getRecords();
      const groups = this.groupUnassigned(records);
      if (!groups.size) {
        this.resetSession();
        this.setMessage('未割当 creditsRaw の対象行がありません。', 'success');
        return;
      }

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
    needsCreditEnrichment,
    coveredNeededRoles,
    limitCandidateToRoles,
    waterfallAccept,
    createRuleCandidate,
    candidateFromSong,
    sourceToCreditsSource,
  };
}());
