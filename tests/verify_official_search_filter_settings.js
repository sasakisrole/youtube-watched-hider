'use strict';

const fs = require('fs');
const path = require('path');

const STORAGE_KEY = 'officialSearchFilter';
const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  activeProfileId: null,
  globalMode: 'all',
  profiles: {},
  queryBindings: {},
};
const DOM_TEST_PATH = path.join(__dirname, 'verify_official_search_filter_dom.js');
const helperSource = fs.readFileSync(DOM_TEST_PATH, 'utf8')
  .split('async function main() {')[0];
const helpers = new Function(
  'require',
  '__dirname',
  `${helperSource}\nreturn { loadRuntime, createCard, MutationObserverStub };`
)(require, __dirname);
const { loadRuntime, createCard, MutationObserverStub } = helpers;

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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStorageStub(initialValue, behavior = {}) {
  const store = {};
  if (initialValue !== undefined) store[STORAGE_KEY] = clone(initialValue);
  const listeners = new Set();
  const runtime = { lastError: null };

  const chrome = {
    runtime,
    storage: {
      local: {
        get(key, callback) {
          if (behavior.throwRead) throw new Error('read threw');
          if (behavior.rejectRead) return Promise.reject(new Error('read rejected'));
          if (behavior.readLastError) {
            runtime.lastError = { message: 'read failed' };
            callback({});
            runtime.lastError = null;
            return undefined;
          }
          const result = {};
          if (typeof key === 'string' && Object.hasOwn(store, key)) {
            result[key] = clone(store[key]);
          }
          callback(result);
          return undefined;
        },
        set(values, callback) {
          if (behavior.throwWrite) throw new Error('write threw');
          if (behavior.rejectWrite) return Promise.reject(new Error('write rejected'));
          if (behavior.writeLastError) {
            runtime.lastError = { message: 'write failed' };
            callback();
            runtime.lastError = null;
            return undefined;
          }
          Object.assign(store, clone(values));
          callback();
          return undefined;
        },
      },
      onChanged: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },
  };

  return {
    chrome,
    store,
    listenerCount: () => listeners.size,
    externalUpdate(value) {
      const oldValue = clone(store[STORAGE_KEY]);
      store[STORAGE_KEY] = clone(value);
      const changes = {
        [STORAGE_KEY]: {
          oldValue,
          newValue: clone(value),
        },
      };
      for (const listener of [...listeners]) listener(changes, 'local');
    },
  };
}

function validSettings(globalMode = 'all', activeProfileId = null) {
  return {
    schemaVersion: 1,
    activeProfileId,
    globalMode,
    profiles: {},
    queryBindings: {},
  };
}

function makeRuntime(storage) {
  const runtime = loadRuntime();
  runtime.context.chrome = storage.chrome;
  const results = runtime.document.createElement('main');
  runtime.document.body.appendChild(results);
  const cards = {
    official: createCard(runtime.document, 'official', '/@artist', 'Artist'),
    otherTopic: createCard(runtime.document, 'other-topic', '/@release', 'Release - Topic'),
    other: createCard(runtime.document, 'other', '/@fan', 'Fan Uploads'),
  };
  Object.values(cards).forEach((card) => results.appendChild(card));
  runtime.run();
  return { ...runtime, cards };
}

function panel(runtime) {
  return runtime.document.getElementById('ywh-osf-panel');
}

function pressed(runtime, mode) {
  return panel(runtime)
    .querySelector(`[data-mode="${mode}"]`)
    .getAttribute('aria-pressed') === 'true';
}

function allVisible(runtime) {
  return Object.values(runtime.cards)
    .every((card) => !card.classList.contains('ywh-osf-hidden'));
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  await tick();
  await tick();
}

async function failOpenCase(name, initialValue, behavior) {
  const storage = createStorageStub(initialValue, behavior);
  const runtime = makeRuntime(storage);
  await settle();
  check(`${name} -> all and nothing hidden`, pressed(runtime, 'all') && allVisible(runtime));
  runtime.context._ywhOfficialSearchFilter.cleanup();
}

async function main() {
  console.log('defaults and read failures');
  {
    const storage = createStorageStub(undefined);
    const runtime = makeRuntime(storage);
    await settle();
    check('unset storage selects globalMode all', pressed(runtime, 'all'));
    check('unset storage preserves PR2 initially-all-shown behavior', allVisible(runtime));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  await failOpenCase('corrupt value', 'corrupt', {});
  {
    const unknown = { ...validSettings('official'), schemaVersion: 99 };
    await failOpenCase('unknown schemaVersion', unknown, {});
  }
  await failOpenCase('storage get throw', validSettings('official'), { throwRead: true });
  await failOpenCase('storage get lastError', validSettings('official'), { readLastError: true });
  await failOpenCase('storage get rejection', validSettings('official'), { rejectRead: true });

  console.log('save and reload');
  {
    const storage = createStorageStub(undefined);
    const first = makeRuntime(storage);
    await settle();
    panel(first).querySelector('[data-mode="official"]').click();
    await settle();
    check('successful save writes globalMode official', storage.store[STORAGE_KEY]?.globalMode === 'official');
    check('successful save applies official mode', pressed(first, 'official') && first.cards.other.classList.contains('ywh-osf-hidden'));
    first.context._ywhOfficialSearchFilter.cleanup();

    const reloaded = makeRuntime(storage);
    await settle();
    check('new runtime reloads the saved mode', pressed(reloaded, 'official'));
    check('reloaded mode re-evaluates existing cards', reloaded.cards.other.classList.contains('ywh-osf-hidden'));
    reloaded.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('schema sanitization and discovery');
  {
    const storage = createStorageStub({
      schemaVersion: 1,
      activeProfileId: 42,
      globalMode: 'mystery',
      profiles: [],
      queryBindings: 'garbage',
      futureTopLevel: true,
    });
    const runtime = makeRuntime(storage);
    await settle();
    check('invalid mode and field types sanitize fail-open', pressed(runtime, 'all') && allVisible(runtime));
    panel(runtime).querySelector('[data-mode="official"]').click();
    await settle();
    check('save round-trips sanitized empty structures and drops unknown keys',
      JSON.stringify(storage.store[STORAGE_KEY]) === JSON.stringify({ ...DEFAULT_SETTINGS, globalMode: 'official' }));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const storage = createStorageStub({ ...validSettings('all', 'profile-a'), ignored: 'drop-me' });
    const runtime = makeRuntime(storage);
    await settle();
    panel(runtime).querySelector('[data-mode="official"]').click();
    await settle();
    check('string activeProfileId survives known-shape round-trip',
      JSON.stringify(storage.store[STORAGE_KEY]) === JSON.stringify(validSettings('official', 'profile-a')));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const storage = createStorageStub(validSettings('discovery'));
    const runtime = makeRuntime(storage);
    await settle();
    check('discovery is accepted without adding a PR3a discovery button',
      !pressed(runtime, 'all') && !pressed(runtime, 'official') && panel(runtime).querySelectorAll('[data-mode]').length === 2);
    check('discovery uses the core display matrix',
      !runtime.cards.otherTopic.classList.contains('ywh-osf-hidden') && runtime.cards.other.classList.contains('ywh-osf-hidden'));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('cross-tab changes and cleanup');
  {
    const storage = createStorageStub(validSettings('all'));
    const runtime = makeRuntime(storage);
    await settle();
    storage.externalUpdate(validSettings('official'));
    check('external local change updates the existing panel mode', pressed(runtime, 'official'));
    check('external local change re-evaluates existing cards', runtime.cards.other.classList.contains('ywh-osf-hidden'));
    check('external change creates no duplicate panel or observer',
      runtime.document.querySelectorAll('#ywh-osf-panel').length === 1 &&
      MutationObserverStub.instances.filter((observer) => observer.active).length === 1);
    check('singleton owns exactly one storage listener', storage.listenerCount() === 1);
    runtime.context._ywhOfficialSearchFilter.cleanup();
    check('cleanup removes the storage listener', storage.listenerCount() === 0);
  }

  console.log('save failures');
  {
    const storage = createStorageStub(validSettings('all'), { writeLastError: true });
    const runtime = makeRuntime(storage);
    await settle();
    panel(runtime).querySelector('[data-mode="official"]').click();
    await settle();
    check('lastError save failure does not show success', pressed(runtime, 'all') && !pressed(runtime, 'official'));
    check('lastError save failure keeps cards in persisted mode', allVisible(runtime));
    check('lastError save failure leaves stored value unchanged', storage.store[STORAGE_KEY].globalMode === 'all');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const storage = createStorageStub(validSettings('all'), { rejectWrite: true });
    const runtime = makeRuntime(storage);
    await settle();
    panel(runtime).querySelector('[data-mode="official"]').click();
    await settle();
    check('rejected save also retains the persisted UI and data',
      pressed(runtime, 'all') && allVisible(runtime) && storage.store[STORAGE_KEY].globalMode === 'all');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
