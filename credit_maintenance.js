(function (root) {
  'use strict';
  function message(key, fallback, values) {
    return typeof historyMessage === 'function' ? historyMessage(key, fallback, values || []) : fallback;
  }
  function create(env) {
    var checked = new Set(), snapshots = new Map(), candidates = new Map();
    var port = null, failed = 0, held = 0;
    var start = document.getElementById('creditRecheckStart');
    var stop = document.getElementById('creditRecheckStop');
    var reset = document.getElementById('creditRecheckReset');
    var scope = document.getElementById('creditRecheckScope');
    var limit = document.getElementById('creditRecheckLimit');
    var status = document.getElementById('creditRecheckStatus');
    var issues = document.getElementById('creditRecheckIssues');
    var review = root.CreditReview.create({
      getRecords: function () { return Array.from(snapshots.values()); },
      getMaterials: function () { return { candidates: Array.from(candidates.values()) }; },
      filterItem: function (item) { return item.candidates.some(function (candidate) { return candidate.source === 'description-recheck'; }); },
      allowReject: false,
      limit: 1500,
      emptyMessage: message('history_recheckEmpty', '再点検で見つかった変更案をここに表示します。変更案がなくても、すべて正しいと確認できたわけではありません。'),
      saveCreditRole: env.saveCreditRole,
    });
    function controls(running) {
      start.disabled = running; scope.disabled = running; limit.disabled = running; reset.disabled = running;
      stop.disabled = !running;
    }
    function summary() {
      var remaining = root.CreditMaintenance.targets(env.getRecords(), scope.value, checked, 500, root.CreditTarget).length;
      status.textContent = message('history_recheckProgress',
        'このページで点検 ' + checked.size + '件／変更案 ' + candidates.size + '項目／保留 ' + held + '件／取得失敗 ' + failed + '件／未点検 ' + (remaining === 500 ? '500+' : remaining) + '件',
        [checked.size, candidates.size, held, failed, remaining === 500 ? '500+' : remaining]);
    }
    function issue(record, reason) {
      held++;
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
      var records = root.CreditMaintenance.targets(env.getRecords(), scope.value, checked, limit.value, root.CreditTarget);
      if (!records.length) { summary(); return; }
      if (!env.begin()) {
        status.textContent = message('history_enrich_busy', '他のメンテナンス処理が実行中'); return;
      }
      var batch = new Map(records.map(function (record) { return [record.videoId, structuredClone(record)]; }));
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
          if (!result || !result.ok) {
            failed++;
            issue(record, message('history_recheckFetchFailed', '取得できませんでした。YouTubeタブを開き、時間を空けて再点検してください。'));
          } else {
            var proposed = root.CreditMaintenance.candidates(record, result, root.CreditTarget);
            var changed = new Set(proposed.map(function (candidate) { return candidate.role; }));
            if (proposed.length) {
              // Keep the fetched snapshot for the DB compare-and-swap; refreshing
              // history while scanning must not silently approve a newer value.
              
              proposed.forEach(function (candidate) { candidates.set(candidate.videoId + ':' + candidate.role, candidate); });
            }
            var missingEvidence = ['composer', 'lyricist', 'arranger'].some(function (role) {
              return record[role] && root.CreditTarget.effectiveRoleSource(record, role) !== 'manual'
                && !changed.has(role) && !result.maintenance.credits[role];
            });
            if (missingEvidence) issue(record, message('history_recheckHeld', '役割または曲・版を特定できる根拠が不足しています。保存値は変更していません。'));
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
      if (port) { port.postMessage({ type: 'ABORT' }); stop.disabled = true; }
    });
    reset.addEventListener('click', function () {
      if (port) return;
      checked.clear(); summary();
    });
    scope.addEventListener('change', summary);
    document.getElementById('creditReviewOpen').addEventListener('click', summary);
    controls(false);
    return review;
  }
  root.CreditMaintenanceUI = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
