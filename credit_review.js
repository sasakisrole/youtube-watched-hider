// Credit Review Center for the history page.
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

  function adoptionValue(item) {
    var candidates = uniqueCandidateValues(item && item.candidates);
    if (candidates.length === 1) return candidates[0];
    return text(item && item.value);
  }

  function createActionButton(label, action, item, disabled) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sort-btn credit-review-action';
    button.dataset.creditReviewAction = action;
    button.dataset.videoId = item.videoId;
    button.dataset.role = item.role;
    button.textContent = label;
    button.setAttribute('aria-label', text(ROLE_LABELS[item.role], item.role) + 'を' + label);
    button.disabled = !!disabled;
    return button;
  }

  function createReviewItem(item, currentValue, options) {
    options = options || {};
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

    var message = options.message;
    if (item.state === 'conflict') {
      var conflict = document.createElement('p');
      conflict.className = 'credit-review-message error';
      conflict.textContent = '値が食い違っています。内容を確認してください。';
      card.appendChild(conflict);
    }
    var canAdopt = (item.state === 'auto_candidate' || item.state === 'needs_review')
      && !!adoptionValue(item);
    var canUndo = !!options.canUndo;
    if (canAdopt || canUndo) {
      var actions = document.createElement('div');
      actions.className = 'credit-review-actions';
      if (canAdopt) actions.appendChild(createActionButton('採用', 'adopt', item, options.busy));
      if (canUndo) actions.appendChild(createActionButton('元に戻す', 'undo', item, options.busy));
      card.appendChild(actions);
    }
    if (message && message.text) {
      var status = document.createElement('p');
      status.className = 'credit-review-message' + (message.tone ? ' ' + message.tone : '');
      status.setAttribute('role', 'status');
      status.textContent = message.text;
      card.appendChild(status);
    }
    return card;
  }

  function CreditReviewController(env) {
    this.env = env || {};
    this.modal = document.getElementById('creditReviewModal');
    this.openButton = document.getElementById('creditReviewOpen');
    this.closeButton = document.getElementById('creditReviewClose');
    this.filters = document.getElementById('creditReviewFilters');
    this.summary = document.getElementById('creditReviewSummary');
    this.feedback = document.getElementById('creditReviewFeedback');
    this.list = document.getElementById('creditReviewList');
    this.empty = document.getElementById('creditReviewEmpty');
    this.filterState = 'all';
    this.reviewList = null;
    this.recordsByVideoId = new Map();
    this.busy = new Set();
    this.messages = new Map();
    this.undoActions = new Map();
    this.lastUndoKey = '';
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
    function handleAction(event) {
      var button = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-credit-review-action]') : event.target;
      if (!button || !button.dataset) return;
      if (button.dataset.creditReviewAction === 'adopt') {
        self.adopt(button.dataset.videoId, button.dataset.role);
      } else if (button.dataset.creditReviewAction === 'undo') {
        self.undo(button.dataset.videoId, button.dataset.role);
      }
    }
    if (this.list) this.list.addEventListener('click', handleAction);
    if (this.feedback) this.feedback.addEventListener('click', handleAction);
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

  CreditReviewController.prototype.roleKey = function (videoId, role) {
    return String(videoId) + ':' + String(role);
  };

  CreditReviewController.prototype.findItem = function (videoId, role) {
    if (!this.reviewList) return null;
    var found = null;
    this.reviewList.groups.some(function (group) {
      found = group.items.find(function (item) {
        return item.videoId === String(videoId) && item.role === role;
      }) || null;
      return !!found;
    });
    return found;
  };

  CreditReviewController.prototype.refreshReviewList = function () {
    var records = this.getRecords();
    if (!Array.isArray(records)) records = [];
    this.recordsByVideoId = new Map(records.map(function (record) {
      return [(record && record.videoId != null) ? String(record.videoId) : '', record || {}];
    }));
    this.reviewList = root.CreditTarget.getCreditReviewList(
      records, this.getMaterials(), this.getLimit());
    this.updateCounts();
    this.render();
  };

  CreditReviewController.prototype.sendMutation = function (payload) {
    if (typeof this.env.saveCreditRole !== 'function') {
      return Promise.reject(new Error('保存機能を利用できません。'));
    }
    return Promise.resolve(this.env.saveCreditRole(payload));
  };

  CreditReviewController.prototype.applySavedState = function (record, role, post, restoreRoleSource, hasRestore) {
    if (!record || !post) return;
    record[role] = post.value;
    var sources = record.creditRoleSources && typeof record.creditRoleSources === 'object'
      && !Array.isArray(record.creditRoleSources) ? Object.assign({}, record.creditRoleSources) : {};
    if (hasRestore) {
      if (restoreRoleSource === null) delete sources[role];
      else sources[role] = restoreRoleSource;
    } else if (post.source === 'manual') {
      sources[role] = 'manual';
    }
    if (Object.keys(sources).length) record.creditRoleSources = sources;
    else delete record.creditRoleSources;
  };

  CreditReviewController.prototype.adopt = async function (videoId, role) {
    var key = this.roleKey(videoId, role);
    if (this.busy.has(key)) return { error: 'busy' };
    var item = this.findItem(videoId, role);
    var record = this.recordsByVideoId.get(String(videoId));
    var value = adoptionValue(item);
    if (!item || !record || (item.state !== 'auto_candidate' && item.state !== 'needs_review') || !value) {
      return { error: 'not_adoptable' };
    }
    var expectedSource = root.CreditTarget.effectiveRoleSource(record, role);
    this.busy.add(key);
    this.messages.set(key, { text: '保存しています。', tone: '' });
    this.render();
    try {
      var result = await this.sendMutation({
        videoId: String(videoId), role: role, value: value,
        expectedCurrent: record[role], expectedSource: expectedSource,
        adoptCandidate: true,
      });
      if (!result || result.updated !== true) {
        this.messages.set(key, { text: '採用の保存に失敗しました。データは変更されていません。', tone: 'error' });
        return result || { error: 'save_failed' };
      }
      this.applySavedState(record, role, result.post, null, false);
      this.undoActions.set(key, { previous: result.previous, post: result.post });
      this.lastUndoKey = key;
      this.messages.set(key, { text: '採用しました。', tone: 'success' });
      this.refreshReviewList();
      return result;
    } catch (_error) {
      this.messages.set(key, { text: '採用の保存に失敗しました。データは変更されていません。', tone: 'error' });
      return { error: 'save_failed' };
    } finally {
      this.busy.delete(key);
      this.render();
    }
  };

  CreditReviewController.prototype.undo = async function (videoId, role) {
    var key = this.roleKey(videoId, role);
    var action = this.undoActions.get(key);
    var record = this.recordsByVideoId.get(String(videoId));
    if (!action || !record || this.busy.has(key)) return { error: 'no_undo' };
    var restoreRoleSource = action.previous.sourcePresent ? action.previous.source : null;
    this.busy.add(key);
    this.messages.set(key, { text: '元に戻しています。', tone: '' });
    this.render();
    try {
      var result = await this.sendMutation({
        videoId: String(videoId), role: role, value: action.previous.value,
        expectedCurrent: action.post.value, expectedSource: action.post.source,
        restoreRoleSource: restoreRoleSource,
      });
      if (!result || result.updated !== true) {
        this.messages.set(key, { text: '取り消しの保存に失敗しました。採用済みの状態は変わっていません。', tone: 'error' });
        return result || { error: 'save_failed' };
      }
      this.applySavedState(record, role, result.post, restoreRoleSource, true);
      this.undoActions.delete(key);
      if (this.lastUndoKey === key) this.lastUndoKey = '';
      this.messages.set(key, { text: '元に戻しました。', tone: 'success' });
      this.refreshReviewList();
      return result;
    } catch (_error) {
      this.messages.set(key, { text: '取り消しの保存に失敗しました。採用済みの状態は変わっていません。', tone: 'error' });
      return { error: 'save_failed' };
    } finally {
      this.busy.delete(key);
      this.render();
    }
  };

  CreditReviewController.prototype.open = function () {
    if (!this.modal || !root.CreditTarget || typeof root.CreditTarget.getCreditReviewList !== 'function') return;
    this.previousFocus = document.activeElement || null;
    this.refreshReviewList();
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
    var self = this;
    items.forEach(function (item) {
      var record = recordsByVideoId.get(item.videoId) || {};
      var key = self.roleKey(item.videoId, item.role);
      fragment.appendChild(createReviewItem(item, record[item.role], {
        busy: self.busy.has(key),
        canUndo: self.undoActions.has(key),
        message: self.messages.get(key),
      }));
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
    if (this.feedback) {
      this.feedback.textContent = '';
      var latest = this.lastUndoKey && this.undoActions.get(this.lastUndoKey);
      if (latest) {
        var separator = this.lastUndoKey.lastIndexOf(':');
        var videoId = this.lastUndoKey.slice(0, separator);
        var role = this.lastUndoKey.slice(separator + 1);
        var notice = document.createElement('span');
        notice.textContent = text(ROLE_LABELS[role], role) + 'を採用しました。';
        this.feedback.append(notice, createActionButton('元に戻す', 'undo', {
          videoId: videoId, role: role,
        }, this.busy.has(this.lastUndoKey)));
        this.feedback.hidden = false;
      } else {
        this.feedback.hidden = true;
      }
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
