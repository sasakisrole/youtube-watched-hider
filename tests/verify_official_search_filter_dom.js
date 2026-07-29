'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const core = require('../official_search_filter_core.js');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'official_search_filter.js'),
  'utf8'
);
const CSS = fs.readFileSync(
  path.join(ROOT, 'official_search_filter.css'),
  'utf8'
);
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')
);

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

class ClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return new Set(
      String(this.element.className || '')
        .split(/\s+/)
        .filter(Boolean)
    );
  }

  write(values) {
    this.element.className = [...values].join(' ');
  }

  add(...names) {
    const values = this.values();
    names.forEach((name) => values.add(name));
    this.write(values);
  }

  remove(...names) {
    const values = this.values();
    names.forEach((name) => values.delete(name));
    this.write(values);
  }

  contains(name) {
    return this.values().has(name);
  }

  toggle(name, force) {
    const values = this.values();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name);
    else values.delete(name);
    this.write(values);
    return enabled;
  }
}

function dataKey(attribute) {
  return attribute
    .slice(5)
    .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function matchesSingle(element, selector) {
  const trimmed = selector.trim();
  if (!trimmed) return false;

  if (trimmed.includes(' ')) {
    return matchesSingle(element, trimmed.split(/\s+/).at(-1));
  }
  if (trimmed.startsWith('.')) {
    return element.classList.contains(trimmed.slice(1));
  }
  if (trimmed.startsWith('#')) {
    return element.id === trimmed.slice(1);
  }

  const attributeMatch = trimmed.match(
    /^([\w-]+)?\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]$/
  );
  if (attributeMatch) {
    const [, tag, name, operator, expected] = attributeMatch;
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    const actual = name.startsWith('data-')
      ? element.dataset[dataKey(name)]
      : element.getAttribute(name);
    if (!operator) return actual !== null && actual !== undefined;
    if (operator === '=') return actual === expected;
    if (operator === '*=') return String(actual || '').includes(expected);
    if (operator === '^=') return String(actual || '').startsWith(expected);
  }

  return element.tagName === trimmed.toUpperCase();
}

function matches(element, selector) {
  return selector
    .split(',')
    .some((part) => matchesSingle(element, part));
}

function descendants(root) {
  return (root.children || []).flatMap(
    (child) => [child, ...descendants(child)]
  );
}

class ElementStub {
  constructor(tagName, document) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = document;
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.classList = new ClassList(this);
    this.listeners = {};
    this.id = '';
    this.type = '';
    this.tabIndex = this.tagName === 'BUTTON' ? 0 : -1;
    this._text = '';
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children
      .filter((child) => child !== this);
    this.parentNode = null;
  }

  contains(candidate) {
    return candidate === this || descendants(this).includes(candidate);
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes[name] = stringValue;
    if (name === 'id') this.id = stringValue;
    if (name === 'class') this.className = stringValue;
  }

  getAttribute(name) {
    if (name === 'id' && this.id) return this.id;
    if (name === 'class' && this.className) return this.className;
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  click() {
    for (const listener of this.listeners.click || []) {
      listener({ target: this, currentTarget: this });
    }
  }

  querySelectorAll(selector) {
    return descendants(this).filter((element) => matches(element, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class DocumentStub {
  constructor() {
    this.body = new ElementStub('body', this);
    this.listeners = {};
  }

  createElement(tagName) {
    return new ElementStub(tagName, this);
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName);
  }

  getElementById(id) {
    return descendants(this.body).find((element) => element.id === id) || null;
  }

  querySelectorAll(selector) {
    return descendants(this.body).filter((element) => matches(element, selector));
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] || [])
      .filter((candidate) => candidate !== listener);
  }

  dispatch(type) {
    for (const listener of [...(this.listeners[type] || [])]) listener();
  }
}

class MutationObserverStub {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.active = false;
    MutationObserverStub.instances.push(this);
  }

  observe(target, options) {
    this.target = target;
    this.options = options;
    this.active = true;
  }

  disconnect() {
    this.active = false;
  }

  emit(mutations) {
    if (this.active) this.callback(mutations);
  }
}

function createCard(document, videoId, channelPath, channelName) {
  const card = document.createElement('ytd-video-renderer');
  card.className = 'result-card';
  const watch = document.createElement('a');
  watch.setAttribute('href', `/watch?v=${videoId}`);
  card.appendChild(watch);

  if (channelPath) {
    const channel = document.createElement('a');
    channel.setAttribute('href', channelPath);
    channel.textContent = channelName;
    card.appendChild(channel);
  }

  return card;
}

function setLocation(location, pathName, query = '') {
  location.pathname = pathName;
  location.href = `https://www.youtube.com${pathName}${query}`;
}

function loadRuntime({ withCore = true } = {}) {
  MutationObserverStub.instances = [];
  const document = new DocumentStub();
  const location = {
    origin: 'https://www.youtube.com',
    pathname: '/results',
    href: 'https://www.youtube.com/results?search_query=Artist+-+Topic',
  };
  const context = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    document,
    location,
    MutationObserver: MutationObserverStub,
  };
  if (withCore) context.YWHOfficialSearchFilterCore = core;

  return {
    context,
    document,
    location,
    run() {
      vm.runInNewContext(SOURCE, context, {
        filename: 'official_search_filter.js',
      });
    },
  };
}

function snapshotCards(cards) {
  return cards.map((card) => ({
    style: JSON.stringify(card.style),
    dataset: JSON.stringify(card.dataset),
    classes: card.className,
  }));
}

function countValue(panel, category) {
  return Number(panel.querySelector(`[data-count="${category}"]`).textContent);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  console.log('core absent');
  const absent = loadRuntime({ withCore: false });
  let absentThrew = false;
  try {
    absent.run();
  } catch {
    absentThrew = true;
  }
  check('core absent is a no-throw no-op', !absentThrew);
  check('core absent creates no panel or observer',
    !absent.document.getElementById('ywh-osf-panel') &&
    MutationObserverStub.instances.length === 0);
  check('core absent exposes no runtime controller',
    !absent.context._ywhOfficialSearchFilter);

  console.log('default / classification / non-interference');
  const runtime = loadRuntime();
  const results = runtime.document.createElement('main');
  runtime.document.body.appendChild(results);
  const cards = [
    createCard(runtime.document, 'official', '/@artist', 'Artist'),
    createCard(runtime.document, 'topic', '/channel/UC_TOPIC', 'Artist - Topic'),
    createCard(runtime.document, 'other-topic', '/channel/UC_RELEASE', 'Release - Topic'),
    createCard(runtime.document, 'other', '/@fan', 'Fan Uploads'),
    createCard(runtime.document, 'pending', '', ''),
  ];
  cards.forEach((card) => results.appendChild(card));
  cards[3].style.display = 'none';
  cards[3].dataset.watchedHidden = 'true';
  cards[3].dataset.watchedVideoId = 'other';
  const initialOrder = [...results.children];
  const initialSnapshot = snapshotCards(cards);
  runtime.run();

  let panel = runtime.document.getElementById('ywh-osf-panel');
  let handle = panel.querySelector('[data-collapsed-handle]');
  let expandedContent = panel.querySelector('[data-expanded-content]');
  let panelToggle = panel.querySelector('[data-panel-toggle]');
  let globalHideButton = panel.querySelector('[data-global-hide]');
  check('default load shows only the compact collapsed handle',
    panel.dataset.expanded === 'false' &&
    expandedContent.hidden === true &&
    expandedContent.getAttribute('aria-hidden') === 'true' &&
    panel.children.length === 2 && panel.children[0] === handle &&
    handle.children.length === 2 &&
    handle.children[0] === globalHideButton &&
    handle.children[1] === panelToggle);
  check('collapsed full mode, counts, and profile sections share one hidden container',
    expandedContent.contains(panel.querySelector('[data-mode="official"]')) &&
    expandedContent.contains(panel.querySelector('[data-count-total]')) &&
    expandedContent.contains(panel.querySelector('.ywh-osf-management')));
  check('collapsed handle controls are labelled keyboard-native buttons',
    [globalHideButton, panelToggle].every((button) =>
      button.tagName === 'BUTTON' && button.type === 'button' &&
      button.tabIndex >= 0 && Boolean(button.getAttribute('aria-label'))
    ) && panelToggle.getAttribute('aria-expanded') === 'false');
  check('collapsed CSS uses a compact bottom-corner non-blocking footprint',
    CSS.includes("#ywh-osf-panel[data-expanded='false']") &&
    CSS.includes('bottom: max(8px, env(safe-area-inset-bottom))') &&
    CSS.includes('width: min(280px, calc(100vw - 24px))') &&
    CSS.includes('max-height: 64px') &&
    CSS.includes('pointer-events: none'));

  globalHideButton.click();
  await delay(10);
  check('collapsed handle global toggle hides only OTHER without expanding',
    panel.dataset.expanded === 'false' && expandedContent.hidden === true &&
    cards[0].classList.contains('ywh-osf-hidden') &&
    !cards[1].classList.contains('ywh-osf-hidden') &&
    !cards[2].classList.contains('ywh-osf-hidden') &&
    cards[3].classList.contains('ywh-osf-hidden') &&
    !cards[4].classList.contains('ywh-osf-hidden'));
  check('collapsed toggle leaves watched-hider state untouched',
    cards[3].style.display === 'none' &&
    cards[3].dataset.watchedHidden === 'true' &&
    cards[3].dataset.watchedVideoId === 'other');
  globalHideButton.click();
  await delay(10);

  panelToggle.click();
  check('expand control reveals the complete panel',
    panel.dataset.expanded === 'true' && expandedContent.hidden === false &&
    expandedContent.getAttribute('aria-hidden') === 'false' &&
    panelToggle.getAttribute('aria-expanded') === 'true' &&
    panelToggle.textContent.includes('閉じる'));
  panelToggle.click();
  check('collapse control returns to the handle-only state',
    panel.dataset.expanded === 'false' && expandedContent.hidden === true &&
    panelToggle.getAttribute('aria-expanded') === 'false' &&
    panelToggle.textContent.includes('開く'));
  panelToggle.click();
  runtime.document.dispatch('yt-navigate-finish');
  check('each /results SPA load returns to one collapsed handle',
    panel.dataset.expanded === 'false' && expandedContent.hidden === true &&
    runtime.document.querySelectorAll('#ywh-osf-panel').length === 1 &&
    runtime.document.querySelectorAll('[data-collapsed-handle]').length === 1);
  panelToggle.click();

  const officialButton = panel.querySelector('[data-mode="official"]');
  const allButton = panel.querySelector('[data-mode="all"]');
  check('panel exists once on /results with one active observer',
    runtime.document.querySelectorAll('#ywh-osf-panel').length === 1 &&
    runtime.document.querySelectorAll('[data-collapsed-handle]').length === 1 &&
    MutationObserverStub.instances.filter((observer) => observer.active).length === 1);
  check('default mode is all and initially hides nothing',
    allButton.getAttribute('aria-pressed') === 'true' &&
    cards.every((card) => !card.classList.contains('ywh-osf-hidden')));
  check('default counts cover every core category and visible total',
    countValue(panel, core.CATEGORY.OFFICIAL) === 0 &&
    countValue(panel, core.CATEGORY.CREDIT_RELATED) === 0 &&
    countValue(panel, core.CATEGORY.OTHER_TOPIC) === 2 &&
    countValue(panel, core.CATEGORY.OTHER) === 2 &&
    countValue(panel, core.CATEGORY.PENDING) === 1 &&
    panel.querySelector('[data-count-visible]').textContent === '5' &&
    panel.querySelector('[data-count-total]').textContent === '5');

  officialButton.click();
  check('unbound query stays fail-open all after a mode-button click',
    cards.every((card) => !card.classList.contains('ywh-osf-hidden')) &&
    panel.querySelector('[data-mode="all"]').getAttribute('aria-pressed') ===
      'true' &&
    panel.querySelector('[data-count-visible]').textContent === '5');
  check('classification changes no inline display or watched dataset',
    cards.every((card, index) =>
      JSON.stringify(card.style) === initialSnapshot[index].style &&
      JSON.stringify(card.dataset) === initialSnapshot[index].dataset
    ));
  check('classification preserves card order and node count',
    results.children.length === initialOrder.length &&
    results.children.every((card, index) => card === initialOrder[index]));
  check('unbound classification adds no dedicated hidden class',
    cards.every((card, index) =>
      card.className === initialSnapshot[index].classes
    ));

  console.log('off / SPA / re-render / cleanup');
  allButton.click();
  check('OFF removes every dedicated hidden class',
    cards.every((card) => !card.classList.contains('ywh-osf-hidden')) &&
    panel.querySelector('[data-count-visible]').textContent === '5');
  check('OFF does not reveal a watched-hidden card',
    cards[3].style.display === 'none' &&
    cards[3].dataset.watchedHidden === 'true' &&
    cards[3].dataset.watchedVideoId === 'other');

  officialButton.click();
  setLocation(runtime.location, '/watch', '?v=official');
  runtime.document.dispatch('yt-navigate-finish');
  check('leaving /results removes panel and clears the dedicated class',
    !runtime.document.getElementById('ywh-osf-panel') &&
    cards.every((card) => !card.classList.contains('ywh-osf-hidden')));
  check('non-search cleanup preserves watched hiding',
    cards[3].style.display === 'none' && cards[3].dataset.watchedHidden === 'true');
  check('SPA exit does not duplicate or replace the observer',
    MutationObserverStub.instances.length === 1 &&
    MutationObserverStub.instances[0].active);

  setLocation(runtime.location, '/results', '?search_query=Artist+-+Topic');
  runtime.document.dispatch('yt-navigate-finish');
  panel = runtime.document.getElementById('ywh-osf-panel');
  handle = panel.querySelector('[data-collapsed-handle]');
  expandedContent = panel.querySelector('[data-expanded-content]');
  panelToggle = panel.querySelector('[data-panel-toggle]');
  check('SPA round-trip restores one collapsed handle and re-resolves unbound to all',
    runtime.document.querySelectorAll('#ywh-osf-panel').length === 1 &&
    runtime.document.querySelectorAll('[data-collapsed-handle]').length === 1 &&
    panel.dataset.expanded === 'false' && expandedContent.hidden === true &&
    panel.querySelector('[data-mode="all"]').getAttribute('aria-pressed') === 'true' &&
    cards.every((card) => !card.classList.contains('ywh-osf-hidden')));
  check('SPA round-trip still has exactly one observer',
    MutationObserverStub.instances.length === 1 &&
    MutationObserverStub.instances.filter((observer) => observer.active).length === 1);
  panelToggle.click();
  check('SPA-restored handle can reveal the full panel again',
    panel.dataset.expanded === 'true' && expandedContent.hidden === false);

  const added = createCard(
    runtime.document,
    'new-other',
    '/@another-fan',
    'Another Fan'
  );
  results.appendChild(added);
  MutationObserverStub.instances[0].emit([{
    type: 'childList',
    target: results,
    addedNodes: [added],
  }]);
  await delay(80);
  check('infinite-scroll card stays visible for an unbound query',
    !added.classList.contains('ywh-osf-hidden') &&
    countValue(panel, core.CATEGORY.OTHER) === 3 &&
    panel.querySelector('[data-count-total]').textContent === '6');

  added.children[1].setAttribute('href', '/@artist-archive');
  added.children[1].textContent = 'Artist';
  MutationObserverStub.instances[0].emit([{
    type: 'attributes',
    target: added.children[1],
    attributeName: 'href',
  }]);
  await delay(80);
  check('a same-name reused card stays visible but is not auto-confirmed',
    !added.classList.contains('ywh-osf-hidden') &&
    countValue(panel, core.CATEGORY.OFFICIAL) === 0 &&
    countValue(panel, core.CATEGORY.OTHER) === 3);
  check('re-render leaves one panel, one observer, and every card node in place',
    runtime.document.querySelectorAll('#ywh-osf-panel').length === 1 &&
    runtime.document.querySelectorAll('[data-collapsed-handle]').length === 1 &&
    MutationObserverStub.instances.filter((observer) => observer.active).length === 1 &&
    results.children.length === 6 && results.children[5] === added);

  runtime.context._ywhOfficialSearchFilter.cleanup();
  check('explicit cleanup clears only owned UI/classes and disconnects observer',
    !runtime.document.getElementById('ywh-osf-panel') &&
    [...results.children].every((card) => !card.classList.contains('ywh-osf-hidden')) &&
    MutationObserverStub.instances.every((observer) => !observer.active));
  check('explicit cleanup still does not reveal watched-hidden nodes',
    cards[3].style.display === 'none' && cards[3].dataset.watchedHidden === 'true');

  console.log('a11y / manifest');
  const controls = panel.querySelectorAll('[data-mode]');
  check('controls are labelled native buttons and keyboard reachable',
    controls.length === 3 && controls.every((button) =>
      button.tagName === 'BUTTON' && button.type === 'button' &&
      button.tabIndex >= 0 && Boolean(button.getAttribute('aria-label'))
    ));
  check('panel and mode group have accessible names and pressed state',
    panel.getAttribute('role') === 'region' &&
    Boolean(panel.getAttribute('aria-label')) &&
    expandedContent.getAttribute('aria-labelledby') === 'ywh-osf-title' &&
    panel.querySelector('[role="group"]').getAttribute('aria-label') &&
    controls.every((button) => button.getAttribute('aria-pressed') !== null));
  check('added UI uses an aria-hidden inline SVG and no emoji or CSS content',
    panel.querySelector('svg').getAttribute('aria-hidden') === 'true' &&
    !/[\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3\u{1F300}-\u{1FAFF}]/u
      .test(SOURCE + CSS) &&
    !/(?:^|[;{])\s*content\s*:/im.test(CSS));
  check('CSS includes 44px targets, focus-visible, zoom-safe layout, and dark mode',
    CSS.includes('min-height: 44px') && CSS.includes(':focus-visible') &&
    CSS.includes('calc(100vw - 16px)') &&
    CSS.includes('@media (prefers-color-scheme: dark)'));

  const script = MANIFEST.content_scripts[0];
  check('manifest loads core and runtime after content.js with scoped CSS',
    script.js.join(',') ===
      'content.js,official_search_filter_core.js,official_profile_store.js,official_search_filter.js' &&
    script.css.join(',') === 'official_search_filter.css' &&
    script.matches.join(',') === '*://*.youtube.com/*');
  check('manifest adds no host permission or web-accessible resource',
    MANIFEST.host_permissions.join(',') ===
      '*://*.youtube.com/*,https://musicbrainz.org/*' &&
    !Object.prototype.hasOwnProperty.call(MANIFEST, 'web_accessible_resources'));
  check('runtime source never writes inline display or watched datasets',
    !/\.style\.display\s*=/.test(SOURCE) &&
    !/dataset\.(?:watched|shorts|movie)/i.test(SOURCE));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
