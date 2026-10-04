'use strict';
const vm = require('node:vm');

function install(scope, source) {
  scope.DBClient ||= {};
  scope.location ||= { pathname: '/watch' };
  scope.location.href ||= 'https://www.youtube.com' + scope.location.pathname;
  scope.cancelBulkOperations ||= () => {};
  scope.getCardVideoId ||= card => card.id || 'fixture-video';
  scope.getCurrentVideoId ||= () => 'fixture-current';
  scope.isPlaylistCard ||= () => false;
  const block = source.match(/  \/\/ Page response lifecycle: begin[^]*?  \/\/ Page response lifecycle: end/);
  if (block) vm.runInContext(block[0], scope);
}

function historyDependencies(deps, source) {
  const scope = vm.createContext({ ...deps, location: { pathname: '/feed/history', href: 'https://www.youtube.com/feed/history' } });
  install(scope, source);
  return { capturePageState: scope.capturePageState, isPageStateCurrent: scope.isPageStateCurrent,
    isHistoryPage: () => true };
}

module.exports = { install, historyDependencies };
