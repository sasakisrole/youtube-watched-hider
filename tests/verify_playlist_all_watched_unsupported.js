const { assert, boot, initial, row, continuation } = require('./playlist_all_watched_harness');
(async () => {
  const badPages = [
    {}, initial([{ unknownRenderer: {} }]),
    initial([{ playlistVideoRenderer: { videoId: 'aaaaaaaaaaa' } }]),
    { contents: { playlistVideoListRenderer: { contents: [], continuations: [{}] } } },
    initial([row('aaaaaaaaaaa'), continuation('')]),
    initial([continuation('next')]),
    { contents: [initial([]).contents, initial([]).contents] },
  ];
  const h = boot(); let requests = 0;
  h.scope.fetchPlaylistAllWatchedPage = async () => { requests++; return badPages[(requests - 1) % badPages.length]; };
  for (let i = 0; i < badPages.length; i++) {
    const meta = { listId: 'PLbad' + i, videoCount: 1 };
    const result = await h.scope.checkPlaylistAllWatched(meta, 0);
    assert.equal(result?.unsupported, true, 'shape error is cached unsupported');
    assert.equal(result.allWatched, false);
    assert.equal(result.unwatchedCount, null);
    assert.equal(h.run('playlistAllWatchedFailures'), 0);
    await h.scope.checkPlaylistAllWatched(meta, 0);
    assert.equal(requests, i + 1, 'fresh unsupported cache avoids fetching');
  }
  assert.equal(h.writes.length, badPages.length);
  assert.equal(h.calls.filter(x => x[0] === 'db').length, 0);
  await h.scope.checkPlaylistAllWatched({ listId: 'PLbad0', videoCount: 2 }, 0);
  assert.equal(requests, badPages.length + 1, 'count change refetches');
  Object.values(h.stored).forEach(v => v.checkedAt -= 7 * 86400000);
  await h.scope.checkPlaylistAllWatched({ listId: 'PLbad0', videoCount: 2 }, 0);
  assert.equal(requests, badPages.length + 2, 'seven days refetches');
  h.scope.fetchPlaylistAllWatchedPage = async () => initial([row('aaaaaaaaaaa')]);
  assert.equal((await h.scope.checkPlaylistAllWatched({ listId: 'PLnormal', videoCount: 1 }, 0)).allWatched, true);
  for (const mode of ['network', 'http', 'logout', 'db', 'incomplete-db']) {
    const f = boot(); let attempts = 0;
    f.scope.fetchPlaylistAllWatchedPage = async () => {
      attempts++;
      if (mode === 'network' || mode === 'http') throw Error(mode);
      if (mode === 'logout') return { responseContext: { mainAppWebResponseContext: { loggedOut: true } } };
      return initial([row('aaaaaaaaaaa')]);
    };
    if (mode === 'db') f.scope.DBClient.checkMultiple = async () => { throw Error('db'); };
    if (mode === 'incomplete-db') f.scope.DBClient.checkMultiple = async () => ({});
    for (let i = 0; i < 5; i++) assert.equal(await f.scope.checkPlaylistAllWatched({ listId: 'PLfail', videoCount: 1 }, 0), null);
    assert.equal(attempts, 3, mode + ' stops after three failures');
    assert.equal(f.writes.length, 0);
    f.scope.resetPlaylistAllWatched();
    await f.scope.checkPlaylistAllWatched({ listId: 'PLfail', videoCount: 1 }, 1);
    assert.equal(attempts, 3, 'settings reset does not release breaker');
  }
  console.log('PASS REQ-6 unsupported caching, expiry, continued processing and failure breaker');
})().catch(e => { console.error(e); process.exitCode = 1; });
