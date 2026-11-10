/* ============================================================================
   LAST RANK · 体素模型
   ----------------------------------------------------------------------------
   每个棋子用「分层字符画」定义：一层一个字符串，'#' 是实心体素，'.' 是空。
   层数组从下往上。这样模型是可读、可手改的，也不需要任何美术资源。

   生成时把成千个体素合并成**一个** BufferGeometry（顶点色烘焙明暗），
   所以每个棋子最终只有 1 个 draw call。
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Voxel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------ 模型定义 */
  // 7x7 足印。层从下到上，字符串下标 = x（右为正），数组下标 = z（前为正）。

  const MODELS = {
    pawn: [
      '..###..',
      '.#####.',
      '#######',
      '..###..',
      '..###..',
      '..###..',
      '.#####.',
      '..###..',
    ],
    rook: [
      '#######',
      '#######',
      '.#####.',
      '.#####.',
      '.#####.',
      '#######',
      '#######',
      '#.###.#',
      '#.###.#',
    ],
    bishop: [
      '#######',
      '#######',
      '.#####.',
      '.#####.',
      '..###..',
      '.#####.',
      '..###..',
      '..###..',
      '.#####.',
      '..###..',
      '...#...',
    ],
    knight: [
      '#######',
      '#######',
      '#######',
      '.#####.',
      '..####.',
      '..####.',
      '..#####',
      '.##.###',
      '.##.##.',
      '..#....',
    ],
    queen: [
      '#######',
      '#######',
      '.#####.',
      '.#####.',
      '..###..',
      '..###..',
      '.#####.',
      '.#####.',
      '..###..',
      '#######',
      '#.###.#',
      '#.###.#',
    ],
    king: [
      '#######',
      '#######',
      '.#####.',
      '.#####.',
      '..###..',
      '..###..',
      '.#####.',
      '..###..',
      '..###..',
      '#######',
      '...#...',
      '..###..',
      '...#...',
    ],
  };

  /* ------------------------------------------------------- 配色 */

  const PALETTE = {
    player: { base: [0.93, 0.90, 0.82], hue: 0.02 },   // 骨白
    enemy:  { base: [0.17, 0.20, 0.23], hue: -0.02 },  // 近黑
  };

  /* ------------------------------------------------------- 几何生成 */

  // 六个面的法线与四个角（局部单位立方体，-0.5..0.5）
  const FACES = [
    { n: [0, 0, 1],  c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], k: 0.92 },
    { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], k: 0.80 },
    { n: [1, 0, 0],  c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], k: 0.86 },
    { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], k: 0.86 },
    { n: [0, 1, 0],  c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], k: 1.0 },
    { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], k: 0.66 },
  ];

  /**
   * 把分层字符画编译成 THREE.BufferGeometry（带顶点色）。
   * @param layers  字符串数组，从下到上
   * @param color   [r,g,b] 0..1 基色
   * @param voxel   单个体素的世界尺寸
   */
  function compile(layers, color, voxel) {
    const P = [], N = [], C = [], I = [];
    const H = layers.length;
    const W = layers[0].length;
    const ox = (W - 1) / 2;                     // 水平居中
    const h = voxel / 2;

    for (let y = 0; y < H; y++) {
      const row = layers[y];
      for (let z = 0; z < row.length; z++) {
        for (let x = 0; x < row.length; x++) {
          if (row[x] !== '#') continue;

          // 只保留「看得见」的体素：被完全包围的体素不生成，
          // 体素数量直接砍掉一半以上
          const solid = (xx, yy, zz) => {
            if (yy < 0 || yy >= H) return false;
            const r = layers[yy];
            if (zz < 0 || zz >= r.length || xx < 0 || xx >= r.length) return false;
            return r[xx] === '#';
          };
          const hidden =
            solid(x + 1, y, z) && solid(x - 1, y, z) &&
            solid(x, y, z + 1) && solid(x, y, z - 1) &&
            solid(x, y + 1, z) && solid(x, y - 1, z);
          if (hidden) continue;

          const cx = (x - ox) * voxel;
          const cy = y * voxel;               // 底部对齐 y=0
          const cz = (z - ox) * voxel;

          // 每个体素一点点随机明暗，避免大片死平
          const jitter = 1 + (((x * 7 + y * 13 + z * 29) % 11) - 5) * 0.012;

          for (const f of FACES) {
            const base = P.length / 3;
            const k = f.k * jitter;
            for (const p of f.c) {
              P.push(cx + p[0] * h, cy + p[1] * h, cz + p[2] * h);
              N.push(f.n[0], f.n[1], f.n[2]);
              C.push(color[0] * k, color[1] * k, color[2] * k);
            }
            I.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setIndex(I);
    g.userData.voxelCount = P.length / 72;
    return g;
  }

  /* ------------------------------------------------------- 缓存 */

  const cache = new Map();

  /** 拿到（棋子类型 + 阵营）的共享几何体。调用方负责 mesh 的缩放/摆放。 */
  function geometryFor(type, side, voxel) {
    const key = type + '|' + side + '|' + voxel;
    if (cache.has(key)) return cache.get(key);
    const layers = MODELS[type] || MODELS.pawn;
    const pal = PALETTE[side] || PALETTE.player;
    const g = compile(layers, pal.base, voxel);
    cache.set(key, g);
    return g;
  }

  /** 未缩放时的原始高度（单位：体素） */
  function heightOf(type) { return (MODELS[type] || MODELS.pawn).length; }

  /** 未缩放时的足迹宽度（单位：体素） */
  function widthOf(type) { return (MODELS[type] || MODELS.pawn)[0].length; }

  function stats() {
    const out = {};
    for (const k in MODELS) out[k] = { layers: MODELS[k].length, w: MODELS[k][0].length };
    return out;
  }

  return { MODELS, PALETTE, compile, geometryFor, heightOf, widthOf, stats };
});
