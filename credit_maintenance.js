(function (root) {
  'use strict';
  function message(key, fallback, values) {
    return typeof historyMessage === 'function' ? historyMessage(key, fallback, values || []) : fallback;
  }
  function heldReason(reason) {
    switch (reason) {
      case 'no-evidence': return message('history_recheckNoEvidence', '記載なし');
      case 'unparsed': return message('history_recheckUnparsed', '解析できない');
      case 'conflict': return message('history_recheckConflict', '競合');
      case 'scope-mismatch': return message('history_recheckScopeMismatch', '曲・版の照合不一致');
      default: return message('history_recheckUnknown', '理由不明');
    }
  }
  function fetchFailure(reason) {
    switch (reason) {
      case 'sorry-redirect': return message('history_recheckBot', 'YouTubeのボット確認により取得できませんでした。時間を空けて再点検してください。');
      case 'video-identity-mismatch': return message('history_recheckIdentity', '取得したページの動画を照合できませんでした。対象の動画を確認してください。');
      case 'no-youtube-tab': return message('history_recheckNoTab', '利用できるYouTubeタブがありません。YouTubeタブを開いて再点検してください。');
      case 'proxy-failed': return message('history_recheckProxy', 'YouTubeタブから応答を取得できませんでした。時間を空けて再点検してください。');
      case 'no-playerResponse': return message('history_recheckNoPlayer', 'ページから動画の再生情報を取得できませんでした。');
      case 'no-videoDetails': return message('history_recheckNoDetails', 'ページから動画の詳細情報を取得できませんでした。');
      case 'no-description': return message('history_recheckNoDescription', 'ページから概要欄を取得できませんでした。');
      case 'timeout': return message('history_recheckTimeout', '取得がタイムアウトしました。時間を空けて再点検してください。');
      case 'aborted': return message('history_recheckAborted', '取得が中止されました。');
      case 'fetch-error': return message('history_recheckNetwork', '通信エラーで取得できませんでした。時間を空けて再点検してください。');
      default:
        if (/^http-\d{3}$/.test(reason || '')) {
          var code = reason.slice(5);
          return message('history_recheckHttp', 'YouTubeがHTTPエラー ' + code + ' を返しました。時間を空けて再点検してください。', [code]);
        }
        return message('history_recheckFetchFailed', '原因を特定できないため取得できませんでした。時間を空けて再点検してください。');
    }
  }
  function create(env) {
    var checked = new Set(), snapshots = new Map(), candidates = new Map();
    var port = null, failed = 0, held = 0;
    var exports = new Map(), exportScopes = new Set();
    var start = document.getElementById('creditRecheckStart');
    var stop = document.getElementById('creditRecheckStop');
    var includeChecked = document.getElementById('creditRecheckIncludeChecked');
    var scope = document.getElementById('creditRecheckScope');
    var limit = document.getElementById('creditRecheckLimit');
    var status = document.getElementById('creditRecheckStatus');
    var issues = document.getElementById('creditRecheckIssues');
    var copy = document.getElementById('creditRecheckCopy');
    var copyStatus = document.getElementById('creditRecheckCopyStatus');
    var save = document.getElementById('creditRecheckSave');
    var adoptAll = document.getElementById('creditRecheckAdoptAll');
    var undoAll = document.getElementById('creditRecheckUndoAll');
    var adopting = false, includeStamped = false;
    var mbToggle = document.getElementById('creditRecheckMb');
    var mbQueue = [], mbRunning = false, mbFound = 0, mbSame = 0, mbDifferent = 0;
    var review = root.CreditReview.create({
      getRecords: function () { return Array.from(snapshots.values()); },
      getMaterials: function () { return { candidates: Array.from(candidates.values()) }; },
      filterItem: function (item) { return item.candidates.some(function (candidate) { return candidate.source === 'description-recheck' || candidate.source === 'musicbrainz-recheck'; }); },
      allowReject: false,
      limit: 1500,
      emptyMessage: message('history_recheckEmpty', '再点検で見つかった変更案をここに表示します。変更案がなくても、すべて正しいと確認できたわけではありません。'),
      saveCreditRole: env.saveCreditRole,
    });
    function controls(running) {
      start.disabled = running; scope.disabled = running; limit.disabled = running; includeChecked.disabled = running;
      stop.disabled = !running;
    }
    // Only roles whose sole proposal came from this recheck; other sources need their own review.
    // Only proposals that add or remove contributors are bulk-adoptable. A change
    // of spelling, case or script may only restyle the same person, and a
    // replacement sharing no name may be another alias; both are reviewed one by one.
    function ownProposal(item, value) {
      var own = item.candidates.filter(function (candidate) { return candidate.source === 'description-recheck'; });
      if (own.length !== 1 || own[0].value !== value) return false;
      var record = snapshots.get(item.videoId);
      if (!record) return true;
      var forward = root.CreditMaintenance.compareNames(record[item.role], value);
      var backward = root.CreditMaintenance.compareNames(value, record[item.role]);
      return forward === 'adds' || backward === 'adds';
    }
    function summary() {
      copy.disabled = checked.size === 0;
      save.disabled = copy.disabled;
      adoptAll.disabled = !!port || adopting || !review.adoptable(ownProposal).length;
      undoAll.disabled = !!port || adopting || !(review.lastBatch && review.lastBatch.length);
      var remaining = root.CreditMaintenance.targets(env.getRecords(), scope.value, checked, 500, root.CreditTarget, includeStamped).length;
      status.textContent = message('history_recheckProgress',
        'このページで点検 ' + checked.size + '件／変更案 ' + candidates.size + '項目／保留 ' + held + '件／取得失敗 ' + failed + '件／未点検 ' + (remaining === 500 ? '500+' : remaining) + '件',
        [checked.size, candidates.size, held, failed, remaining === 500 ? '500+' : remaining]);
      if (mbRunning || mbFound || mbSame || mbDifferent) {
        var mbLeft = mbQueue.length + (mbRunning ? 1 : 0);
        status.textContent += ' ' + message('history_recheckMbProgress',
          'MusicBrainz照合: 残り ' + mbLeft + '件／一致 ' + mbSame + '役割／追加の変更案 ' + mbFound + '項目／名義違い ' + mbDifferent + '役割',
          [mbLeft, mbSame, mbFound, mbDifferent]);
      }
      if (!port) stop.disabled = !mbRunning;
    }
    // Held roles only, and only when the user opted in for this run (privacy policy).
    // The background queue keeps MusicBrainz at one request per second.
    function lookupMb(record) {
      return new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage({ type: 'enrichCreditsMb', artist: record.channel || '', title: record.title || '' }, function (response) {
            void chrome.runtime.lastError;
            resolve(response || null);
          });
        } catch (_error) { resolve(null); }
      });
    }
    function applyMb(job, response) {
      var found = response && response.success && response.candidate;
      var item = exports.get(job.record.videoId);
      if (item) {
        item.musicbrainz = found
          ? { status: 'found', mbid: found.mbid, title: found.mbTitle, stage: found.stage, review: found.manualReviewReason || '',
            composer: found.composer, lyricist: found.lyricist, arranger: found.arranger }
          : { status: response ? (response.reason || 'not-found') : 'error' };
      }
      // A fuzzy title match may be a different song; only strict matches count.
      if (!found || found.stage !== 'strict') return;
      var notes = [];
      job.roles.forEach(function (role) {
        var value = String(found[role] || '').split('・').join(', ');
        if (!value) return;
        var relation = root.CreditMaintenance.compareNames(job.record[role], value);
        if (item && item.roles[role]) item.roles[role].musicbrainz = relation;
        if (relation === 'same') { mbSame++; notes.push(roleLabel(role) + ': ' + message('history_recheckMbSame', '一致')); return; }
        // Only additions are proposed; a different spelling of a person is kept as credited.
        if (relation === 'different') {
          mbDifferent++;
          notes.push(roleLabel(role) + ': ' + message('history_recheckMbDifferent', '名義違い（別名義か別人の可能性） ' + value, [value]));
          return;
        }
        var key = job.record.videoId + ':' + role;
        if (candidates.has(key) || !root.CreditTarget.isValidCreditValue(value, job.record.title)) return;
        candidates.set(key, { videoId: job.record.videoId, role: role, value: value, source: 'musicbrainz-recheck',
          sourceDetail: 'https://musicbrainz.org/recording/' + ((found.roleRecordingIds || {})[role] || found.mbid),
          evidence: 'MusicBrainz: ' + found.mbTitle + (found.manualReviewReason ? ' (' + found.manualReviewReason + ')' : ''),
          selected: false });
        mbFound++;
        notes.push(roleLabel(role) + ': ' + message('history_recheckMbAdds', '追加の変更案'));
      });
      if (notes.length) issue(job.record, 'MusicBrainz: ' + notes.join(' / '), false);
    }
    function roleLabel(role) {
      return role === 'composer' ? message('history_scripts_composer_6', '作曲')
        : role === 'lyricist' ? message('history_scripts_lyricist_7', '作詞') : message('history_scripts_arranger_8', '編曲');
    }
    async function drainMb() {
      mbRunning = true; summary();
      while (mbQueue.length) {
        var job = mbQueue.shift();
        applyMb(job, await lookupMb(job.record));
        review.refreshReviewList(); summary();
      }
      mbRunning = false; summary();
    }
    function issue(record, reason, isHeld) {
      if (isHeld) held++;
      var item = document.createElement('div');
      var link = document.createElement('a');
      link.href = 'https://www.youtube.com/watch?v=' + record.videoId;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = record.title || record.videoId;
      var note = document.createElement('span');
      note.textContent = ' — ' + reason;
      item.append(link, note); issues.appendChild(item);
    }
    function finish(activePort, text) {
      if (port !== activePort) return;
      port = null; controls(false); env.end(); summary();
      if (text) status.textContent += ' ' + text;
    }
    start.addEventListener('click', function () {
      if (port || review.busy.size) return;
      if (!limit.checkValidity()) { limit.reportValidity(); return; }
      var records = root.CreditMaintenance.targets(env.getRecords(), scope.value, checked, limit.value, root.CreditTarget, includeStamped);
      if (!records.length) { summary(); return; }
      if (!env.begin()) {
        status.textContent = message('history_enrich_busy', '他のメンテナンス処理が実行中'); return;
      }
      var batch = new Map(records.map(function (record) { return [record.videoId, structuredClone(record)]; }));
      var batchScope = scope.value;
      var activePort;
      try { activePort = chrome.runtime.connect({ name: 'recheck-credits' }); }
      catch (_error) { env.end(); status.textContent = message('history_recheckConnection', '接続できませんでした。拡張を再読み込みしてから再試行してください。'); return; }
      port = activePort; controls(true); summary();
      activePort.onMessage.addListener(function (data) {
        if (port !== activePort) return;
        if (data.type === 'PROGRESS') {
          var record = batch.get(data.videoId);
          if (!record) return;
          checked.add(record.videoId);
          ['composer', 'lyricist', 'arranger'].forEach(function (role) { candidates.delete(record.videoId + ':' + role); });
          snapshots.set(record.videoId, record);
          var result = data.result;
          exports.set(record.videoId, root.CreditMaintenance.exportItem(record, result, root.CreditTarget));
          exportScopes.add(batchScope);
          copyStatus.textContent = '';
          // Only a successful fetch counts as checked; failures stay targets.
          if (result && result.ok && typeof env.markRechecked === 'function') {
            Promise.resolve(env.markRechecked(record.videoId, root.CreditMaintenance.recheckStamp(record))).catch(function () {});
          }
          if (!result || !result.ok) {
            failed++;
            issue(record, fetchFailure(result && result.reason), false);
          } else {
            var proposed = root.CreditMaintenance.candidates(record, result, root.CreditTarget);
            var changed = new Set(proposed.map(function (candidate) { return candidate.role; }));
            if (proposed.length) {
              // Keep the fetched snapshot for the DB compare-and-swap; refreshing
              // history while scanning must not silently approve a newer value.
              
              proposed.forEach(function (candidate) { candidates.set(candidate.videoId + ':' + candidate.role, candidate); });
            }
            var maintenance = result.maintenance || {};
            var roleLabels = {
              composer: message('history_scripts_composer_6', '作曲'),
              lyricist: message('history_scripts_lyricist_7', '作詞'),
              arranger: message('history_scripts_arranger_8', '編曲')
            };
            var heldRoles = ['composer', 'lyricist', 'arranger'].filter(function (role) {
              return !root.CreditTarget.creditIsBlank(record[role]) && root.CreditTarget.effectiveRoleSource(record, role) !== 'manual'
                && !changed.has(role) && !(maintenance.credits || {})[role];
            }).map(function (role) {
              var reason = heldReason((maintenance.reasons || {})[role]);
              if (root.CreditMaintenance.namesOnTopicLine(record[role], maintenance.topicNames)) {
                reason += message('history_recheckTopicNames', '（概要欄に名前あり・役割は未確認）');
              }
              return message('history_recheckRoleReason', roleLabels[role] + ': ' + reason, [roleLabels[role], reason]);
            });
            if (heldRoles.length) issue(record, heldRoles.join(' / '), true);
            var mbRoles = ['composer', 'lyricist', 'arranger'].filter(function (role) {
              return !root.CreditTarget.creditIsBlank(record[role]) && root.CreditTarget.effectiveRoleSource(record, role) !== 'manual'
                && !changed.has(role) && !(maintenance.credits || {})[role];
            });
            if (mbToggle && mbToggle.checked && mbRoles.length) {
              mbQueue.push({ record: record, roles: mbRoles });
              if (!mbRunning) drainMb();
            }
          }
          review.refreshReviewList(); summary(); return;
        }
        if (data.type === 'DONE') {
          finish(activePort, data.aborted || data.stopped
            ? message('history_recheckStopped', '点検を停止しました。取得済みの変更案は確認できます。')
            : message('history_recheckDone', 'この範囲の点検が完了しました。続けると未点検の動画を調べます。'));
        } else if (data.type === 'ERROR') {
          finish(activePort, message('history_recheckConnection', '接続できませんでした。拡張を再読み込みしてから再試行してください。'));
        }
      });
      activePort.onDisconnect.addListener(function () {
        finish(activePort, message('history_recheckDisconnected', '通信が終了しました。取得済みの変更案は残っています。未点検分は再開できます。'));
      });
      activePort.postMessage({ type: 'START', videoIds: records.map(function (record) { return record.videoId; }) });
    });
    stop.addEventListener('click', function () {
      mbQueue.length = 0;
      if (port) { port.postMessage({ type: 'ABORT' }); stop.disabled = true; }
      summary();
    });
    adoptAll.addEventListener('click', async function () {
      if (port || adopting || !review.adoptable(ownProposal).length) return;
      if (typeof root.confirm === 'function' && !root.confirm(message('history_recheckAdoptAllConfirm',
        '一覧の変更案をまとめて採用します。手動確定値は変更しません。採用した項目は1件ずつ元に戻せます。よろしいですか？'))) return;
      adopting = true; summary();
      copyStatus.textContent = message('history_recheckAdoptAllRunning', 'まとめて採用しています。');
      try {
        var result = await review.adoptAll(ownProposal);
        copyStatus.textContent = result.failed
          ? message('history_recheckAdoptAllPartial', result.adopted + '件を採用しました。採用できなかった' + result.failed + '件は一覧に残っています。', [result.adopted, result.failed])
          : message('history_recheckAdoptAllDone', result.adopted + '件を採用しました。', [result.adopted]);
      } catch (_error) {
        copyStatus.textContent = message('history_recheckAdoptAllFailure', 'まとめて採用を完了できませんでした。一覧で状態を確認してください。');
      } finally {
        adopting = false; summary();
      }
    });
    undoAll.addEventListener('click', async function () {
      if (port || adopting || !(review.lastBatch && review.lastBatch.length)) return;
      if (typeof root.confirm === 'function' && !root.confirm(message('history_recheckUndoAllConfirm',
        'まとめて採用した ' + review.lastBatch.length + '件を元に戻します。よろしいですか？', [review.lastBatch.length]))) return;
      adopting = true; summary();
      copyStatus.textContent = message('history_recheckUndoAllRunning', 'まとめて元に戻しています。');
      try {
        var result = await review.undoBatch();
        copyStatus.textContent = result.failed
          ? message('history_recheckUndoAllPartial', result.undone + '件を元に戻しました。戻せなかった' + result.failed + '件はその後に値が変わっています。', [result.undone, result.failed])
          : message('history_recheckUndoAllDone', result.undone + '件を元に戻しました。', [result.undone]);
      } catch (_error) {
        copyStatus.textContent = message('history_recheckUndoAllFailure', 'まとめて元に戻すことを完了できませんでした。一覧で状態を確認してください。');
      } finally {
        adopting = false; summary();
      }
    });
    // Checking it starts the pass over from the beginning; nothing runs until Start.
    includeChecked.addEventListener('change', function () {
      if (port) { includeChecked.checked = includeStamped; return; }
      includeStamped = includeChecked.checked;
      if (includeStamped) checked.clear();
      copyStatus.textContent = ''; summary();
    });
    function buildReport() {
      // Keep the latest snapshot for every video seen on this page, even
      // after resetting the target queue. Proposals count roles; held/failed
      // count videos, and a proposed video may also have a held role.
      var items = Array.from(exports.values());
      var counts = { checked: items.length, proposals: candidates.size, held: 0, failed: 0 };
      items.forEach(function (item) {
        if (item.status === 'failed') counts.failed++;
        if (Object.values(item.roles).some(function (role) { return !!role.heldReason; })) counts.held++;
      });
      return { version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(),
        scope: exportScopes.has('all') ? 'all' : 'remix', counts: counts, items: items };
    }
    copy.addEventListener('click', async function () {
      if (!checked.size) return;
      try {
        await root.navigator.clipboard.writeText(JSON.stringify(buildReport(), null, 2));
        copyStatus.textContent = message('history_recheckCopySuccess', '結果をコピーしました。');
      } catch (_error) {
        copyStatus.textContent = message('history_recheckCopyFailure', '結果をコピーできませんでした。');
      }
    });
    // A fixed folder under Downloads, so a saved report can be found by path.
    save.addEventListener('click', async function () {
      if (!checked.size) return;
      var url = '';
      try {
        var d = new Date(), pad = function (n) { return String(n).padStart(2, '0'); };
        var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
        url = root.URL.createObjectURL(new root.Blob([JSON.stringify(buildReport(), null, 2)], { type: 'application/json' }));
        await new Promise(function (resolve, reject) {
          chrome.downloads.download({ url: url, filename: 'youtube-watched-hider-reports/credit-recheck-' + stamp + '.json',
            conflictAction: 'uniquify', saveAs: false }, function (downloadId) {
            var error = chrome.runtime.lastError;
            if (error || downloadId == null) reject(new Error(error ? error.message : 'no download id'));
            else resolve(downloadId);
          });
        });
        copyStatus.textContent = message('history_recheckSaveSuccess', '結果をダウンロードフォルダの youtube-watched-hider-reports に保存しました。');
      } catch (_error) {
        copyStatus.textContent = message('history_recheckSaveFailure', '結果を保存できませんでした。');
      } finally {
        if (url) root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 60000);
      }
    });
    scope.addEventListener('change', summary);
    document.getElementById('creditReviewOpen').addEventListener('click', summary);
    controls(false);
    copy.disabled = true;
    save.disabled = true;
    adoptAll.disabled = true;
    undoAll.disabled = true;
    return review;
  }
  root.CreditMaintenanceUI = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
