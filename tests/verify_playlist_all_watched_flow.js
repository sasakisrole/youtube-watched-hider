const { assert, read, boot, initial, row, continuation } = require('./playlist_all_watched_harness');
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
(async () => {
  await test('REQ-3 missing switch off; off and other pages do not communicate', async () => {
    const content = read('content.js');
    assert.match(content, /hideCompletedPlaylists: false/);
    assert.match(content, /hideCompletedPlaylists = settings.hideCompletedPlaylists === true/);
    for (const settings of [{}, { hideCompletedPlaylists: false }, { hideCompletedPlaylists: 'true' }]) {
      const h = boot(); h.scope.watchedDisplaySettings = settings;
      assert.equal(await h.scope.checkPlaylistAllWatched({ listId: 'PLtest', videoCount: 1 }, 0), null);
      assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
    }
    for (const pathname of ['/', '/playlist', '/results', '/@channel/playlists']) {
      const h = boot(); h.scope.location.pathname = pathname;
      await h.scope.checkPlaylistAllWatched({ listId: 'PLtest', videoCount: 1 }, 0);
      assert.equal(h.calls.length, 0);
    }
  });
  await test('REQ-2 actual cache reuse count change and expired refetch', async () => {
    const h = boot(), meta = { listId: 'PLtest', videoCount: 1 };
    assert.equal((await h.scope.checkPlaylistAllWatched(meta, 0)).allWatched, true);
    assert.equal(h.calls.filter(x => x[0] === 'browse').length, 1);
    await h.scope.checkPlaylistAllWatched(meta, 0);
    assert.equal(h.calls.filter(x => x[0] === 'browse').length, 1);
    await h.scope.checkPlaylistAllWatched({ ...meta, videoCount: 2 }, 0);
    assert.equal(h.calls.filter(x => x[0] === 'browse').length, 2);
    Object.values(h.stored).forEach(value => value.checkedAt -= 7 * 86400000);
    await h.scope.checkPlaylistAllWatched({ ...meta, videoCount: 2 }, 0);
    assert.equal(h.calls.filter(x => x[0] === 'browse').length, 3);
  });
  await test('REQ-4 network logout and DB failures never save or hide', async () => {
    for (const mode of ['network', 'logout', 'db']) {
      const h = boot();
      if (mode === 'network') h.scope.fetchPlaylistAllWatchedPage = async () => { throw Error('offline'); };
      if (mode === 'logout') h.scope.playlistAllWatchedContext = () => null;
      if (mode === 'db') h.scope.DBClient.checkMultiple = async () => { throw Error('db'); };
      assert.equal(await h.scope.checkPlaylistAllWatched({ listId: 'PLtest', videoCount: 1 }, 0), null);
      assert.equal(h.writes.length, 0);
    }
  });
  await test('REQ-4 three consecutive failures stop until navigation; success resets streak', async () => {
    const h = boot(); let requests = 0;
    h.scope.fetchPlaylistAllWatchedPage = async () => { requests++; throw Error('offline'); };
    for (let i = 0; i < 5; i++) await h.scope.checkPlaylistAllWatched({ listId: 'PLtest', videoCount: 1 }, 0);
    assert.equal(requests, 3);
    h.scope.resetPlaylistAllWatched(true);
    await h.scope.checkPlaylistAllWatched({ listId: 'PLtest', videoCount: 1 }, 1);
    assert.equal(requests, 4);
    h.scope.fetchPlaylistAllWatchedPage = async () => initial([row('aaaaaaaaaaa')]);
    await h.scope.checkPlaylistAllWatched({ listId: 'PLok', videoCount: 1 }, 1);
    assert.equal(h.run('playlistAllWatchedFailures'), 0);
  });
  await test('REQ-1 three pages maximum; no partial hide; skipped result cached', async () => {
    const h = boot(); let requests = 0;
    h.scope.fetchPlaylistAllWatchedPage = async body => {
      requests++;
      const items = [row('aaaaaaaaaaa'), continuation('next' + requests)];
      return body.continuation ? { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] } : initial(items);
    };
    const result = await h.scope.checkPlaylistAllWatched({ listId: 'PLtest', videoCount: 3 }, 0);
    assert.equal(requests, 3); assert.equal(result.allWatched, false); assert.equal(result.skipped, true);
    assert.equal(h.writes.length, 1);
  });
  await test('REQ-4 in flight cancellation never saves or applies', async () => {
    const h = boot();
    h.scope.fetchPlaylistAllWatchedPage = async () => { h.scope.resetPlaylistAllWatched(); return initial([row('aaaaaaaaaaa')]); };
    assert.equal(await h.scope.checkPlaylistAllWatched({ listId: 'PLtest', videoCount: 1 }, 0), null);
    assert.equal(h.writes.length, 0);
  });

  await test('REQ-1 excluded and oversized lists never browse; zero playable not hidden', async () => {
    for (const listId of ['WL', 'LL', 'RDmix']) {
      const h = boot();
      assert.equal(await h.scope.checkPlaylistAllWatched({ listId, videoCount: 1 }, 0), null);
      assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
    }
    const h = boot();
    assert.equal((await h.scope.checkPlaylistAllWatched({ listId: 'PLlarge', videoCount: 301 }, 0)).skipped, true);
    assert.equal(h.calls.length, 0);
    h.scope.fetchPlaylistAllWatchedPage = async () => initial([row('private', false), row('deleted', false)]);
    assert.equal((await h.scope.checkPlaylistAllWatched({ listId: 'PLempty', videoCount: 2 }, 0)).allWatched, false);
  });
  await test('REQ-4 signed out cached entry and mid-flight account change stay visible', async () => {
    const h = boot(), meta = { listId: 'PLtest', videoCount: 1 };
    await h.scope.checkPlaylistAllWatched(meta, 0);
    h.scope.playlistAllWatchedContext = () => null;
    assert.equal(await h.scope.checkPlaylistAllWatched(meta, 0), null);
    assert.equal(h.writes.length, 1);
    const h2 = boot();
    h2.scope.fetchPlaylistAllWatchedPage = async () => {
      h2.scope.playlistAllWatchedContext = () => ({ authUser: '1', accountId: 'other', clientVersion: 'test' });
      return initial([row('aaaaaaaaaaa')]);
    };
    assert.equal(await h2.scope.checkPlaylistAllWatched(meta, 0), null); assert.equal(h2.writes.length, 0);
  });
  await test('REQ-4 logged-out response and failed continuation never cache partial data', async () => {
    for (const mode of ['loggedout', 'continuation', 'loop']) {
      const h = boot(); let n = 0;
      h.scope.fetchPlaylistAllWatchedPage = async () => {
        n++;
        if (mode === 'loggedout') return { ...initial([row('aaaaaaaaaaa')]), responseContext: { mainAppWebResponseContext: { loggedOut: true } } };
        if (n === 1) return initial([row('aaaaaaaaaaa'), continuation('next')]);
        if (mode === 'continuation') throw Error('offline');
        return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [row('aaaaaaaaaaa'), continuation('next')] } }] };
      };
      assert.equal(await h.scope.checkPlaylistAllWatched({ listId: 'PLtest', videoCount: 2 }, 0), null);
      assert.equal(h.writes.length, 0); assert.equal(h.calls.filter(x => x[0] === 'db').length, 0);
    }
  });
  await test('REQ-4 login evidence requires account login flag version and auth cookie', () => {
    const h = boot();
    h.scope.document.documentElement.innerHTML = '"LOGGED_IN":true,"INNERTUBE_CLIENT_VERSION":"test"';
    h.scope.document.cookie = 'SAPISID=synthetic-test-only';
    assert.equal(h.scope.productionContext().accountId, 'account');
    h.scope.document.cookie = ''; assert.equal(h.scope.productionContext(), null);
    h.scope.document.cookie = 'SAPISID=synthetic-test-only';
    h.scope.document.documentElement.innerHTML = '"LOGGED_IN":false,"INNERTUBE_CLIENT_VERSION":"test"';
    assert.equal(h.scope.productionContext(), null);
  });
  await test('REQ-4 live page without LOGGED_IN_USER_ACCOUNT_ID falls back to DATASYNC_ID', () => {
    const h = boot();
    h.scope.getYouTubeSyncContext = () => ({ success: true, authUser: '0', accountId: '' });
    h.scope.document.cookie = 'SAPISID=synthetic-test-only';
    h.scope.document.documentElement.innerHTML = '"LOGGED_IN":true,"INNERTUBE_CLIENT_VERSION":"test"';
    assert.equal(h.scope.productionContext(), null);
    h.scope.document.documentElement.innerHTML = '"LOGGED_IN":true,"INNERTUBE_CLIENT_VERSION":"test","DATASYNC_ID":"sync-id||"';
    assert.equal(h.scope.productionContext().accountId, 'sync-id||');
  });
  await test('REQ-4 live badge class ytBadgeShapeText is read', () => {
    const h = boot();
    const live = { querySelectorAll(selector) {
      if (selector.startsWith('a[')) return [{ href: 'https://www.youtube.com/playlist?list=PLlive' }];
      return selector.split(',').map(s => s.trim()).includes('.ytBadgeShapeText') ? [{ textContent: '33 本の動画' }] : [];
    } };
    assert.equal(h.scope.playlistAllWatchedCardMeta(live)?.videoCount, 33);
  });
  function card(listId = 'PLtest', count = '1 video') {
    return { isConnected: true, dataset: {}, style: { display: '' }, listId, count,
      querySelectorAll(selector) {
        return selector.startsWith('a[') ? [{ href: 'https://www.youtube.com/playlist?list=' + this.listId }] : [{ textContent: this.count }];
      } };
  }
  function displayHarness() {
    const h = boot();
    h.run(read('content.js').match(/  function applyPlaylistCardDisplay\([^]*?\n  }/)[0]);
    return h;
  }
  async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  await test('REQ-3 only intersecting cards queued serially; hide dim and existing policy precedence', async () => {
    const h = displayHarness(), a = card(), b = card('PLsecond'); let calls = 0, inFlight = 0, max = 0, release;
    h.scope.fetchPlaylistAllWatchedPage = async () => {
      calls++; inFlight++; max = Math.max(max, inFlight);
      if (calls === 1) await new Promise(resolve => { release = resolve; });
      inFlight--; return initial([row('aaaaaaaaaaa')]);
    };
    h.scope.applyPlaylistCardDisplay(a); h.scope.applyPlaylistCardDisplay(b);
    assert.equal(calls, 0); assert.equal(h.observed.length, 1);
    h.observed[0].cb([{ target: a, isIntersecting: false }]); await flush(); assert.equal(calls, 0);
    h.observed[0].cb([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }]);
    await flush(); assert.equal(calls, 1);
    release(); await flush(); assert.equal(calls, 2); assert.equal(max, 1);
    assert.equal(a.style.display, 'none'); assert.equal(b.style.display, 'none');
    h.scope.watchedDisplaySettings.dimWatched = true;
    h.scope.applyPlaylistCardDisplay(a); assert.equal(a.style.display, ''); assert.equal(a.dataset.watchedDimmed, 'true');
    h.scope.watchedDisplaySettings.hideCompletedPlaylists = false;
    h.scope.applyPlaylistCardDisplay(a); assert.equal(a.dataset.watchedDimmed, undefined);
    h.scope.watchedDisplaySettings = { hideCompletedPlaylists: true, playlistCardMode: 'hide', playlistCardPlaces: { playlists: true } };
    const c = card('PLthird'); h.scope.applyPlaylistCardDisplay(c);
    assert.equal(c.style.display, 'none'); assert.equal(calls, 2);
  });
  await test('REQ-4 recycled or detached card cannot receive old result; unknown counts skip', async () => {
    for (const mode of ['recycled', 'detached', 'off', 'navigation']) {
      const h = displayHarness(), c = card(); let release;
      h.scope.fetchPlaylistAllWatchedPage = async () => { await new Promise(resolve => { release = resolve; }); return initial([row('aaaaaaaaaaa')]); };
      h.scope.applyPlaylistCardDisplay(c); h.observed[0].cb([{ target: c, isIntersecting: true }]); await flush();
      if (mode === 'recycled') c.listId = 'PLdifferent';
      if (mode === 'detached') c.isConnected = false;
      if (mode === 'off') h.scope.watchedDisplaySettings.hideCompletedPlaylists = false;
      if (mode === 'navigation') { h.scope.location.pathname = '/'; h.scope.resetPlaylistAllWatched(true); }
      release(); await flush(); assert.equal(c.style.display, '');
    }
    const h = boot();
    assert.equal(h.scope.playlistAllWatchedCardMeta(card('PLtest', '1.2K videos')), null);
    assert.equal(h.scope.playlistAllWatchedCardMeta(card('PLtest', '12 本の動画')).videoCount, 12);
    assert.equal(h.scope.playlistAllWatchedCardMeta(card('PLtest', '1,234 videos')).videoCount, 1234);
  });
  await test('REQ-2 on-page memory expires and logout restores card on reprocessing', async () => {
    const h = displayHarness(), c = card();
    h.scope.applyPlaylistCardDisplay(c); h.observed[0].cb([{ target: c, isIntersecting: true }]); await flush();
    assert.equal(c.style.display, 'none');
    h.scope.testCard = c;
    h.run('playlistAllWatchedCards.get(testCard).result.checkedAt -= 7 * 86400000');
    h.scope.applyPlaylistCardDisplay(c); assert.equal(c.style.display, '');
    h.observed[0].cb([{ target: c, isIntersecting: true }]); await flush();
    assert.equal(c.style.display, 'none');
    h.scope.playlistAllWatchedContext = () => null;
    h.scope.applyPlaylistCardDisplay(c); assert.equal(c.style.display, '');
  });
  await test('REQ-3 proxy uses existing authenticated browse boundary with 500ms spacing', async () => {
    const h = boot(), waits = [], messages = [];
    h.scope.setTimeout = (fn, ms) => { waits.push(ms); fn(); };
    h.scope.onMessage = (message, sender, respond) => { messages.push(message); respond({ success: true, data: initial([]) }); };
    const context = h.scope.playlistAllWatchedContext();
    await h.scope.productionFetch({ browseId: 'VLPLtest' }, context, 0);
    await h.scope.productionFetch({ continuation: 'next' }, context, 0);
    assert.equal(messages.length, 2); assert.equal(messages[0].type, 'FETCH_INNERTUBE_BROWSE');
    assert.equal(messages[0].playlistCompletionGeneration, 0);
    assert(waits.some(ms => ms > 450 && ms <= 500));
    h.scope.watchedDisplaySettings.hideCompletedPlaylists = false;
    await assert.rejects(h.scope.productionFetch({}, context, 0)); assert.equal(messages.length, 2);
  });


  await test('REQ-4 actual browse proxy enforces auth and cancellation; HTTP failure stays visible', async () => {
    const h = boot(); let fetches = 0;
    h.scope.AbortController = AbortController;
    h.scope.PROXY_FETCH_TIMEOUT_MS = 25000;
    h.scope.setTimeout = () => 1;
    h.scope.computeSapisidHash = async () => 'synthetic-auth';
    h.scope.fetch = async (url, options) => {
      fetches++;
      assert(url.startsWith('https://www.youtube.com/youtubei/v1/browse?'));
      assert.equal(options.credentials, 'include');
      assert.equal(options.headers.Authorization, 'synthetic-auth');
      assert.equal(options.headers['X-Goog-AuthUser'], '0');
      assert.equal(JSON.parse(options.body).browseId, 'VLPLtest');
      return { ok: true, json: async () => initial([row('aaaaaaaaaaa')]) };
    };
    h.run(read('content.js').match(/  function onMessage\([^]*?\n  }/)[0]);
    const message = { type: 'FETCH_INNERTUBE_BROWSE', authUser: '0', clientVersion: 'test',
      body: { browseId: 'VLPLtest' }, playlistCompletionGeneration: 0 };
    const send = () => new Promise(resolve => h.scope.onMessage(message, {}, resolve));
    assert.equal((await send()).success, true); assert.equal(fetches, 1);
    h.scope.computeSapisidHash = async () => null;
    assert.equal((await send()).success, false); assert.equal(fetches, 1);
    h.scope.computeSapisidHash = async () => { h.scope.resetPlaylistAllWatched(); return 'synthetic-auth'; };
    assert.equal((await send()).success, false); assert.equal(fetches, 1);
    message.playlistCompletionGeneration = 1;
    h.scope.computeSapisidHash = async () => 'synthetic-auth';
    h.scope.fetch = async () => ({ ok: false, status: 503 });
    assert.equal((await send()).reason, 'http-503');
    let signal;
    h.scope.fetch = (url, options) => new Promise((resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })));
    });
    const pending = send(); await flush();
    h.scope.resetPlaylistAllWatched(true);
    assert.equal(signal.aborted, true); assert.equal((await pending).success, false);
  });

  console.log(`${passed} passed, 0 failed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
