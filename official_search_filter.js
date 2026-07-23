(() => {
  'use strict';

  const core = globalThis.YWHOfficialSearchFilterCore;

  if (
    !core ||
    typeof core.classifyChannel !== 'function' ||
    typeof core.shouldShowCategory !== 'function' ||
    typeof core.normalizeChannelPath !== 'function'
  ) {
    return;
  }

  const {
    CATEGORY,
    MODE,
    classifyChannel,
    normalizeChannelPath,
    shouldShowCategory,
  } = core;

  const PANEL_ID = 'ywh-osf-panel';
  const HIDDEN_CLASS = 'ywh-osf-hidden';
  const STORAGE_KEY = 'officialSearchFilter';
  const SETTINGS_SCHEMA_VERSION = 1;
  const CARD_SELECTOR =
    'ytd-video-renderer, yt-lockup-view-model';
  const CHANNEL_SELECTOR = [
    'ytd-channel-name a[href]',
    '#channel-name a[href]',
    '.yt-lockup-metadata-view-model__metadata a[href]',
    'a[href^="/channel/"]',
    'a[href^="/@"]',
    'a[href^="/c/"]',
    'a[href^="/user/"]',
  ].join(', ');

  const countLabels = Object.freeze({
    [CATEGORY.OFFICIAL]: '登録済み公式ソース',
    [CATEGORY.CREDIT_RELATED]: 'クレジット関連',
    [CATEGORY.OTHER_TOPIC]: '他のTopic',
    [CATEGORY.OTHER]: 'その他',
    [CATEGORY.PENDING]: '判定待ち',
  });

  if (globalThis._ywhOfficialSearchFilter) {
    try {
      globalThis._ywhOfficialSearchFilter.cleanup();
    } catch {
      // A stale instance must not prevent a safe re-injection.
    }
  }

  const state = {
    mode: MODE.ALL,
    settings: createDefaultSettings(),
    persistedMode: MODE.ALL,
    loadPromise: null,
    storageChangeGeneration: 0,
    saveQueue: Promise.resolve(),
    observer: null,
    scanTimer: null,
    disposed: false,
    counts: createEmptyCounts(),
    visibleCount: 0,
    pendingChannel: null,
  };

  function createDefaultSettings() {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activeProfileId: null,
      globalMode: MODE.ALL,
      profiles: {},
      queryBindings: {},
    };
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    const constructor = Object.prototype.hasOwnProperty.call(
      prototype,
      'constructor'
    )
      ? prototype.constructor
      : null;
    return (
      typeof constructor === 'function' &&
      constructor.name === 'Object'
    );
  }

  function isValidMode(mode) {
    return mode === MODE.ALL || mode === MODE.OFFICIAL || mode === MODE.DISCOVERY;
  }

  function sanitizeChannel(value) {
    if (!isPlainObject(value)) return null;

    const channelId = String(value.channelId ?? '').trim();
    const canonicalPath = normalizeChannelPath(value.canonicalPath);
    const displayName = String(value.displayName ?? '').trim();
    if (!channelId && !canonicalPath) return null;

    return {
      ...(channelId ? { channelId } : {}),
      ...(canonicalPath ? { canonicalPath } : {}),
      displayName,
      enabled: value.enabled !== false,
    };
  }

  function sanitizeProfiles(value) {
    if (!isPlainObject(value)) return {};

    const profiles = {};
    for (const profileValue of Object.values(value)) {
      if (!isPlainObject(profileValue)) continue;
      const id = String(profileValue.id ?? '').trim();
      if (!id || ['__proto__', 'constructor', 'prototype'].includes(id)) {
        continue;
      }
      const aliases = Array.isArray(profileValue.aliases)
        ? profileValue.aliases
          .filter((alias) => typeof alias === 'string')
          .map((alias) => alias.trim())
          .filter(Boolean)
        : [];
      const channels = [];
      const channelValues = Array.isArray(profileValue.channels)
        ? profileValue.channels.map(sanitizeChannel).filter(Boolean)
        : [];
      for (const channel of channelValues) {
        const duplicateIndex = duplicateChannelIndex(channels, channel);
        if (duplicateIndex >= 0) {
          channels[duplicateIndex] = {
            ...channels[duplicateIndex],
            ...channel,
          };
        } else {
          channels.push(channel);
        }
      }
      profiles[id] = {
        id,
        displayName: String(profileValue.displayName ?? '').trim(),
        aliases,
        channels,
      };
    }
    return profiles;
  }

  function sanitizeSettings(value) {
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== SETTINGS_SCHEMA_VERSION
    ) {
      return createDefaultSettings();
    }
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activeProfileId:
        value.activeProfileId === null ||
        typeof value.activeProfileId === 'string'
          ? value.activeProfileId
          : null,
      globalMode: isValidMode(value.globalMode)
        ? value.globalMode
        : MODE.ALL,
      profiles: sanitizeProfiles(value.profiles),
      queryBindings: isPlainObject(value.queryBindings)
        ? { ...value.queryBindings }
        : {},
    };
  }

  function hasStorageLocal() {
    return Boolean(
      globalThis.chrome?.storage?.local &&
      typeof globalThis.chrome.storage.local.get === 'function' &&
      typeof globalThis.chrome.storage.local.set === 'function'
    );
  }

  function getRuntimeLastError() {
    try {
      return globalThis.chrome?.runtime?.lastError || null;
    } catch {
      return null;
    }
  }

  function storageLocalGet() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        const lastError = getRuntimeLastError();
        if (lastError) reject(new Error(lastError.message || 'Storage read failed'));
        else resolve(result || {});
      };
      try {
        const pending = globalThis.chrome.storage.local.get(STORAGE_KEY, finish);
        if (pending?.then) {
          pending.then(finish, (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
  }

  function storageLocalSet(settings) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const lastError = getRuntimeLastError();
        if (lastError) reject(new Error(lastError.message || 'Storage write failed'));
        else resolve();
      };
      try {
        const pending = globalThis.chrome.storage.local.set(
          { [STORAGE_KEY]: settings },
          finish
        );
        if (pending?.then) {
          pending.then(finish, (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
  }

  function createEmptyCounts() {
    return {
      [CATEGORY.OFFICIAL]: 0,
      [CATEGORY.CREDIT_RELATED]: 0,
      [CATEGORY.OTHER_TOPIC]: 0,
      [CATEGORY.OTHER]: 0,
      [CATEGORY.PENDING]: 0,
    };
  }

  function isSearchPage() {
    return location.pathname === '/results';
  }

  function getSearchVideoCards() {
    if (!document?.querySelectorAll) return [];

    const candidates = [...document.querySelectorAll(CARD_SELECTOR)];
    const cards = [];

    for (const card of candidates) {
      if (card.querySelector?.('a[href*="/watch?v="]')) {
        cards.push(card);
      } else {
        // A reused/partially rendered non-video card must not stay hidden.
        card.classList.remove(HIDDEN_CLASS);
      }
    }

    return cards;
  }

  function getChannelIdentityFromCard(card) {
    const links = card.querySelectorAll?.(CHANNEL_SELECTOR) || [];

    for (const link of links) {
      const rawHref =
        link.getAttribute?.('href') ||
        link.href ||
        '';
      let url;

      try {
        url = new URL(rawHref, location.origin);
      } catch {
        continue;
      }

      const path = url.pathname.replace(/\/+$/, '');
      const isChannelPath =
        /^\/channel\/[^/]+$/i.test(path) ||
        /^\/@[^/]+$/i.test(path) ||
        /^\/c\/[^/]+$/i.test(path) ||
        /^\/user\/[^/]+$/i.test(path);

      if (!isChannelPath) continue;

      const idMatch = path.match(/^\/channel\/(UC[\w-]+)$/i);
      const displayName = String(
        link.textContent ||
        link.getAttribute?.('aria-label') ||
        link.getAttribute?.('title') ||
        ''
      ).trim();

      return {
        channelId: idMatch?.[1] || '',
        canonicalPath: path,
        displayName,
      };
    }

    return null;
  }

  function getActiveProfile() {
    const id = state.settings.activeProfileId;
    return typeof id === 'string'
      ? state.settings.profiles[id] || null
      : null;
  }

  function renderPanelState() {
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel) return;

    for (const [category, count] of Object.entries(state.counts)) {
      const target = panel.querySelector?.(
        `[data-count="${category}"]`
      );
      if (target) target.textContent = String(count);
    }

    const visible = panel.querySelector?.('[data-count-visible]');
    const total = panel.querySelector?.('[data-count-total]');
    if (visible) visible.textContent = String(state.visibleCount);
    if (total) {
      total.textContent = String(
        Object.values(state.counts)
          .reduce((sum, count) => sum + count, 0)
      );
    }

    for (const button of panel.querySelectorAll?.('[data-mode]') || []) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.mode === state.mode)
      );
    }
  }

  function scanSearchResults() {
    if (state.disposed || !isSearchPage()) return;

    const cards = getSearchVideoCards();
    const profile = getActiveProfile();
    const counts = createEmptyCounts();
    let visibleCount = 0;

    for (const card of cards) {
      const category = classifyChannel({
        channel: getChannelIdentityFromCard(card),
        profile,
        hasRelatedCredit: false,
      });
      const shouldShow = shouldShowCategory(category, state.mode);

      counts[category] = (counts[category] || 0) + 1;
      if (shouldShow) visibleCount += 1;
      card.classList.toggle(HIDDEN_CLASS, !shouldShow);
    }

    state.counts = counts;
    state.visibleCount = visibleCount;
    renderPanelState();
  }

  function applySettings(settings) {
    state.settings = settings;
    state.persistedMode = settings.globalMode;
    state.mode = settings.globalMode;
    initializePage();
    renderManagementState();
  }

  async function loadSettings() {
    const changeGeneration = state.storageChangeGeneration;
    let settings = createDefaultSettings();
    if (hasStorageLocal()) {
      try {
        const stored = await storageLocalGet();
        settings = sanitizeSettings(stored[STORAGE_KEY]);
      } catch {
        settings = createDefaultSettings();
      }
    }
    if (
      !state.disposed &&
      changeGeneration === state.storageChangeGeneration
    ) {
      applySettings(settings);
    }
  }

  async function saveMode(mode) {
    if (state.disposed || !isValidMode(mode)) return;
    if (!hasStorageLocal()) {
      state.settings = sanitizeSettings({ ...state.settings, globalMode: mode });
      state.persistedMode = mode;
      state.mode = mode;
      scanSearchResults();
      return;
    }

    const settings = sanitizeSettings({ ...state.settings, globalMode: mode });
    try {
      await storageLocalSet(settings);
      if (state.disposed) return;
      state.settings = settings;
      state.persistedMode = mode;
      state.mode = mode;
    } catch {
      if (state.disposed) return;
      state.mode = state.persistedMode;
    }
    scanSearchResults();
  }

  function requestModeChange(mode) {
    if (!hasStorageLocal()) {
      void saveMode(mode);
      return;
    }
    const saveAfterLoad = async () => {
      await state.loadPromise;
      return saveMode(mode);
    };
    state.saveQueue = state.saveQueue.then(
      saveAfterLoad,
      saveAfterLoad
    );
  }

  function setManagementStatus(
    message,
    isError = false,
    isPending = false
  ) {
    const status = document.getElementById?.('ywh-osf-management-status');
    if (!status) return;
    status.textContent = message;
    status.dataset.status = isError
      ? 'error'
      : isPending
        ? 'pending'
        : 'success';
  }

  function generateProfileId(displayName, profiles) {
    const base = String(displayName)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profile';
    if (!profiles[base]) return base;

    let suffix = 2;
    while (profiles[base + '-' + suffix]) suffix += 1;
    return base + '-' + suffix;
  }

  function duplicateChannelIndex(channels, target) {
    const targetId = String(target.channelId ?? '').trim();
    const targetPath = normalizeChannelPath(target.canonicalPath);

    return channels.findIndex((channel) => {
      const channelId = String(channel.channelId ?? '').trim();
      if (targetId && channelId) return targetId === channelId;
      const channelPath = normalizeChannelPath(channel.canonicalPath);
      return Boolean(
        targetPath &&
        channelPath &&
        targetPath === channelPath
      );
    });
  }

  function requestSettingsChange(change, successMessage, onSuccess) {
    const saveAfterLoad = async () => {
      await state.loadPromise;
      if (state.disposed) return;

      const candidate = sanitizeSettings(state.settings);
      if (change(candidate) === false) {
        renderManagementState();
        setManagementStatus('変更対象が見つかりません。', true);
        return;
      }
      const nextSettings = sanitizeSettings(candidate);
      setManagementStatus('保存中です。', false, true);

      if (!hasStorageLocal()) {
        applySettings(nextSettings);
        onSuccess?.();
        setManagementStatus(successMessage);
        return;
      }

      try {
        await storageLocalSet(nextSettings);
        if (state.disposed) return;
        applySettings(nextSettings);
        onSuccess?.();
        setManagementStatus(successMessage);
      } catch {
        if (state.disposed) return;
        renderManagementState();
        setManagementStatus(
          '保存できませんでした。変更は反映されていません。',
          true
        );
      }
    };

    state.saveQueue = state.saveQueue.then(
      saveAfterLoad,
      saveAfterLoad
    );
  }

  function requestProfileSelection(profileId) {
    requestSettingsChange((settings) => {
      if (!settings.profiles[profileId]) return false;
      settings.activeProfileId = profileId;
      return true;
    }, '使用するプロフィールを変更しました。');
  }

  function requestProfileCreate(displayName, input) {
    const name = String(displayName ?? '').trim();
    if (!name) {
      setManagementStatus('プロフィール名を入力してください。', true);
      return;
    }

    requestSettingsChange((settings) => {
      const id = generateProfileId(name, settings.profiles);
      settings.profiles[id] = {
        id,
        displayName: name,
        aliases: [],
        channels: [],
      };
      settings.activeProfileId = id;
      return true;
    }, 'プロフィールを作成しました。', () => {
      input.value = '';
    });
  }

  function requestProfileRename(displayName, input) {
    const name = String(displayName ?? '').trim();
    if (!name) {
      setManagementStatus('新しいプロフィール名を入力してください。', true);
      return;
    }
    const profileId = state.settings.activeProfileId;

    requestSettingsChange((settings) => {
      const profile = settings.profiles[profileId];
      if (!profile) return false;
      profile.displayName = name;
      return true;
    }, 'プロフィール名を変更しました。', () => {
      input.value = name;
    });
  }

  function requestProfileDelete() {
    const profileId = state.settings.activeProfileId;
    requestSettingsChange((settings) => {
      if (!profileId || !settings.profiles[profileId]) return false;
      delete settings.profiles[profileId];
      for (const [query, boundProfileId] of Object.entries(
        settings.queryBindings
      )) {
        if (boundProfileId === profileId) {
          delete settings.queryBindings[query];
        }
      }
      settings.activeProfileId =
        Object.keys(settings.profiles)[0] || null;
      return true;
    }, 'プロフィールを削除しました。', () => {
      clearPendingChannel();
    });
  }

  function requestChannelAdd(profileId, target) {
    const channel = sanitizeChannel(target);
    if (!profileId || !channel || !channel.canonicalPath) {
      setManagementStatus('登録対象をもう一度確認してください。', true);
      return;
    }

    requestSettingsChange((settings) => {
      const profile = settings.profiles[profileId];
      if (!profile) return false;
      const duplicateIndex = duplicateChannelIndex(
        profile.channels,
        channel
      );
      if (duplicateIndex >= 0) {
        profile.channels[duplicateIndex] = {
          ...profile.channels[duplicateIndex],
          ...channel,
          enabled: true,
        };
      } else {
        profile.channels.push({ ...channel, enabled: true });
      }
      return true;
    }, 'チャンネルを登録しました。', () => {
      clearPendingChannel(true);
    });
  }

  function requestChannelRemove(profileId, target) {
    requestSettingsChange((settings) => {
      const profile = settings.profiles[profileId];
      if (!profile) return false;
      const channelIndex = duplicateChannelIndex(
        profile.channels,
        target
      );
      if (channelIndex < 0) return false;
      profile.channels.splice(channelIndex, 1);
      return true;
    }, 'チャンネル登録を解除しました。');
  }

  function onStorageChanged(changes, areaName) {
    if (
      state.disposed ||
      areaName !== 'local' ||
      !changes ||
      !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)
    ) return;
    state.storageChangeGeneration += 1;
    applySettings(sanitizeSettings(changes[STORAGE_KEY]?.newValue));
  }

  function scheduleScan(delayMs = 50) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      scanSearchResults();
    }, delayMs);
  }

  function clearHiddenClasses() {
    for (
      const element of
      document.querySelectorAll?.(`.${HIDDEN_CLASS}`) || []
    ) {
      element.classList.remove(HIDDEN_CLASS);
    }
  }

  function removePanel() {
    document.getElementById?.(PANEL_ID)?.remove();
  }

  function cleanupSearchPage() {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
    removePanel();
    clearHiddenClasses();
    state.counts = createEmptyCounts();
    state.visibleCount = 0;
  }

  function createSvgIcon() {
    const svg = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg'
    );
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'path'
    );
    path.setAttribute(
      'd',
      'M4 6.5h16M7 12h10M10 17.5h4'
    );
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    return svg;
  }

  function appendText(parent, tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function createModeButton(mode, label, ariaLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ywh-osf-mode-button';
    button.dataset.mode = mode;
    button.setAttribute('aria-label', ariaLabel);
    button.setAttribute('aria-pressed', String(state.mode === mode));
    button.textContent = label;
    button.addEventListener('click', () => {
      requestModeChange(mode);
    });
    return button;
  }

  function createLabeledControl(
    parent,
    labelText,
    control,
    ariaLabel
  ) {
    const label = document.createElement('label');
    label.className = 'ywh-osf-field';
    appendText(label, 'span', 'ywh-osf-field__label', labelText);
    control.setAttribute('aria-label', ariaLabel);
    label.appendChild(control);
    parent.appendChild(label);
    return control;
  }

  function createManagementButton(label, ariaLabel, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className || 'ywh-osf-action-button';
    button.setAttribute('aria-label', ariaLabel);
    button.textContent = label;
    return button;
  }

  function clearPendingChannel(clearInputs = false) {
    state.pendingChannel = null;
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel) return;

    const target = panel.querySelector?.('[data-channel-target]');
    const confirmButton = panel.querySelector?.('[data-channel-confirm]');
    if (target) {
      target.textContent = '';
      target.hidden = true;
    }
    if (confirmButton) confirmButton.disabled = true;

    if (clearInputs) {
      for (const selector of [
        '[data-channel-id-input]',
        '[data-channel-path-input]',
        '[data-channel-name-input]',
      ]) {
        const input = panel.querySelector?.(selector);
        if (input) input.value = '';
      }
    }
  }

  function isExplicitChannelPath(path) {
    return /^\/(?:channel\/[^/]+|@[^/]+|c\/[^/]+|user\/[^/]+)$/i
      .test(path);
  }

  function prepareChannelTarget(idInput, pathInput, nameInput) {
    const profile = getActiveProfile();
    if (!profile) {
      setManagementStatus('先にプロフィールを作成してください。', true);
      return;
    }

    const channelId = String(idInput.value ?? '').trim();
    const canonicalPath = normalizeChannelPath(pathInput.value);
    const displayName = String(nameInput.value ?? '').trim();
    if (!canonicalPath || !isExplicitChannelPath(canonicalPath)) {
      setManagementStatus(
        '正確なチャンネルpathまたはhandleを入力してください。',
        true
      );
      return;
    }
    if (!displayName) {
      setManagementStatus('チャンネル表示名を入力してください。', true);
      return;
    }

    const channel = {
      ...(channelId ? { channelId } : {}),
      canonicalPath,
      displayName,
      enabled: true,
    };
    state.pendingChannel = {
      profileId: profile.id,
      channel,
    };

    const panel = document.getElementById?.(PANEL_ID);
    const target = panel?.querySelector?.('[data-channel-target]');
    const confirmButton = panel?.querySelector?.('[data-channel-confirm]');
    if (target) {
      const idLabel = channelId || 'なし（pathのみ）';
      target.textContent =
        `登録対象: ID: ${idLabel} / path: ${canonicalPath} / 名前: ${displayName}`;
      target.hidden = false;
    }
    if (confirmButton) confirmButton.disabled = false;
    setManagementStatus(
      '表示された登録対象を確認し、登録ボタンを押してください。'
    );
  }

  function renderManagementState() {
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel) return;

    const profileSelect = panel.querySelector?.('[data-profile-select]');
    const renameInput = panel.querySelector?.('[data-profile-rename-input]');
    const renameButton = panel.querySelector?.('[data-profile-rename]');
    const deleteButton = panel.querySelector?.('[data-profile-delete]');
    const channelList = panel.querySelector?.('[data-channel-list]');
    const channelInputs = [
      panel.querySelector?.('[data-channel-id-input]'),
      panel.querySelector?.('[data-channel-path-input]'),
      panel.querySelector?.('[data-channel-name-input]'),
    ].filter(Boolean);
    const prepareButton = panel.querySelector?.('[data-channel-prepare]');
    const confirmButton = panel.querySelector?.('[data-channel-confirm]');
    const profiles = Object.values(state.settings.profiles);
    const activeProfile = getActiveProfile();

    if (profileSelect) {
      profileSelect.textContent = '';
      if (profiles.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'プロフィールなし';
        profileSelect.appendChild(option);
      } else {
        for (const profile of profiles) {
          const option = document.createElement('option');
          option.value = profile.id;
          option.textContent = profile.displayName || profile.id;
          profileSelect.appendChild(option);
        }
      }
      profileSelect.value = activeProfile?.id || '';
      profileSelect.disabled = profiles.length === 0;
    }

    if (renameInput) {
      renameInput.value = activeProfile?.displayName || '';
      renameInput.disabled = !activeProfile;
    }
    if (renameButton) renameButton.disabled = !activeProfile;
    if (deleteButton) deleteButton.disabled = !activeProfile;
    for (const input of channelInputs) input.disabled = !activeProfile;
    if (prepareButton) prepareButton.disabled = !activeProfile;

    if (
      state.pendingChannel &&
      state.pendingChannel.profileId !== activeProfile?.id
    ) {
      clearPendingChannel();
    } else if (confirmButton) {
      confirmButton.disabled = !state.pendingChannel;
    }

    if (channelList) {
      channelList.textContent = '';
      const channels = activeProfile?.channels || [];
      if (channels.length === 0) {
        appendText(
          channelList,
          'li',
          'ywh-osf-channel-empty',
          '登録済みチャンネルはありません。'
        );
      } else {
        channels.forEach((channel, index) => {
          const item = document.createElement('li');
          item.className = 'ywh-osf-channel-item';
          const identity = [
            channel.displayName,
            channel.channelId ? `ID: ${channel.channelId}` : '',
            channel.canonicalPath,
          ].filter(Boolean).join(' / ');
          appendText(item, 'span', 'ywh-osf-channel-identity', identity);
          const removeButton = createManagementButton(
            '解除',
            `チャンネル登録を解除: ${identity}`,
            'ywh-osf-action-button ywh-osf-action-button--danger'
          );
          removeButton.dataset.channelRemove = String(index);
          removeButton.addEventListener('click', () => {
            requestChannelRemove(activeProfile.id, channel);
          });
          item.appendChild(removeButton);
          channelList.appendChild(item);
        });
      }
    }
  }

  function createManagementSection() {
    const section = document.createElement('section');
    section.className = 'ywh-osf-management';
    section.setAttribute('aria-labelledby', 'ywh-osf-management-title');
    const heading = appendText(
      section,
      'h3',
      'ywh-osf-management__title',
      'プロフィールと公式ソース'
    );
    heading.id = 'ywh-osf-management-title';

    const profileSelect = document.createElement('select');
    profileSelect.dataset.profileSelect = '';
    createLabeledControl(
      section,
      '使用するプロフィール',
      profileSelect,
      '使用するプロフィールを選択'
    );
    profileSelect.addEventListener('change', () => {
      clearPendingChannel();
      requestProfileSelection(profileSelect.value);
    });

    const createRow = document.createElement('div');
    createRow.className = 'ywh-osf-form-row';
    const createInput = document.createElement('input');
    createInput.type = 'text';
    createInput.dataset.profileCreateInput = '';
    createInput.setAttribute('autocomplete', 'off');
    createLabeledControl(
      createRow,
      '新しいプロフィール名',
      createInput,
      '新しいプロフィール名'
    );
    const createButton = createManagementButton(
      '作成',
      'プロフィールを作成'
    );
    createButton.dataset.profileCreate = '';
    createButton.addEventListener('click', () => {
      requestProfileCreate(createInput.value, createInput);
    });
    createRow.appendChild(createButton);
    section.appendChild(createRow);

    const renameRow = document.createElement('div');
    renameRow.className = 'ywh-osf-form-row';
    const renameInput = document.createElement('input');
    renameInput.type = 'text';
    renameInput.dataset.profileRenameInput = '';
    createLabeledControl(
      renameRow,
      'プロフィール名',
      renameInput,
      'プロフィールの新しい名前'
    );
    const renameButton = createManagementButton(
      '名前を変更',
      'プロフィール名を変更'
    );
    renameButton.dataset.profileRename = '';
    renameButton.addEventListener('click', () => {
      requestProfileRename(renameInput.value, renameInput);
    });
    renameRow.appendChild(renameButton);
    const deleteButton = createManagementButton(
      '削除',
      '現在のプロフィールを削除',
      'ywh-osf-action-button ywh-osf-action-button--danger'
    );
    deleteButton.dataset.profileDelete = '';
    deleteButton.addEventListener('click', requestProfileDelete);
    renameRow.appendChild(deleteButton);
    section.appendChild(renameRow);

    appendText(
      section,
      'h4',
      'ywh-osf-management__subtitle',
      '公式チャンネルを明示登録'
    );
    const channelFields = document.createElement('div');
    channelFields.className = 'ywh-osf-channel-fields';
    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.dataset.channelIdInput = '';
    createLabeledControl(
      channelFields,
      'チャンネルID（任意）',
      idInput,
      '登録するチャンネルID'
    );
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.dataset.channelPathInput = '';
    createLabeledControl(
      channelFields,
      '正確なpathまたはhandle',
      pathInput,
      '登録する正確なチャンネルpathまたはhandle'
    );
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.dataset.channelNameInput = '';
    createLabeledControl(
      channelFields,
      'チャンネル表示名',
      nameInput,
      '登録するチャンネル表示名'
    );
    section.appendChild(channelFields);

    for (const input of [idInput, pathInput, nameInput]) {
      input.addEventListener('input', () => clearPendingChannel());
    }
    const prepareButton = createManagementButton(
      '登録内容を確認',
      '登録するチャンネルの内容を確認'
    );
    prepareButton.dataset.channelPrepare = '';
    prepareButton.addEventListener('click', () => {
      prepareChannelTarget(idInput, pathInput, nameInput);
    });
    section.appendChild(prepareButton);

    const target = appendText(
      section,
      'p',
      'ywh-osf-channel-target',
      ''
    );
    target.dataset.channelTarget = '';
    target.setAttribute('aria-live', 'polite');
    target.hidden = true;
    const confirmButton = createManagementButton(
      'このチャンネルを登録',
      '表示されたチャンネルを公式ソースとして登録'
    );
    confirmButton.dataset.channelConfirm = '';
    confirmButton.disabled = true;
    confirmButton.addEventListener('click', () => {
      if (state.pendingChannel) {
        requestChannelAdd(
          state.pendingChannel.profileId,
          state.pendingChannel.channel
        );
      }
    });
    section.appendChild(confirmButton);

    const channelList = document.createElement('ul');
    channelList.className = 'ywh-osf-channel-list';
    channelList.dataset.channelList = '';
    channelList.setAttribute('aria-label', '登録済み公式チャンネル');
    section.appendChild(channelList);

    const status = appendText(
      section,
      'p',
      'ywh-osf-management__status',
      ''
    );
    status.id = 'ywh-osf-management-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    return section;
  }

  function ensurePanel() {
    if (!isSearchPage() || !document.body) return null;

    let panel = document.getElementById?.(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', 'ywh-osf-title');

    const header = document.createElement('div');
    header.className = 'ywh-osf-panel__header';
    header.appendChild(createSvgIcon());
    const heading = appendText(
      header,
      'h2',
      'ywh-osf-panel__title',
      '公式優先検索フィルター'
    );
    heading.id = 'ywh-osf-title';
    panel.appendChild(header);

    appendText(
      panel,
      'p',
      'ywh-osf-panel__note',
      '表示モードは検索ページ間で保存されます。'
    );

    const modes = document.createElement('div');
    modes.className = 'ywh-osf-panel__modes';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '表示モード');
    modes.appendChild(
      createModeButton(
        MODE.OFFICIAL,
        '公式のみ',
        '公式投稿元のみ表示'
      )
    );
    modes.appendChild(
      createModeButton(
        MODE.ALL,
        'すべて表示',
        'フィルターをオフにしてすべて表示'
      )
    );
    panel.appendChild(modes);

    const summary = document.createElement('p');
    summary.className = 'ywh-osf-panel__summary';
    summary.setAttribute('aria-live', 'polite');
    appendText(summary, 'span', '', '表示 ');
    const visible = appendText(summary, 'strong', '', '0');
    visible.dataset.countVisible = '';
    appendText(summary, 'span', '', ' / ');
    const total = appendText(summary, 'strong', '', '0');
    total.dataset.countTotal = '';
    panel.appendChild(summary);

    const counts = document.createElement('dl');
    counts.className = 'ywh-osf-panel__counts';
    for (const [category, label] of Object.entries(countLabels)) {
      const row = document.createElement('div');
      row.className = 'ywh-osf-count-row';
      appendText(row, 'dt', '', label);
      const value = appendText(row, 'dd', '', '0');
      value.dataset.count = category;
      counts.appendChild(row);
    }
    panel.appendChild(counts);
    panel.appendChild(createManagementSection());
    document.body.appendChild(panel);
    renderManagementState();
    return panel;
  }

  function initializePage() {
    if (state.disposed) return;

    if (!isSearchPage()) {
      cleanupSearchPage();
      return;
    }

    ensurePanel();
    scanSearchResults();
  }

  function onNavigateFinish() {
    initializePage();
  }

  function isPanelMutation(mutation) {
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel || !mutation.target) return false;
    return mutation.target === panel || panel.contains?.(mutation.target);
  }

  function onMutation(mutations) {
    if (!isSearchPage()) {
      cleanupSearchPage();
      return;
    }

    if (mutations.every(isPanelMutation)) return;
    scheduleScan();
  }

  let controller;

  function cleanup() {
    if (state.disposed) return;
    state.disposed = true;
    clearTimeout(state.scanTimer);
    state.observer?.disconnect();
    document.removeEventListener?.(
      'yt-navigate-finish',
      onNavigateFinish
    );
    globalThis.chrome?.storage?.onChanged?.removeListener?.(onStorageChanged);
    cleanupSearchPage();

    if (globalThis._ywhOfficialSearchFilter === controller) {
      delete globalThis._ywhOfficialSearchFilter;
    }
  }

  controller = Object.freeze({ cleanup });
  globalThis._ywhOfficialSearchFilter = controller;

  initializePage();
  state.loadPromise = loadSettings();

  if (typeof MutationObserver === 'function' && document.body) {
    state.observer = new MutationObserver(onMutation);
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href'],
    });
  }

  document.addEventListener?.(
    'yt-navigate-finish',
    onNavigateFinish
  );
  globalThis.chrome?.storage?.onChanged?.addListener?.(onStorageChanged);
})();
