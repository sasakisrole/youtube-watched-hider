'use strict';

const fs = require('fs');
const path = require('path');

const STORAGE_KEY = 'officialSearchFilter';
const ROOT = path.join(__dirname, '..');
const RUNTIME_SOURCE = fs.readFileSync(
  path.join(ROOT, 'official_search_filter.js'),
  'utf8'
);
const PROFILE_TEST_PATH = path.join(
  __dirname,
  'verify_official_search_filter_profiles.js'
);
const profileTestSource = fs.readFileSync(PROFILE_TEST_PATH, 'utf8');
const helperSource = profileTestSource.slice(
  0,
  profileTestSource.lastIndexOf('\nasync function main() {')
);
const helpers = new Function(
  'require',
  '__dirname',
  `${helperSource}\nreturn {
    createStorageStub,
    validSettings,
    panel,
    settle,
    loadRuntime,
    createCard,
  };`
)(require, __dirname);
const {
  createStorageStub,
  validSettings,
  panel,
  settle,
  loadRuntime,
  createCard,
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
  queryBindings = {
    'alpha query': 'alpha',
    'beta query': 'beta',
  },
  alphaAliases = ['Ａｌｐｈａ　Ａｌｉａｓ'],
  betaAliases = [],
} = {}) {
  return {
    ...validSettings('official', 'alpha'),
    profiles: {
      alpha: {
        id: 'alpha',
        displayName: 'Alpha Artist',
        aliases: alphaAliases,
        channels: [{
          channelId: 'UC_ALPHA',
          canonicalPath: '/@saved-alpha',
          displayName: 'Saved Alpha',
          enabled: true,
        }],
        mode: 'official',
      },
      beta: {
        id: 'beta',
        displayName: 'Beta Artist',
        aliases: betaAliases,
        channels: [],
        mode: 'all',
      },
    },
    queryBindings,
  };
}

function control(runtime, selector) {
  return panel(runtime).querySelector(selector);
}

function dispatch(element, type) {
  for (const listener of element.listeners[type] || []) {
    listener({ target: element, currentTarget: element });
  }
}

function setQuery(runtime, query) {
  runtime.location.pathname = '/results';
  runtime.location.href =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  runtime.document.dispatch('yt-navigate-finish');
}

function makeRuntime(storage, query) {
  const runtime = loadRuntime();
  runtime.context.chrome = storage.chrome;
  setQuery(runtime, query);
  const results = runtime.document.createElement('main');
  runtime.document.body.appendChild(results);
  const cards = {
    registered: createCard(
      runtime.document,
      'registered',
      '/channel/UC_ALPHA',
      'Unrelated Registered Name'
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
      'Unregistered Source'
    ),
  };
  Object.values(cards).forEach((card) => results.appendChild(card));
  runtime.run();
  return { ...runtime, cards };
}

function allVisible(runtime) {
  return Object.values(runtime.cards)
    .every((card) => !card.classList.contains('ywh-osf-hidden'));
}

function isOfficialView(runtime) {
  return (
    !runtime.cards.registered.classList.contains('ywh-osf-hidden') &&
    runtime.cards.topic.classList.contains('ywh-osf-hidden') &&
    runtime.cards.other.classList.contains('ywh-osf-hidden')
  );
}

async function main() {
  console.log('exact resolution and no fuzzy selection');
  {
    const storage = createStorageStub(settings());
    const runtime = makeRuntime(storage, 'alpha query');
    await settle();
    check('exact normalized binding resolves its profile and official mode',
      isOfficialView(runtime) &&
      control(runtime, '[data-count="official"]').textContent === '1' &&
      control(runtime, '[data-effective-profile]').textContent.includes(
        'Alpha Artist'
      ));
    check('binding is selection only and does not make other cards official',
      control(runtime, '[data-count="official"]').textContent === '1' &&
      control(runtime, '[data-count="other"]').textContent === '1' &&
      runtime.cards.other.classList.contains('ywh-osf-hidden'));

    setQuery(runtime, 'ＡＬＰＨＡ   ＱＵＥＲＹ');
    await settle();
    check('NFKC and case-equivalent query resolves the same exact binding',
      isOfficialView(runtime));

    setQuery(runtime, 'alpha que');
    await settle();
    check('partial query never auto-resolves despite manual active/global official',
      allVisible(runtime) &&
      control(runtime, '[data-mode="all"]').getAttribute('aria-pressed') ===
        'true');

    setQuery(runtime, 'listen to alpha artist live');
    await settle();
    check('substring displayName match is rejected and never calls fuzzy matcher',
      allVisible(runtime) &&
      !RUNTIME_SOURCE.includes('matchProfileForQuery'));

    setQuery(runtime, 'alpha alias');
    await settle();
    check('an exact normalized alias resolves without creating a binding',
      isOfficialView(runtime) &&
      !Object.hasOwn(
        storage.store[STORAGE_KEY].queryBindings,
        'alpha alias'
      ));

    setQuery(runtime, 'beta query');
    await settle();
    check('another bound profile applies its own all mode', allVisible(runtime));
    setQuery(runtime, 'alpha query');
    await settle();
    check('SPA query switch re-resolves back to profile official mode',
      isOfficialView(runtime));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('ambiguous and unbound fail-open');
  {
    const storage = createStorageStub(settings({
      queryBindings: {},
      alphaAliases: ['shared alias'],
      betaAliases: ['ＳＨＡＲＥＤ　ＡＬＩＡＳ'],
    }));
    const runtime = makeRuntime(storage, 'shared alias');
    await settle();
    check('ambiguous exact alias does not guess a profile', allVisible(runtime));
    setQuery(runtime, 'completely unbound');
    await settle();
    check('unbound query ignores sticky manual profile and global official mode',
      allVisible(runtime));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('binding CRUD and per-profile mode');
  {
    const storage = createStorageStub(settings({ queryBindings: {} }));
    const runtime = makeRuntime(storage, '  ＮＥＷ   Query  ');
    await settle();
    const bindingSelect = control(
      runtime,
      '[data-binding-profile-select]'
    );
    bindingSelect.value = 'alpha';
    control(runtime, '[data-binding-save]').click();
    await settle();
    check('explicit binding add stores normalized query and applies profile',
      storage.store[STORAGE_KEY].queryBindings['new query'] === 'alpha' &&
      control(runtime, '[data-binding-query]').textContent.includes(
        'new query'
      ) &&
      isOfficialView(runtime));

    bindingSelect.value = 'beta';
    control(runtime, '[data-binding-save]').click();
    await settle();
    check('explicit binding change round-trips and switches to profile all mode',
      storage.store[STORAGE_KEY].queryBindings['new query'] === 'beta' &&
      allVisible(runtime));

    control(runtime, '[data-binding-remove]').click();
    await settle();
    check('binding remove deletes the exact key and leaves no sticky profile',
      !Object.hasOwn(storage.store[STORAGE_KEY].queryBindings, 'new query') &&
      allVisible(runtime));

    const modeSelect = control(runtime, '[data-profile-mode]');
    modeSelect.value = 'discovery';
    dispatch(modeSelect, 'change');
    await settle();
    bindingSelect.value = 'alpha';
    control(runtime, '[data-binding-save]').click();
    await settle();
    check('per-profile mode persists and applies after exact binding resolution',
      storage.store[STORAGE_KEY].profiles.alpha.mode === 'discovery' &&
      !runtime.cards.registered.classList.contains('ywh-osf-hidden') &&
      !runtime.cards.topic.classList.contains('ywh-osf-hidden') &&
      runtime.cards.other.classList.contains('ywh-osf-hidden'));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('binding save failure');
  {
    const storage = createStorageStub(
      settings({ queryBindings: {} }),
      { writeLastError: true }
    );
    const runtime = makeRuntime(storage, 'failed binding');
    await settle();
    const bindingSelect = control(
      runtime,
      '[data-binding-profile-select]'
    );
    bindingSelect.value = 'alpha';
    control(runtime, '[data-binding-save]').click();
    await settle();
    check('failed binding save is neither rendered nor persisted as selected',
      !Object.hasOwn(
        storage.store[STORAGE_KEY].queryBindings,
        'failed binding'
      ) &&
      allVisible(runtime) &&
      control(runtime, '[data-binding-remove]').disabled === true &&
      control(runtime, '#ywh-osf-management-status').dataset.status ===
        'error');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('dangling and corrupt fail-open');
  {
    const dangling = settings({
      queryBindings: { 'dangling query': 'missing-profile' },
    });
    const storage = createStorageStub(dangling);
    const runtime = makeRuntime(storage, 'dangling query');
    await settle();
    check('dangling binding is sanitized from live state and shows all',
      allVisible(runtime) &&
      control(runtime, '[data-binding-remove]').disabled === true);

    const modeSelect = control(runtime, '[data-profile-mode]');
    modeSelect.value = 'official';
    dispatch(modeSelect, 'change');
    await settle();
    check('next save round-trips without the dangling binding',
      !Object.hasOwn(
        storage.store[STORAGE_KEY].queryBindings,
        'dangling query'
      ) && allVisible(runtime));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const corruptBindings = settings();
    corruptBindings.queryBindings = [];
    const storage = createStorageStub(corruptBindings);
    const runtime = makeRuntime(storage, 'alpha query');
    await settle();
    check('corrupt queryBindings fail-open to all without throwing',
      allVisible(runtime));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const corruptProfile = settings();
    corruptProfile.profiles.alpha = 'corrupt';
    const storage = createStorageStub(corruptProfile);
    const runtime = makeRuntime(storage, 'alpha query');
    await settle();
    check('corrupt bound profile is removed with its binding and shows all',
      allVisible(runtime));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  {
    const corruptMode = settings();
    corruptMode.profiles.alpha.mode = 'invalid-mode';
    const storage = createStorageStub(corruptMode);
    const runtime = makeRuntime(storage, 'alpha query');
    await settle();
    check('corrupt per-profile mode sanitizes fail-open to all',
      allVisible(runtime));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('cross-tab re-resolution');
  {
    const initial = settings({ queryBindings: {} });
    const storage = createStorageStub(initial);
    const runtime = makeRuntime(storage, 'cross tab query');
    await settle();
    storage.externalUpdate({
      ...initial,
      queryBindings: { 'cross tab query': 'alpha' },
    });
    check('cross-tab binding add re-resolves current cards immediately',
      isOfficialView(runtime));
    storage.externalUpdate(initial);
    check('cross-tab binding removal re-resolves fail-open without duplicates',
      allVisible(runtime) &&
      runtime.document.querySelectorAll('#ywh-osf-panel').length === 1);
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('binding UI accessibility');
  {
    const storage = createStorageStub(settings({ queryBindings: {} }));
    const runtime = makeRuntime(storage, 'accessible query');
    await settle();
    const controls = [
      control(runtime, '[data-profile-mode]'),
      control(runtime, '[data-binding-profile-select]'),
      control(runtime, '[data-binding-save]'),
      control(runtime, '[data-binding-remove]'),
    ];
    check('binding and profile-mode controls are labeled keyboard-native controls',
      controls.every((item) =>
        ['BUTTON', 'SELECT'].includes(item.tagName) &&
        Boolean(item.getAttribute('aria-label')) &&
        item.getAttribute('tabindex') !== '-1'
      ));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
