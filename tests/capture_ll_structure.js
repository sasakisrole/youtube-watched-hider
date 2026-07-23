// LL (Liked videos) 応答の「本体配列がどのレンダラ配下に来るか」だけを抽出する診断スニペット。
// 使い方: ログイン済みChromeで https://www.youtube.com/playlist?list=LL を開き、
//   DevTools(F12) → Console に本ファイル全体を貼り付けて Enter。出力(JSON)をそのまま共有。
// PII非送出: 動画タイトル・URL・チャンネル名は一切出さず、レンダラのキー経路と配列長だけを返す。
//
// 判定の要点: itemArrays[].path に "playlistVideoListRenderer" か "richGridRenderer" が
//   含まれていれば = 高評価本体が固有レンダラ(構造アンカー)配下に来る = v1.42.9 のアンカーが効く。
//   含まれず primaryRendererPaths も空 = 本体も汎用 envelope 配下 = 件数fallback依存(最難負け筋)。
(() => {
  const data = window.ytInitialData;
  if (!data) return "ytInitialData not found — 高評価プレイリスト(list=LL)のページで実行してください";

  // 動画アイテムを表す既知レンダラ(名前だけ・中身は見ない)
  const ITEM_KEYS = ['playlistVideoRenderer', 'richItemRenderer', 'lockupViewModel', 'videoRenderer', 'compactVideoRenderer'];
  // 拡張が構造アンカーとして扱う固有レンダラ
  const PRIMARY = ['playlistVideoListRenderer', 'richGridRenderer'];
  // 汎用 envelope（優先材料から除外される想定のもの）
  const ENVELOPE = ['appendContinuationItemsAction', 'reloadContinuationItemsCommand', 'itemSectionRenderer', 'sectionListRenderer'];

  const itemArrays = [];
  const primaryPaths = [];
  const envelopePaths = [];

  function isItemArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    let hit = 0;
    for (const el of arr) {
      if (el && typeof el === 'object' && ITEM_KEYS.some(k => k in el)) hit++;
    }
    return hit > 0 && hit >= arr.length * 0.5;
  }

  function walk(node, path) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (isItemArray(node)) {
        const first = node.find(el => el && typeof el === 'object') || {};
        itemArrays.push({
          path: path.join('.'),
          len: node.length,
          itemKeys: Object.keys(first).slice(0, 4),
          underPrimary: PRIMARY.some(p => path.includes(p)),
        });
      }
      for (let i = 0; i < node.length; i++) walk(node[i], path.concat('[' + i + ']'));
      return;
    }
    for (const k of Object.keys(node)) {
      if (PRIMARY.includes(k)) primaryPaths.push({ renderer: k, path: path.concat(k).join('.') });
      if (ENVELOPE.includes(k)) envelopePaths.push({ envelope: k, path: path.concat(k).join('.') });
      walk(node[k], path.concat(k));
    }
  }

  walk(data, []);

  return JSON.stringify({
    summary: {
      itemArrayCount: itemArrays.length,
      anyUnderPrimary: itemArrays.some(a => a.underPrimary),
      primaryRendererFound: primaryPaths.length > 0,
    },
    itemArrays: itemArrays.slice(0, 25),
    primaryRendererPaths: primaryPaths.slice(0, 25),
    envelopePaths: envelopePaths.slice(0, 25),
  }, null, 2);
})();
