'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.YWH_TEST_ROOT || path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const fn = name => source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`))?.[0] || '';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function card(id) {
  return { id, isConnected: true, querySelector: () => ({ click() {} }) };
}
function button() { return { isConnected: true, style: {}, textContent: 'ready' }; }
function boot(cards) {
  const actions = [], scope = {
    console, URL, location: { pathname: '/watch', href: 'https://www.youtube.com/watch?v=current' },
    DBClient: { contextInvalidated: false },
    getCurrentVideoId: () => 'current', getCardVideoId: c => c.id, isPlaylistCard: () => false,
    getBulkPageContext: () => scope.context,
    findQueueableCards: () => cards, findWatchLaterableCards: () => cards,
    refreshPlaylistWatchedState: async () => {},
    seedQueueWithCurrentVideo: async () => ({ ok: true }),
    queueOneCard: async c => { actions.push(c.id); return { ok: true }; },
    watchLaterOneCard: async c => { actions.push(c.id); return { ok: true }; },
    context: 'channel', confirm: () => true, buildBulkConfirmMessage: () => 'confirm',
    sleep: async () => {}, setTimeout: () => 1, contentMessage: (_key, fallback) => fallback,
    updateQueueButtonLabel() {}, updateWatchLaterButtonLabel() {},
    queueAllBtn: button(), watchLaterBtn: button(),
    queueInProgress: false, watchLaterInProgress: false, queueAbort: false, watchLaterAbort: false,
    queueRunGeneration: 0, watchLaterRunGeneration: 0,
    document: { querySelectorAll: () => [], body: { click() {} } },
  };
  vm.createContext(scope);
  const lifecycle = source.match(/  \/\/ Page response lifecycle: begin[^]*?  \/\/ Page response lifecycle: end/);
  vm.runInContext(lifecycle ? lifecycle[0] : 'let pageGeneration = 0;', scope);
  vm.runInContext(fn('cancelBulkOperations') + fn('onQueueAllClick') + fn('onWatchLaterClick'), scope);
  scope.navigate = () => {
    vm.runInContext('pageGeneration++', scope);
    if (scope.cancelBulkOperations) scope.cancelBulkOperations();
    else { scope.queueInProgress = scope.watchLaterInProgress = false; }
  };
  return { scope, actions };
}
for (const kind of ['queue', 'watchLater']) {
  const entry = kind === 'queue' ? 'onQueueAllClick' : 'onWatchLaterClick';
  const action = kind === 'queue' ? 'queueOneCard' : 'watchLaterOneCard';
  const buttonKey = kind === 'queue' ? 'queueAllBtn' : 'watchLaterBtn';
  const flag = kind + 'InProgress';
  for (const change of ['same-url-navigation', 'url-before-event', 'button-replacement']) {
    test(`${kind} stops the old batch after ${change}`, async () => {
      const cards = [card('one'), card('two')], h = boot(cards);
      h.scope[action] = async c => {
        h.actions.push(c.id);
        if (change === 'url-before-event') h.scope.location.href += '&next=1';
        else h.scope.navigate();
        if (change === 'button-replacement') h.scope[buttonKey] = button();
        return { ok: true };
      };
      await h.scope[entry]();
      assert.deepEqual(h.actions, ['one']);
      if (change === 'button-replacement') assert.equal(h.scope[buttonKey].textContent, 'ready');
    });
  }
  test(`${kind} never acts on the recycled second card`, async () => {
    const cards = [card('one'), card('two')], h = boot(cards);
    h.scope[action] = async c => { h.actions.push(c.id); cards[1].id = 'replacement'; return { ok: true }; };
    await h.scope[entry](); assert.deepEqual(h.actions, ['one']);
  });
  test(`${kind} cannot continue after navigation while playlist status is pending`, async () => {
    const h = boot([card('one')]), pending = deferred();
    h.scope.context = 'playlist'; h.scope.refreshPlaylistWatchedState = () => pending.promise;
    const work = h.scope[entry](); h.scope.navigate(); pending.resolve(); await work;
    assert.deepEqual(h.actions, []);
  });
  test(`${kind} old completion cannot unlock or relabel a new batch`, async () => {
    const h = boot([card('one')]), old = deferred(), next = deferred();
    h.scope[action] = () => old.promise;
    const first = h.scope[entry](); await new Promise(done => setImmediate(done));
    h.scope.navigate(); h.scope[buttonKey] = button();
    h.scope[action] = () => next.promise;
    const second = h.scope[entry](); await new Promise(done => setImmediate(done));
    assert.equal(h.scope[flag], true);
    const text = h.scope[buttonKey].textContent;
    old.resolve({ ok: true }); await first;
    assert.equal(h.scope[flag], true); assert.equal(h.scope[buttonKey].textContent, text);
    next.resolve({ ok: true }); await second; assert.equal(h.scope[flag], false);
  });
  for (const reason of ['empty', 'declined']) {
    test(`${kind} ${reason} before start preserves the button and does not claim completion`, async () => {
      const h = boot(reason === 'empty' ? [] : [card('one')]);
      h.scope.confirm = () => false;
      h.scope[buttonKey].style.background = 'original';
      await h.scope[entry]();
      assert.deepEqual(h.actions, []);
      assert.equal(h.scope[flag], false);
      assert.equal(h.scope[buttonKey].textContent, 'ready');
      assert.equal(h.scope[buttonKey].style.background, 'original');
    });
  }
  test(`${kind} normal batching and explicit stop still work`, async () => {
    const h = boot([card('one'), card('two')]);
    await h.scope[entry](); assert.deepEqual(h.actions, ['one', 'two']);
    h.actions.length = 0;
    h.scope[action] = async c => { h.actions.push(c.id); h.scope[kind + 'Abort'] = true; return { ok: true }; };
    await h.scope[entry](); assert.deepEqual(h.actions, ['one']);
  });
}
for (const name of ['queueOneCard', 'watchLaterOneCard', 'seedQueueWithCurrentVideo']) {
  for (const change of ['navigation', 'card-reuse', 'cancel']) {
    if (name === 'seedQueueWithCurrentVideo' && change === 'card-reuse') continue;
    test(`${name} rechecks identity before clicking a delayed menu item (${change})`, async () => {
      const c = card('one'), h = boot([c]);
      let clicks = 0, allowed = true, waits = 0;
      const item = { textContent: name === 'watchLaterOneCard' ? 'Save to Watch later' : 'Add to queue',
        getClientRects: () => [{}], querySelector: () => null, click() { clicks++; } };
      h.scope.document.querySelectorAll = () => [item];
      h.scope.document.querySelector = () => ({ click() {} });
      h.scope.sleep = async () => {
        if (++waits !== 1) return;
        if (change === 'navigation') h.scope.navigate();
        if (change === 'card-reuse') c.id = 'replacement';
        if (change === 'cancel') allowed = false;
      };
      vm.runInContext(fn('isShownMenuItem') + fn(name), h.scope);
      const result = name === 'seedQueueWithCurrentVideo'
        ? await h.scope[name]('current', undefined, () => allowed)
        : await h.scope[name](c, 'one', undefined, () => allowed);
      assert.equal(clicks, 0); assert.equal(result.ok, false);
    });
  }
}
