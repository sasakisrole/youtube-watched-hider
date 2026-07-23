(() => {
  'use strict';

  const core = globalThis.YWHOfficialSearchFilterCore;

  if (
    !core ||
    typeof core.classifyChannel !== 'function' ||
    typeof core.shouldShowCategory !== 'function' ||
    typeof core.normalizeText !== 'function'
  ) {
    return;
  }

  const {
    CATEGORY,
    MODE,
    classifyChannel,
    normalizeText,
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
    [CATEGORY.OFFICIAL]: '公式・同名Topic',
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

  function sanitizeSettings(value) {
    if (!isPlainObject(value) || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      return createDefaultSettings();
    }
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activeProfileId:
        value.activeProfileId === null || typeof value.activeProfileId === 'string'
          ? value.activeProfileId
          : null,
      globalMode: isValidMode(value.globalMode) ? value.globalMode : MODE.ALL,
      profiles: isPlainObject(value.profiles) ? { ...value.profiles } : {},
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

  function getCurrentSearchQuery() {
    try {
      return new URL(location.href).searchParams.get('search_query') || '';
    } catch {
      return '';
    }
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

  function withoutTopicSuffix(value) {
    return normalizeText(value)
      .replace(/\s[-–—]\stopic$/i, '')
      .trim();
  }

  function channelKey(channel) {
    if (channel.channelId) return `id:${channel.channelId}`;
    if (channel.canonicalPath) {
      return `path:${channel.canonicalPath.toLowerCase()}`;
    }
    return '';
  }

  function buildTemporaryProfile(cards) {
    const query = getCurrentSearchQuery();
    const queryBase = withoutTopicSuffix(query);
    const channels = [];
    const seen = new Set();

    if (queryBase) {
      for (const card of cards) {
        const channel = getChannelIdentityFromCard(card);
        if (
          !channel ||
          withoutTopicSuffix(channel.displayName) !== queryBase
        ) {
          continue;
        }

        const key = channelKey(channel);
        if (!key || seen.has(key)) continue;

        seen.add(key);
        channels.push({ ...channel, enabled: true });
      }
    }

    return {
      id: 'temporary-search-profile',
      displayName: query.trim() || '現在の検索',
      aliases: [],
      channels,
    };
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
    const profile = buildTemporaryProfile(cards);
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
    document.body.appendChild(panel);
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
