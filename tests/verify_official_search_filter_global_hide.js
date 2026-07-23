'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../official_search_filter_core.js');

const STORAGE_KEY = 'officialSearchFilter';
const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(
  path.join(ROOT, 'official_search_filter.css'),
  'utf8'
);
const SETTINGS_TEST_PATH = path.join(
  __dirname,
  'verify_official_search_filter_settings.js'
);
const settingsTestSource = fs.readFileSync(SETTINGS_TEST_PATH, 'utf8');
const helperSource = settingsTestSource.slice(
  0,
  settingsTestSource.lastIndexOf('\nasync function main() {')
);
const helpers = new Function(
  'require',
  '__dirname',
  `${helperSource}\nreturn {
    createStorageStub,
    loadRuntime,
    createCard,
    settle,
  };`
)(require, __dirname);
const {
  createStorageStub,
  loadRuntime,
  createCard,
  settle,
} = helpers;

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

function settings({
  hideOtherGlobal = false,
  profileMode = 'official',
  queryBindings = {},
} = {}) {
  return {
    schemaVersion: 1,
    activeProfileId: 'artist',
    globalMode: 'all',
    hideOtherGlobal,
    profiles: {
      artist: {
        id: 'artist',
        displayName: 'Artist',
        aliases: [],
        channels: [{
          channelId: 'UC_REGISTERED',
          canonicalPath: '/channel/UC_REGISTERED',
          displayName: 'Registered Source',
          enabled: true,
        }],
        mode: profileMode,
      },
    },
    queryBindings,
  };
}

const runtimeCore = {
  ...core,
  classifyChannel(args) {
    if (args.channel?.channelId === 'UC_CREDIT') {
      return core.CATEGORY.CREDIT_RELATED;
    }
    return core.classifyChannel(args);
  },
};

function setQuery(runtime, query) {
  runtime.location.pathname = '/results';
  runtime.location.href =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function makeRuntime(storage, query = 'unbound query') {
  const runtime = loadRuntime();
  runtime.context.chrome = storage.chrome;
  runtime.context.YWHOfficialSearchFilterCore = runtimeCore;
  setQuery(runtime, query);

  const results = runtime.document.createElement('main');
  runtime.document.body.appendChild(results);
  const cards = {
    registered: createCard(
      runtime.document,
      'registered',
      '/channel/UC_REGISTERED',
      'Registered Source'
    ),
    credit: createCard(
      runtime.document,
      'credit',
      '/channel/UC_CREDIT',
      'Credit Source'
    ),
    topic: createCard(
      runtime.document,
      'topic',
      '/channel/UC_TOPIC',
      'Release - Topic'
    ),
    other: createCard(
      runtime.document,
      'other',
      '/channel/UC_OTHER',
      'Artist Official Channel'
    ),
    pending: createCard(
      runtime.document,
      'pending',
      '',
      ''
    ),
  };
  Object.values(cards).forEach((card) => results.appendChild(card));
  runtime.run();
  return { ...runtime, results, cards };
}

function panel(runtime) {
  return runtime.document.getElementById('ywh-osf-panel');
}

function control(runtime, selector) {
  return panel(runtime).querySelector(selector);
}

function isShown(card) {
  return !card.classList.contains('ywh-osf-hidden');
}

function categoryCounts(runtime) {
  return JSON.stringify(Object.fromEntries(
    Object.values(core.CATEGORY).map((category) => [
      category,
      control(runtime, `[data-count="${category}"]`).textContent,
    ])
  ));
}

async function main() {
  console.log('default off and registration-free discovery');
  {
    const storage = createStorageStub(settings());
    const runtime = makeRuntime(storage);
    await settle();
    const toggle = control(runtime, '[data-global-hide]');
    check('global hide defaults OFF',
      toggle.getAttribute('aria-checked') === 'false' &&
      storage.store[STORAGE_KEY].hideOtherGlobal === false);
    check('default OFF keeps an unbound query fully visible',
      Object.values(runtime.cards).every(isShown) &&
      control(runtime, '[data-mode="all"]').getAttribute('aria-pressed') ===
        'true');
    check('default OFF preserves the existing unbound-disable contract',
      control(runtime, '[data-mode="official"]').disabled === true &&
      control(runtime, '[data-mode="discovery"]').disabled === true &&
      control(runtime, '[data-unbound-hint]').hidden === false);
    check('global toggle is prominent, accessible, and precedes mode buttons',
      toggle.tagName === 'BUTTON' && toggle.type === 'button' &&
      toggle.getAttribute('role') === 'switch' &&
      Boolean(toggle.getAttribute('aria-label')) &&
      panel(runtime).children.indexOf(toggle) <
        panel(runtime).children.indexOf(
          panel(runtime).querySelector('.ywh-osf-panel__modes')
        ));
    check('global toggle explains automatic Topic detection',
      panel(runtime).querySelector('.ywh-osf-global-hide__note').textContent ===
        'Topicはチャンネル名から自動判定します。');

    const initialOrder = [...runtime.results.children];
    const countsBefore = categoryCounts(runtime);
    runtime.cards.other.style.display = 'none';
    runtime.cards.other.dataset.watchedHidden = 'true';
    const watchedSnapshot = JSON.stringify({
      style: runtime.cards.other.style,
      dataset: runtime.cards.other.dataset,
    });
    toggle.click();
    await settle();

    check('toggle ON persists on the official settings key',
      storage.store[STORAGE_KEY].hideOtherGlobal === true &&
      !Object.hasOwn(storage.store, 'hideOtherGlobal'));
    check('toggle does not change saved globalMode or per-profile mode',
      storage.store[STORAGE_KEY].globalMode === 'all' &&
      storage.store[STORAGE_KEY].profiles.artist.mode === 'official');
    check('toggle ON hides OTHER without requiring a profile',
      !isShown(runtime.cards.other) &&
      !control(runtime, '[data-effective-profile]').textContent.includes(
        'Artist'
      ));
    check('toggle ON keeps automatic OTHER_TOPIC visible',
      isShown(runtime.cards.topic));
    check('toggle ON keeps PENDING visible fail-open',
      isShown(runtime.cards.pending));
    check('toggle ON follows discovery for CREDIT_RELATED',
      isShown(runtime.cards.credit));
    check('an official-looking name is not auto-confirmed',
      control(runtime, '[data-count="official"]').textContent === '0' &&
      control(runtime, '[data-count="other"]').textContent === '2' &&
      !isShown(runtime.cards.other));
    check('global filtering changes only owned hidden classes',
      JSON.stringify({
        style: runtime.cards.other.style,
        dataset: runtime.cards.other.dataset,
      }) === watchedSnapshot);
    check('global filtering preserves order, nodes, and category counts',
      runtime.results.children.length === initialOrder.length &&
      runtime.results.children.every(
        (card, index) => card === initialOrder[index]
      ) && categoryCounts(runtime) === countsBefore);
    check('toggle ON reflects registration-free discovery without enabling modes',
      toggle.getAttribute('aria-checked') === 'true' &&
      control(runtime, '[data-mode="discovery"]').getAttribute(
        'aria-pressed'
      ) === 'true' &&
      control(runtime, '[data-mode="discovery"]').disabled === true);

    runtime.context._ywhOfficialSearchFilter.cleanup();
    const restored = makeRuntime(storage);
    await settle();
    check('persisted toggle state restores after reload',
      control(restored, '[data-global-hide]').getAttribute('aria-checked') ===
        'true' && !isShown(restored.cards.other));
    restored.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('bound-profile override');
  {
    const storage = createStorageStub(settings({
      hideOtherGlobal: true,
      profileMode: 'official',
      queryBindings: { 'bound query': 'artist' },
    }));
    const runtime = makeRuntime(storage, 'bound query');
    await settle();
    check('bound official mode overrides global discovery',
      isShown(runtime.cards.registered) &&
      isShown(runtime.cards.credit) &&
      isShown(runtime.cards.pending) &&
      !isShown(runtime.cards.topic) &&
      !isShown(runtime.cards.other));
    check('bound override leaves its per-profile mode selected and enabled',
      control(runtime, '[data-mode="official"]').getAttribute(
        'aria-pressed'
      ) === 'true' &&
      control(runtime, '[data-mode="official"]').disabled === false &&
      storage.store[STORAGE_KEY].profiles.artist.mode === 'official');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('cross-tab, sanitization, and save failure');
  {
    const initial = settings();
    const storage = createStorageStub(initial);
    const runtime = makeRuntime(storage);
    await settle();
    storage.externalUpdate({ ...initial, hideOtherGlobal: true });
    check('cross-tab ON re-applies registration-free discovery',
      control(runtime, '[data-global-hide]').getAttribute('aria-checked') ===
        'true' && !isShown(runtime.cards.other) && isShown(runtime.cards.topic));
    storage.externalUpdate({ ...initial, hideOtherGlobal: false });
    check('cross-tab OFF restores the unbound all view',
      control(runtime, '[data-global-hide]').getAttribute('aria-checked') ===
        'false' && Object.values(runtime.cards).every(isShown));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const invalid = settings();
    invalid.hideOtherGlobal = 'true';
    const storage = createStorageStub(invalid);
    const runtime = makeRuntime(storage);
    await settle();
    check('non-boolean toggle state sanitizes fail-open to false',
      control(runtime, '[data-global-hide]').getAttribute('aria-checked') ===
        'false' && Object.values(runtime.cards).every(isShown));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const storage = createStorageStub(settings(), { writeLastError: true });
    const runtime = makeRuntime(storage);
    await settle();
    control(runtime, '[data-global-hide]').click();
    await settle();
    check('failed toggle save keeps persisted OFF state and visible cards',
      storage.store[STORAGE_KEY].hideOtherGlobal === false &&
      control(runtime, '[data-global-hide]').getAttribute('aria-checked') ===
        'false' && Object.values(runtime.cards).every(isShown));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('toggle styling and safety source guards');
  check('toggle CSS has 44px target and focus-visible styling',
    CSS.includes('.ywh-osf-global-hide') &&
    CSS.includes('min-height: 44px') &&
    CSS.includes('.ywh-osf-global-hide:focus-visible'));
  check('toggle CSS uses existing theme variables for dark-mode compatibility',
    CSS.includes('var(--ywh-osf-active)') &&
    CSS.includes('var(--ywh-osf-active-text)'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
