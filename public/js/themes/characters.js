/* ===== themes/characters.js — 八隻毛毛蟲（純資料） =====
 *
 * 能力完全相同，只差外觀。真正的向量圖形在 render.js 手繪
 * （頭 ＋ 分節身體 ＋ 小腳 ＋ 觸角，漸層做立體感，不是圓球加臉）。
 * 這裡只放可替換的配色與花紋參數，方便之後加更多隻。
 *
 * pattern：dot 圓點｜stripe 橫條｜heart 愛心｜wave 波浪｜star 星星｜check 格子｜leaf 葉子｜tri 三角
 * 八隻的「顏色」與「花紋」都不重複，就算色盲或畫面縮很小也分得出是誰。
 */
(function (root) {
  'use strict';

  const CHARACTERS = [
    {
      id: 'lime', name: '小綠', pattern: 'dot', shape: 'circle',
      body: '#8BD44A', bodyDark: '#4F9420', bodyLight: '#C6F08C',
      belly: '#EAFBD0', mark: '#3C7A14', horn: '#F7D64A', eye: '#2E2A22'
    },
    {
      id: 'tangerine', name: '阿橘', pattern: 'stripe', shape: 'square',
      body: '#FF8A1F', bodyDark: '#C45A05', bodyLight: '#FFC98A',
      belly: '#FFEFD6', mark: '#B4530A', horn: '#7ED0F5', eye: '#3A2716'
    },
    {
      id: 'berry', name: '莓莓', pattern: 'heart', shape: 'heart',
      body: '#FF7A9A', bodyDark: '#C93C63', bodyLight: '#FFC0D0',
      belly: '#FFE6EC', mark: '#AB2647', horn: '#8BD44A', eye: '#3B1F27'
    },
    {
      id: 'sky', name: '藍波', pattern: 'wave', shape: 'drop',
      body: '#5FB8F0', bodyDark: '#1F76B8', bodyLight: '#AEE0FB',
      belly: '#E2F4FE', mark: '#15578B', horn: '#FFD54A', eye: '#1E2E3A'
    },
    {
      id: 'grape', name: '小紫', pattern: 'star', shape: 'star',
      body: '#A886E8', bodyDark: '#6B48B5', bodyLight: '#D6C4F6',
      belly: '#F0E9FD', mark: '#4F3092', horn: '#9BE36A', eye: '#2A2038'
    },
    {
      id: 'butter', name: '奶油', pattern: 'check', shape: 'diamond',
      body: '#FFDD63', bodyDark: '#D9A916', bodyLight: '#FFF0AE',
      belly: '#FFFAE0', mark: '#A87F05', horn: '#FF8FA8', eye: '#3B3418'
    },
    {
      id: 'mint', name: '薄荷', pattern: 'leaf', shape: 'leaf',
      body: '#3FD79B', bodyDark: '#149268', bodyLight: '#A4F2D2',
      belly: '#E4FBF4', mark: '#12735C', horn: '#FFB4A2', eye: '#1F3630'
    },
    {
      id: 'cocoa', name: '可可', pattern: 'tri', shape: 'triangle',
      body: '#C08B5C', bodyDark: '#8A5A2E', bodyLight: '#E7C39A',
      belly: '#F6E7D5', mark: '#6A3F19', horn: '#9BD1FF', eye: '#2E2118'
    }
  ];

  const BY_ID = {};
  for (const c of CHARACTERS) BY_ID[c.id] = c;

  function get(id) { return BY_ID[id] || CHARACTERS[0]; }

  const api = { CHARACTERS, BY_ID, get };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Characters = api;
})(typeof self !== 'undefined' ? self : this);
