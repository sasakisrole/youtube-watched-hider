// Read-only Credit Review Center for the history page.
// Loaded as a plain script and exposed for the synthetic DOM tests.
(function (root) {
  'use strict';

  var DEFAULT_LIMIT = 300;
  var STATE_LABELS = Object.freeze({
    conflict: '競合',
    needs_review: '要確認',
    auto_candidate: '自動候補',
    unresolved: '未解決',
    verified: '確認済み',
  });
  var ROLE_LABELS = Object.freeze({ composer: '作曲', lyricist: '作詞', arranger: '編曲' });

  function text(value, fallback) {
    var normalized = value == null ? '' : String(value).trim();
    return normalized || fallback || '';
  }

  function uniqueCandidateValues(candidates) {
    var seen = new Set();
    return (Array.isArray(candidates) ? candidates : []).reduce(function (values, candidate) {
      var value = text(candidate && candidate.value);
      if (value && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
      return values;
    }, []);
  }

  function appendValueRow(list, label, value) {
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    detail.textContent = value;
    list.append(term, detail);
  }

  function createReviewItem(item, currentValue) {
    var card = document.createElement('article');
    card.className = 'credit-review-item';
    card.dataset.creditReviewState = item.state;
    card.dataset.videoId = item.videoId;

    var header = document.createElement('div');
    header.className = 'credit-review-item-head';
    var title = document.createElement('div');
    title.className = 'credit-review-title';
    title.textContent = text(item.title, item.videoId || 'タイトル不明');
    var channel = document.createElement('div');
    channel.className = 'credit-review-channel';
    channel.textContent = text(item.channel, 'チャンネル不明');
    var badge = document.createElement('span');
    badge.className = 'credit-review-badge';
    badge.textContent = text(ROLE_LABELS[item.role], item.role) + ' / ' + text(STATE_LABELS[item.state], item.state);
    header.append(title, channel, badge);

    var values = document.createElement('dl');
    values.className = 'credit-review-values';
    appendValueRow(values, '現在値', text(currentValue, '未設定'));
    var candidates = uniqueCandidateValues(item.candidates);
    appendValueRow(values, '候補', candidates.length ? candidates.join(' / ') : 'なし');
    card.append(header, values);
    return card;
  }

  function CreditReviewController(env) {
    this.env = env || {};
    this.modal = document.getElementById('creditReviewModal');
    this.openButton = document.getElementById('creditReviewOpen');
    this.closeButton = document.getElementById('creditReviewClose');
    this.filters = document.getElementById('creditReviewFilters');
    this.summary = document.getElementById('creditReviewSummary');
    this.list = document.getElementById('creditReviewList');
    this.empty = document.getElementById('creditReviewEmpty');
    this.filterState = 'all';
    this.reviewList = null;
    this.recordsByVideoId = new Map();
    this.previousFocus = null;
    this.bind();
  }

  CreditReviewController.prototype.bind = function () {
    var self = this;
    if (!this.modal) return;
    if (this.openButton) this.openButton.addEventListener('click', function () { self.open(); });
    if (this.closeButton) this.closeButton.addEventListener('click', function () { self.close(); });
    if (this.filters) this.filters.addEventListener('click', function (event) {
      var button = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-credit-review-state]') : event.target;
      var state = button && button.dataset ? button.dataset.creditReviewState : '';
      if (state === 'all' || Object.prototype.hasOwnProperty.call(STATE_LABELS, state)) self.setFilter(state);
    });
    this.modal.addEventListener('click', function (event) {
      if (event.target === self.modal) self.close();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && self.modal && !self.modal.hidden) self.close();
    });
  };

  CreditReviewController.prototype.getRecords = function () {
    return typeof this.env.getRecords === 'function' ? (this.env.getRecords() || []) : [];
  };

  CreditReviewController.prototype.getMaterials = function () {
    return typeof this.env.getMaterials === 'function' ? (this.env.getMaterials() || {}) : {};
  };

  CreditReviewController.prototype.getLimit = function () {
    return Number.isFinite(this.env.limit) ? Math.max(0, Math.floor(this.env.limit)) : DEFAULT_LIMIT;
  };

  CreditReviewController.prototype.open = function () {
    if (!this.modal || !root.CreditTarget || typeof root.CreditTarget.getCreditReviewList !== 'function') return;
    this.previousFocus = document.activeElement || null;
    var records = this.getRecords();
    if (!Array.isArray(records)) records = [];
    this.recordsByVideoId = new Map(records.map(function (record) {
      return [(record && record.videoId != null) ? String(record.videoId) : '', record || {}];
    }));
    this.reviewList = root.CreditTarget.getCreditReviewList(
      records, this.getMaterials(), this.getLimit());
    this.updateCounts();
    this.render();
    this.modal.hidden = false;
    this.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('credit-review-modal-open');
    if (this.closeButton && typeof this.closeButton.focus === 'function') this.closeButton.focus();
  };

  CreditReviewController.prototype.close = function () {
    if (!this.modal || this.modal.hidden) return;
    this.modal.hidden = true;
    this.modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('credit-review-modal-open');
    if (this.previousFocus && typeof this.previousFocus.focus === 'function') this.previousFocus.focus();
    this.previousFocus = null;
  };

  CreditReviewController.prototype.setFilter = function (state) {
    if (state !== 'all' && !Object.prototype.hasOwnProperty.call(STATE_LABELS, state)) return;
    this.filterState = state;
    this.updateFilterButtons();
    this.render();
  };

  CreditReviewController.prototype.updateFilterButtons = function () {
    if (!this.filters) return;
    var self = this;
    this.filters.querySelectorAll('[data-credit-review-state]').forEach(function (button) {
      var active = button.dataset.creditReviewState === self.filterState;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  };

  CreditReviewController.prototype.updateCounts = function () {
    if (!this.filters || !this.reviewList) return;
    var counts = Object.assign({ all: this.reviewList.totalCount }, this.reviewList.counts);
    this.filters.querySelectorAll('[data-credit-review-count]').forEach(function (node) {
      node.textContent = String(counts[node.dataset.creditReviewCount] || 0);
    });
    this.updateFilterButtons();
  };

  CreditReviewController.prototype.visibleItems = function () {
    if (!this.reviewList) return [];
    var groups = this.filterState === 'all'
      ? this.reviewList.groups
      : this.reviewList.groups.filter(function (group) { return group.state === this.filterState; }, this);
    return groups.reduce(function (items, group) { return items.concat(group.items); }, []);
  };

  CreditReviewController.prototype.render = function () {
    if (!this.list || !this.empty || !this.reviewList) return;
    var items = this.visibleItems();
    this.list.textContent = '';
    var fragment = document.createDocumentFragment();
    var recordsByVideoId = this.recordsByVideoId;
    items.forEach(function (item) {
      var record = recordsByVideoId.get(item.videoId) || {};
      fragment.appendChild(createReviewItem(item, record[item.role]));
    });
    this.list.appendChild(fragment);
    this.list.hidden = items.length === 0;
    this.empty.hidden = items.length !== 0;
    if (!items.length) {
      var omittedByLimit = this.filterState !== 'all' && this.reviewList.truncated
        && this.reviewList.counts[this.filterState] > 0;
      this.empty.textContent = omittedByLimit ? '表示上限内に該当なし' : '該当なし';
    }
    if (this.summary) {
      var globalSummary = this.reviewList.truncated
        ? this.reviewList.totalCount + '件中' + this.reviewList.displayedCount + '件を表示'
        : '全' + this.reviewList.totalCount + '件';
      var filterSummary = this.filterState === 'all' ? '' : ' / ' + STATE_LABELS[this.filterState] + ' ' + items.length + '件';
      this.summary.textContent = globalSummary + filterSummary;
    }
  };

  var api = {
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    STATE_LABELS: STATE_LABELS,
    ROLE_LABELS: ROLE_LABELS,
    create: function (env) { return new CreditReviewController(env); },
  };
  if (root) root.CreditReview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
