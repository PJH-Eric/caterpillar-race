/* ===== themes/tracks-art.js — 六套賽道主題的配色與裝飾（純資料） =====
 * 賽道的形狀在 tracks.js，這裡只管長什麼樣子，方便之後換季或加主題。
 *
 * decor：草地上撒的小裝飾種類，render.js 依 seed 擺放，不影響任何規則。
 */
(function (root) {
  'use strict';

  const THEMES = {
    garden: {
      name: '花園小徑',
      grass: '#8FD46A', grassDark: '#6BB84C', grassAlt: '#A5E07F',
      road: '#D9A86B', roadDark: '#B98748', roadEdge: '#F0E0BC',
      mud: '#7A5A38', boost: '#BFEFFF', sky: '#EAF8D8',
      rock: '#A8B09A', rockDark: '#7C8471',
      sky2: '#9FD8F5', skyLow: '#E8F6FF',
      hill: '#7FB86A', hillDark: '#5E9A52', sun: '#FFF3C4',
      decor: ['flower', 'clover', 'pebble'], night: false
    },
    veggie: {
      name: '菜園迷宮',
      grass: '#7FC45C', grassDark: '#5C9C3F', grassAlt: '#96D473',
      road: '#C79A63', roadDark: '#A67B46', roadEdge: '#E9D6AE',
      mud: '#6B4E2E', boost: '#C6F2D8', sky: '#E4F3D2',
      rock: '#9AA88C', rockDark: '#6F7C64',
      sky2: '#A7DCEF', skyLow: '#EAF7FA',
      hill: '#6FA455', hillDark: '#527F41', sun: '#FFF0B8',
      decor: ['carrot', 'clover', 'pebble'], night: false
    },
    branch: {
      name: '大樹枝幹',
      grass: '#5FA84E', grassDark: '#3F7D36', grassAlt: '#77BC63',
      road: '#B07C4A', roadDark: '#8C5C31', roadEdge: '#DCBE90',
      mud: '#5A3E22', boost: '#D8F3C0', sky: '#D9EEC8',
      rock: '#8C7A5E', rockDark: '#62543F',
      sky2: '#8FC9E8', skyLow: '#DFF0F7',
      hill: '#4F8A46', hillDark: '#366631', sun: '#FFE9B0',
      decor: ['twig', 'acorn', 'clover'], night: false
    },
    pond: {
      name: '水窪淺灘',
      grass: '#84CFA0', grassDark: '#5FAA7E', grassAlt: '#9CDDB3',
      road: '#CDAE86', roadDark: '#AB8B62', roadEdge: '#EFE0C4',
      mud: '#5D5340', boost: '#A9E8FF', sky: '#DDF2EE',
      rock: '#9BAAA6', rockDark: '#6F7E7A',
      sky2: '#9BE0E8', skyLow: '#E6FAFB',
      hill: '#6FAE8C', hillDark: '#4E8668', sun: '#FFF6D2',
      decor: ['reed', 'pebble', 'splash'], night: false
    },
    candy: {
      name: '糖果餅乾',
      grass: '#FFC9E0', grassDark: '#F09DC2', grassAlt: '#FFDCEB',
      road: '#E0A76B', roadDark: '#C08348', roadEdge: '#FFF0CE',
      mud: '#8A5C38', boost: '#FFE9A8', sky: '#FFF0F6',
      rock: '#F5D9E6', rockDark: '#D9AEC6',
      sky2: '#FFC7E4', skyLow: '#FFF0F8',
      hill: '#F6A8CC', hillDark: '#DB80AE', sun: '#FFF7D6',
      decor: ['candy', 'sprinkle', 'cookie'], night: false
    },
    shroom: {
      name: '夜光蘑菇',
      grass: '#2F4A63', grassDark: '#20344A', grassAlt: '#3C5A76',
      road: '#7A6BA8', roadDark: '#584C81', roadEdge: '#B7A6F0',
      mud: '#2A2038', boost: '#8BF0E0', sky: '#1B2A3D',
      rock: '#4A5B72', rockDark: '#32425A',
      sky2: '#243A54', skyLow: '#3A5878',
      hill: '#233B52', hillDark: '#16293B', sun: '#9FF0E4',
      decor: ['shroom', 'glow', 'pebble'], night: true
    },
    beach: {
      name: '海灣大道',
      grass: '#F2DEA8', grassDark: '#D9BF83', grassAlt: '#FBEBC2',
      road: '#C9B187', roadDark: '#A8916A', roadEdge: '#FFF6DE',
      mud: '#8A7048', boost: '#9FE8FF', sky: '#DFF4FF',
      rock: '#C4BBA6', rockDark: '#948B77',
      sky2: '#63C8EE', skyLow: '#DCF5FF',
      hill: '#59B8B0', hillDark: '#3E8F8C', sun: '#FFF4C6',
      decor: ['reed', 'pebble', 'splash'], night: false
    },
    canyon: {
      name: '岩石峽谷',
      grass: '#C4643A', grassDark: '#A04E2B', grassAlt: '#D87A4C',
      road: '#E5B885', roadDark: '#C79A67', roadEdge: '#FFF0D4',
      mud: '#6E4326', boost: '#FFD99A', sky: '#FDE7CE',
      rock: '#9E6A45', rockDark: '#744A2E',
      sky2: '#F0A86A', skyLow: '#FFE6C8',
      hill: '#A9603A', hillDark: '#7E4428', sun: '#FFE1A0',
      decor: ['pebble', 'twig', 'clover'], night: false
    },
    snow: {
      name: '雪地蜿蜒',
      grass: '#F4FAFF', grassDark: '#D7E7F4', grassAlt: '#FFFFFF',
      road: '#9FBBD2', roadDark: '#7C9AB4', roadEdge: '#EAF6FF',
      mud: '#8FA3B5', boost: '#BFF0FF', sky: '#E6F2FC',
      rock: '#B7C6D4', rockDark: '#8B9CAC',
      sky2: '#8FC4E8', skyLow: '#F2FAFF',
      hill: '#B9D3E6', hillDark: '#94B4CD', sun: '#FFFBE8',
      decor: ['pebble', 'twig', 'clover'], night: false
    }
  };

  function get(id) { return THEMES[id] || THEMES.garden; }

  const api = { THEMES, get };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrackArt = api;
})(typeof self !== 'undefined' ? self : this);
