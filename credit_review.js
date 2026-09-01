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

  function candidateSignature(item) {
    var values = uniqueCandidateValues(item && item.candidates);
    var fallback = text(item && item.value);
    if (!values.length && fallback) values.push(fallback);
    return JSON.stringify(values.sort());
  }

  function rejectedSignature(record, role) {
    var rejections = record && record.creditReviewRejections;
    return rejections && typeof rejections === 'object' && !Array.isArray(rejections)
      && typeof rejections[role] === 'string' ? rejections[role] : '';
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
      var choices = document.createElement('fieldset');
      choices.className = 'credit-review-conflict-choices';
      var legend = document.createElement('legend');
      legend.textContent = '確定する候補を選択';
      choices.appendChild(legend);
      candidates.forEach(function (value, index) {
        var label = document.createElement('label');
        var input = document.createElement('input');
        input.type = 'radio';
        input.name = 'credit-review-choice-' + item.videoId + '-' + item.role;
        input.value = value;
        input.dataset.creditReviewChoice = 'candidate';
        input.dataset.videoId = item.videoId;
        input.dataset.role = item.role;
        input.checked = options.hasConflictSelection && options.conflictSelection === value;
        input.disabled = !!options.busy;
        var choiceText = document.createElement('span');
        choiceText.textContent = value;
        label.append(input, choiceText);
        choices.appendChild(label);
      });
      var noneLabel = document.createElement('label');
      var noneInput = document.createElement('input');
      noneInput.type = 'radio';
      noneInput.name = 'credit-review-choice-' + item.videoId + '-' + item.role;
      noneInput.value = '';
      noneInput.dataset.creditReviewChoice = 'none';
      noneInput.dataset.videoId = item.videoId;
      noneInput.dataset.role = item.role;
      noneInput.checked = options.hasConflictSelection && options.conflictSelection === '';
      noneInput.disabled = !!options.busy;
      var noneText = document.createElement('span');
      noneText.textContent = 'どれも選ばない';
      noneLabel.append(noneInput, noneText);
      choices.appendChild(noneLabel);
      card.appendChild(choices);
    }
    var canAdopt = (item.state === 'auto_candidate' || item.state === 'needs_review')
      && !!adoptionValue(item);
    var canReject = item.state === 'auto_candidate' || item.state === 'needs_review';
    var canResolve = item.state === 'conflict';
    var canUndo = !!options.canUndo;
    if (canAdopt || canReject || canResolve || canUndo) {
      var actions = document.createElement('div');
      actions.className = 'credit-review-actions';
      if (canAdopt) actions.appendChild(createActionButton('採用', 'adopt', item, options.busy));
      if (canReject) actions.appendChild(createActionButton('却下', 'reject', item, options.busy));
      if (canResolve) actions.appendChild(createActionButton('選択を確定', 'resolve', item,
        options.busy || !options.hasConflictSelection));
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
    this.conflictSelections = new Map();
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
      } else if (button.dataset.creditReviewAction === 'reject') {
        self.reject(button.dataset.videoId, button.dataset.role);
      } else if (button.dataset.creditReviewAction === 'resolve') {
        self.resolveConflict(button.dataset.videoId, button.dataset.role);
      } else if (button.dataset.creditReviewAction === 'undo') {
        self.undo(button.dataset.videoId, button.dataset.role);
      }
    }
    if (this.list) this.list.addEventListener('click', handleAction);
    if (this.list) this.list.addEventListener('change', function (event) {
      var input = event.target;
      if (input && input.dataset && input.dataset.creditReviewChoice) {
        self.selectConflict(input.dataset.videoId, input.dataset.role, input.value);
      }
    });
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
    var rawList = root.CreditTarget.getCreditReviewList(records, this.getMaterials());
    var recordsByVideoId = this.recordsByVideoId;
    var allItems = rawList.groups.reduce(function (items, group) { return items.concat(group.items); }, [])
      .filter(function (item) {
        if (item.state !== 'auto_candidate' && item.state !== 'needs_review') return true;
        var record = recordsByVideoId.get(item.videoId);
        return rejectedSignature(record, item.role) !== candidateSignature(item);
      });
    var limit = this.getLimit();
    var counts = {};
    Object.keys(STATE_LABELS).forEach(function (state) { counts[state] = 0; });
    allItems.forEach(function (item) { counts[item.state]++; });
    // 上限は状態ごとに掛ける。一覧全体を先に切ると、並び順で先に来る状態が枠を
    // 使い切り、他の状態はタブに件数が出ているのに中身が空になる（実データでは
    // 要確認が27,215件あり、それ以外のタブが全滅した・2026-09-01）。
    var groups = Object.keys(STATE_LABELS).map(function (state) {
      var items = allItems.filter(function (item) { return item.state === state; }).slice(0, limit);
      return { state: state, totalCount: counts[state], displayedCount: items.length, items: items };
    });
    var displayedCount = groups.reduce(function (sum, group) { return sum + group.displayedCount; }, 0);
    this.reviewList = {
      totalCount: allItems.length,
      displayedCount: displayedCount,
      omittedCount: allItems.length - displayedCount,
      truncated: displayedCount < allItems.length,
      limit: limit,
      counts: counts,
      groups: groups,
    };
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

  CreditReviewController.prototype.applySavedRejection = function (record, role, signature) {
    if (!record) return;
    var rejections = record.creditReviewRejections && typeof record.creditReviewRejections === 'object'
      && !Array.isArray(record.creditReviewRejections)
      ? Object.assign({}, record.creditReviewRejections) : {};
    if (signature) rejections[role] = signature;
    else delete rejections[role];
    if (Object.keys(rejections).length) record.creditReviewRejections = rejections;
    else delete record.creditReviewRejections;
  };

  CreditReviewController.prototype.commitCandidate = async function (videoId, role, value, label) {
    var key = this.roleKey(videoId, role);
    var record = this.recordsByVideoId.get(String(videoId));
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
        this.messages.set(key, { text: label + 'の保存に失敗しました。データは変更されていません。', tone: 'error' });
        return result || { error: 'save_failed' };
      }
      this.applySavedState(record, role, result.post, null, false);
      this.undoActions.set(key, { kind: 'adopt', previous: result.previous, post: result.post });
      this.lastUndoKey = key;
      this.conflictSelections.delete(key);
      this.messages.set(key, { text: label + 'しました。', tone: 'success' });
      this.refreshReviewList();
      return result;
    } catch (_error) {
      this.messages.set(key, { text: label + 'の保存に失敗しました。データは変更されていません。', tone: 'error' });
      return { error: 'save_failed' };
    } finally {
      this.busy.delete(key);
      this.render();
    }
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
    return this.commitCandidate(videoId, role, value, '採用');
  };

  CreditReviewController.prototype.reject = async function (videoId, role) {
    var key = this.roleKey(videoId, role);
    if (this.busy.has(key)) return { error: 'busy' };
    var item = this.findItem(videoId, role);
    var record = this.recordsByVideoId.get(String(videoId));
    if (!item || !record || (item.state !== 'auto_candidate' && item.state !== 'needs_review')) {
      return { error: 'not_rejectable' };
    }
    var signature = candidateSignature(item);
    if (!signature || signature === '[]') return { error: 'not_rejectable' };
    this.busy.add(key);
    this.messages.set(key, { text: '却下を保存しています。', tone: '' });
    this.render();
    try {
      var result = await this.sendMutation({
        videoId: String(videoId), role: role,
        value: record[role], expectedCurrent: record[role],
        expectedSource: root.CreditTarget.effectiveRoleSource(record, role),
        rejectCandidate: signature,
      });
      if (!result || result.updated !== true) {
        this.messages.set(key, { text: '却下の保存に失敗しました。候補は表示されたままです。', tone: 'error' });
        return result || { error: 'save_failed' };
      }
      this.applySavedRejection(record, role, result.post && result.post.rejection);
      this.undoActions.set(key, { kind: 'reject', previous: result.previous, post: result.post });
      this.lastUndoKey = key;
      this.messages.set(key, { text: '却下しました。', tone: 'success' });
      this.refreshReviewList();
      return result;
    } catch (_error) {
      this.messages.set(key, { text: '却下の保存に失敗しました。候補は表示されたままです。', tone: 'error' });
      return { error: 'save_failed' };
    } finally {
      this.busy.delete(key);
      this.render();
    }
  };

  CreditReviewController.prototype.selectConflict = function (videoId, role, value) {
    var item = this.findItem(videoId, role);
    var values = uniqueCandidateValues(item && item.candidates);
    if (!item || item.state !== 'conflict' || (value !== '' && values.indexOf(value) === -1)) {
      return { error: 'invalid_selection' };
    }
    this.conflictSelections.set(this.roleKey(videoId, role), value);
    this.render();
    return { selected: true };
  };

  CreditReviewController.prototype.resolveConflict = async function (videoId, role) {
    var key = this.roleKey(videoId, role);
    if (this.busy.has(key)) return { error: 'busy' };
    var item = this.findItem(videoId, role);
    var record = this.recordsByVideoId.get(String(videoId));
    if (!item || !record || item.state !== 'conflict' || !this.conflictSelections.has(key)) {
      return { error: 'not_resolvable' };
    }
    var value = this.conflictSelections.get(key);
    if (value === '') {
      this.messages.set(key, { text: '変更せず、そのまま残しました。', tone: '' });
      this.render();
      return { unchanged: true };
    }
    if (uniqueCandidateValues(item.candidates).indexOf(value) === -1) return { error: 'invalid_selection' };
    return this.commitCandidate(videoId, role, value, '確定');
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
      var payload = {
        videoId: String(videoId), role: role, value: action.previous.value,
        expectedCurrent: action.post.value, expectedSource: action.post.source,
      };
      if (action.kind === 'reject') {
        payload.restoreCandidateRejection = action.previous.rejectionPresent
          ? action.previous.rejection : null;
      } else {
        payload.restoreRoleSource = restoreRoleSource;
      }
      var result = await this.sendMutation(payload);
      if (!result || result.updated !== true) {
        this.messages.set(key, { text: '取り消しの保存に失敗しました。現在の状態は変わっていません。', tone: 'error' });
        return result || { error: 'save_failed' };
      }
      if (action.kind === 'reject') {
        this.applySavedRejection(record, role, result.post && result.post.rejection);
      } else {
        this.applySavedState(record, role, result.post, restoreRoleSource, true);
      }
      this.undoActions.delete(key);
      if (this.lastUndoKey === key) this.lastUndoKey = '';
      this.messages.set(key, { text: '元に戻しました。', tone: 'success' });
      this.refreshReviewList();
      return result;
    } catch (_error) {
      this.messages.set(key, { text: '取り消しの保存に失敗しました。現在の状態は変わっていません。', tone: 'error' });
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
    if (this.filterState !== 'all') {
      var group = this.reviewList.groups.filter(function (candidate) {
        return candidate.state === this.filterState;
      }, this)[0];
      return group ? group.items : [];
    }
    // すべて表示は全状態を混ぜるので、ここで一度だけ上限を掛け直す
    // （状態ごとの上限をそのまま足すと、状態数の分だけ描画量が増える）。
    return this.reviewList.groups
      .reduce(function (items, group) { return items.concat(group.items); }, [])
      .slice(0, this.reviewList.limit);
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
        hasConflictSelection: self.conflictSelections.has(key),
        conflictSelection: self.conflictSelections.get(key),
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
        notice.textContent = text(ROLE_LABELS[role], role)
          + (latest.kind === 'reject' ? 'を却下しました。' : 'を採用しました。');
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
