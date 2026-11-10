/* ============================================================================
   LAST RANK  ·  核心引擎（纯逻辑，不碰 DOM）
   ----------------------------------------------------------------------------
   设计前提：
     1. 棋子的「走法」就是塔的「攻击范围」——两者是同一个函数。
     2. 敌我共用同一套规则。敌人不会穿墙，会被自己人堵住（马除外）。
     3. 你的棋子永远只有 1 点血：被吃掉 = 永久损失。敌人的棋子有血量，死了再买。
        → 你方棋子无价，敌方棋子廉价。这就是象棋的隐喻。
     4. 每 beat（节拍）：出生 → 你方开火 → 敌方走一步（吃子 = 走进你的格子）
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 棋盘 */

  const W = 8, H = 8;
  const ENTRY_ROW = 7;          // 敌方底线：出生格，玩家不可布阵
  const ROUT_FINE = 2;          // 每个溃散逃兵扣的金币（击杀是 +1，所以一个敌人价值差 3 金）
  const idx = (x, y) => y * W + x;
  const inB = (x, y) => x >= 0 && x < W && y >= 0 && y < H;

  // x: 0..7 从左到右 = a..h ；y: 0..7 从下到上 = 第1横排..第8横排
  // 你的王固定在 e1 = (4, 0)，敌人从上方（y=7）压下来

  const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ALL8 = ORTHO.concat(DIAG);
  const JUMPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

  const perp = (fx, fy) => [-fy, fx];

  /* ------------------------------------------------------------ 棋子定义 */

  const GLYPH = {
    king: '\u265A', queen: '\u265B', rook: '\u265C',
    bishop: '\u265D', knight: '\u265E', pawn: '\u265F',
  };

  const PLAYER_KINDS = {
    pawn:   { name: '兵', cost: 1, blurb: '攻击两个前斜格。廉价的墙——敌人兵不能正面吃掉它。' },
    knight: { name: '马', cost: 3, blurb: '攻击 8 个「日」字格。唯一无视阻挡的棋子。' },
    bishop: { name: '象', cost: 3, blurb: '沿对角线无限射程，被第一个棋子挡住。' },
    rook:   { name: '车', cost: 4, blurb: '沿横竖无限射程，被第一个棋子挡住。横排上的清道夫。' },
    queen:  { name: '后', cost: 8, blurb: '八个方向无限射程，每个方向可打一个目标。' },
    king:   { name: '王', cost: 0, blurb: '你的核心。攻击周围 8 格。被吃掉就输了。' },
  };

  // 敌方棋子血量（你的塔每 beat 造成 mods.dmg 点伤害）
  const ENEMY_STATS = {
    pawn:   { hp: 1, name: '黑兵' },
    knight: { hp: 2, name: '黑马' },
    bishop: { hp: 2, name: '黑象' },
    rook:   { hp: 4, name: '黑车' },
    queen:  { hp: 8, name: '黑后' },
  };
  const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 };

  /* ------------------------------------------------------------- 难度档 */

  const DIFFICULTIES = {
    normal: {
      id: 'normal', name: '标准', gold: 10, hpMul: 1.0, patienceMul: 1.0, routFine: 2,
      note: '推荐起手。硬兵不会变厚，时间也够用。',
    },
    hard: {
      id: 'hard', name: '困难', gold: 9, hpMul: 1.25, patienceMul: 0.88, routFine: 3,
      note: '马/象/车/后更厚，每波给你的节拍更少。',
    },
    nightmare: {
      id: 'nightmare', name: '噩梦', gold: 8, hpMul: 1.5, patienceMul: 0.75, routFine: 4,
      note: '连黑兵都要打两下，而且时间极紧。',
    },
  };

  /* --------------------------------------------------------------- 地形 */
  // 高度以「层」为单位，0..3。规则只有一条，但它改变了整个游戏：
  //   地形挡视线，不挡走路。
  // 兵可以爬上山，但车不能隔着山打人。站得高看得远是自然涌现的结果——
  // 山顶的塔能俯瞰战场，谷底的塔被自己的地形埋住。

  const EYE = 1.5;            // 射击点高出所在地形顶面的高度（1.5 层 ≈ 棋子的头部）
  const TERRAIN_BLOCK = 0.4;  // 地形顶面高出视线多少就算挡住

  // 每张图是一次跑图的固定谜题：敌人从上方来，你要决定守哪、站多高
  const TERRAIN_TEMPLATES = {
    // 平原：教学图，没有遮挡，纯象棋几何
    plain: [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ],
    // 山脊：横贯中场的山脉，只留两个隘口。要么抢占山脊，要么守隘口
    ridge: [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [1, 0, 2, 2, 2, 0, 1, 0],
      [2, 0, 3, 3, 3, 0, 2, 1],
      [1, 0, 2, 2, 2, 0, 1, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ],
    // 峡谷：两翼高墙夹一条走廊，中央还有一块岩体把走廊劈成两半。
    // 注意：直线插值的视线模型下，**只有凸起的地形才挡视线**，单调上升的缓坡不挡
    //（这是对的：你能看下坡）。所以地形必须有「峰」才产生玩法。
    canyon: [
      [2, 2, 2, 0, 0, 2, 2, 2],
      [2, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 3, 3, 0, 0, 2],
      [2, 0, 0, 3, 3, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 2],
      [2, 2, 2, 0, 0, 2, 2, 2],
    ],
    // 孤峰：散布的石柱，把棋盘切成很多互不相通的视线区
    peaks: [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 2, 0, 0, 0, 0, 2, 0],
      [0, 0, 0, 3, 0, 0, 0, 0],
      [0, 0, 3, 0, 0, 3, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 3, 0, 0, 3, 0, 0],
      [0, 0, 0, 3, 0, 0, 0, 0],
      [0, 2, 0, 0, 0, 0, 2, 0],
    ],
    // 台地：一块 3 层高的方山，四周是平地。
    // 平地互射会被方山挡死；站上方山顶就能越过它打穿全场 —— 高地的价值就出来了
    plateau: [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 3, 3, 3, 0, 0, 0, 0],
      [0, 3, 3, 3, 1, 0, 0, 0],
      [0, 3, 3, 3, 1, 0, 0, 0],
      [0, 1, 1, 1, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ],
  };

  const TERRAIN_NAMES = {
    plain: '平原', ridge: '山脊', canyon: '峡谷', peaks: '孤峰', plateau: '台地',
  };

  function generateTerrain(seed) {
    const keys = Object.keys(TERRAIN_TEMPLATES);
    const k = keys[Math.floor(makeRng(seed)() * keys.length) % keys.length];
    return { id: k, name: TERRAIN_NAMES[k], heights: TERRAIN_TEMPLATES[k].map(r => r.slice()) };
  }

  function terrainAt(st, x, y) {
    if (!st.terrain || !inB(x, y)) return 0;
    return st.terrain.heights[y][x];
  }

  /**
   * 地形是否挡住了 A→B 的视线。
   * 把 A 的射击点连到 B 的射击点，逐格检查中间的地形顶面有没有高过这条连线。
   * 平坦地形永远不挡（顶面 0.4 < 视线 1.0），保住原来的纯象棋手感。
   */
  function terrainBlocks(st, ax, ay, bx, by) {
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    if (n <= 1) return false;
    const eyeA = terrainAt(st, ax, ay) + EYE;
    const eyeB = terrainAt(st, bx, by) + EYE;
    const sx = Math.sign(bx - ax), sy = Math.sign(by - ay);
    for (let i = 1; i < n; i++) {
      const sight = eyeA + (eyeB - eyeA) * (i / n);
      if (terrainAt(st, ax + sx * i, ay + sy * i) + TERRAIN_BLOCK >= sight) return true;
    }
    return false;
  }

  /** 这条射线被地形挡在第几格（返回距离，没被挡返回 -1）。给 UI 画断点用。 */
  function terrainBlockAt(st, ax, ay, bx, by) {
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    if (n <= 1) return -1;
    const eyeA = terrainAt(st, ax, ay) + EYE;
    const eyeB = terrainAt(st, bx, by) + EYE;
    const sx = Math.sign(bx - ax), sy = Math.sign(by - ay);
    for (let i = 1; i < n; i++) {
      const sight = eyeA + (eyeB - eyeA) * (i / n);
      if (terrainAt(st, ax + sx * i, ay + sy * i) + TERRAIN_BLOCK >= sight) return i;
    }
    return -1;
  }

  /* --------------------------------------------------------------- 波次表 */
  // 想调难度直接改这里。y=7 是敌方底线，y=0 是你的底线。

  // patience = 这一波允许的节拍数。超时后残余敌军「溃散」撤退，
  // 每放跑一个倒扣 1 金（击杀是 +1 金，所以一个敌人的价值差是 2 金）。
  // 这条规则同时解决了两个问题：① 被堵死的敌人不会让关卡永远打不完；
  // ② 纯龟缩堵路虽然能活，但经济上必输。
  const WAVES = [
    {
      name: '兵潮', hint: '黑兵只会直着往下走，正面用兵堵住它就行。放任它走到你的底线，它会升变成后。',
      reward: 4, patience: 24,
      spawns: [
        { t: 'pawn', x: 2, y: 7 }, { t: 'pawn', x: 3, y: 7 }, { t: 'pawn', x: 4, y: 7 },
        { t: 'pawn', x: 5, y: 7 }, { t: 'pawn', x: 6, y: 7 },
      ],
    },
    {
      name: '侧翼', hint: '马会跳过你的墙。它的落点能反推出哪几个格子必须有人。',
      reward: 5, patience: 30,
      spawns: [
        { t: 'pawn', x: 0, y: 7 }, { t: 'pawn', x: 1, y: 7 }, { t: 'pawn', x: 2, y: 7 },
        { t: 'pawn', x: 3, y: 7 }, { t: 'pawn', x: 4, y: 7 }, { t: 'pawn', x: 5, y: 7 },
        { t: 'pawn', x: 6, y: 7 }, { t: 'knight', x: 7, y: 7 },
      ],
    },
    {
      name: '斜线', hint: '象走对角线——它不撞你的正面墙，会从侧面斜插进来。',
      reward: 6, patience: 34,
      spawns: [
        { t: 'pawn', x: 0, y: 7 }, { t: 'pawn', x: 1, y: 7 }, { t: 'pawn', x: 2, y: 7 },
        { t: 'pawn', x: 3, y: 7 }, { t: 'pawn', x: 4, y: 7 }, { t: 'pawn', x: 5, y: 7 },
        { t: 'pawn', x: 6, y: 7 }, { t: 'pawn', x: 7, y: 7 },
        { t: 'knight', x: 0, y: 7 }, { t: 'knight', x: 7, y: 7 },
        { t: 'bishop', x: 7, y: 5 }, { t: 'bishop', x: 0, y: 5 },
      ],
    },
    {
      name: '攻城', hint: '黑车沿横排推进。一条横排上放一个车就能整条拦住，但别让两个车互相挡住射线。',
      reward: 7, patience: 40,
      spawns: [
        { t: 'pawn', x: 1, y: 7 }, { t: 'pawn', x: 2, y: 7 }, { t: 'pawn', x: 3, y: 7 },
        { t: 'pawn', x: 4, y: 7 }, { t: 'pawn', x: 5, y: 7 }, { t: 'pawn', x: 6, y: 7 },
        { t: 'knight', x: 0, y: 6 }, { t: 'knight', x: 7, y: 6 },
        { t: 'bishop', x: 0, y: 7 }, { t: 'bishop', x: 7, y: 3 },
        { t: 'rook', x: 0, y: 4 },
      ],
    },
    {
      name: '黑后', hint: '黑后有 8 点血。你需要多条射线同时覆盖它——一个塔永远打不死它。',
      reward: 8, patience: 46,
      spawns: [
        { t: 'pawn', x: 1, y: 7 }, { t: 'pawn', x: 2, y: 7 }, { t: 'pawn', x: 3, y: 7 },
        { t: 'pawn', x: 4, y: 7 }, { t: 'pawn', x: 5, y: 7 }, { t: 'pawn', x: 6, y: 7 },
        { t: 'knight', x: 1, y: 7 }, { t: 'knight', x: 6, y: 7 },
        { t: 'bishop', x: 0, y: 6 }, { t: 'rook', x: 7, y: 4 },
        { t: 'queen', x: 4, y: 7 },
      ],
    },
  ];

  /* --------------------------------------------------------------- 遗物池 */

  const RELICS = [
    { id: 'pierce', name: '破甲箭', desc: '车与后的射线可以穿透敌人（仍会被友军挡住）',
      apply: s => { s.mods.pierce = true; } },
    { id: 'knightRing', name: '马蹄铁', desc: '马 额外攻击紧邻的 8 格',
      apply: s => { s.mods.knightRing = true; } },
    { id: 'kingRange', name: '王权', desc: '王的攻击范围 +1 格（变成 5x5 光环）',
      apply: s => { s.mods.kingRange += 1; } },
    { id: 'discount', name: '征兵法', desc: '所有棋子价格 -1（最低 1 金）',
      apply: s => { s.mods.discount += 1; } },
    { id: 'armor', name: '重甲', desc: '你的每个棋子在每一波都有一次免死',
      apply: s => { s.mods.armor = true; } },
    { id: 'dmg', name: '淬毒', desc: '所有塔伤害 +1',
      apply: s => { s.mods.dmg += 1; } },
    { id: 'income', name: '税赋', desc: '每波开始时额外 +5 金币',
      apply: s => { s.mods.income += 5; } },
    { id: 'refund', name: '回收', desc: '棋子被吃掉时返还一半金币',
      apply: s => { s.mods.refund = 0.5; } },
    { id: 'promote', name: '升变', desc: '兵 每击杀 3 个敌人就升变为后',
      apply: s => { s.mods.promote = 3; } },
  ];

  /* ------------------------------------------------------------ 随机数源 */
  // 用固定种子的 LCG，保证模拟可复现，也方便以后做种子分享

  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* ------------------------------------------------------------ 建局 */

  function createGame(opts) {
    opts = opts || {};
    const diff = DIFFICULTIES[opts.difficulty] || DIFFICULTIES.normal;
    const seed = opts.seed != null ? opts.seed : 20240607;
    const st = {
      board: new Array(W * H).fill(null),
      nextId: 1,
      diff: diff,
      terrain: generateTerrain(opts.terrainSeed != null ? opts.terrainSeed : seed + 977),
      gold: opts.gold != null ? opts.gold : diff.gold,
      wave: 1,
      phase: 'build',            // build | battle | reward | won | lost
      queue: [],
      beat: 0,
      clock: 0,                  // 本波剩余节拍，归零则敌军溃散
      mods: {
        pierce: false, knightRing: false, kingRange: 1,
        discount: 0, armor: false, dmg: 1, income: 0, refund: 0, promote: 0,
      },
      relics: [],
      offers: [],
      rng: makeRng(seed),
      events: { kills: [], hits: [], captures: [], moves: [], spawned: [], shots: [], promotions: [], routed: 0 },
      log: [],
      stats: { kills: 0, lost: 0, goldEarned: 0, routed: 0 },
    };
    // 王固定在 e1
    place(st, { side: 'player', type: 'king', x: 4, y: 0 });
    st.log.push('你的王在 e1。守住它。');
    return st;
  }

  function priceOf(st, type) {
    const base = PLAYER_KINDS[type].cost;
    return type === 'king' ? 0 : Math.max(1, base - st.mods.discount);
  }

  /* ------------------------------------------------------------ 基础工具 */

  function at(st, x, y) { return inB(x, y) ? st.board[idx(x, y)] : null; }

  function place(st, spec) {
    const p = {
      id: st.nextId++, side: spec.side, type: spec.type,
      x: spec.x, y: spec.y, kills: 0, shots: 0, shielded: false, fresh: false,
    };
    if (spec.side === 'enemy') {
      // 用 round 而不是 ceil：hpMul=1.25 时黑兵仍然是 1 血，
      // 只有马/象/车/后变厚 —— 否则整个手感会被改掉
      const base = ENEMY_STATS[spec.type].hp;
      p.maxHp = Math.max(1, Math.round(base * (st.diff ? st.diff.hpMul : 1)));
      p.hp = p.maxHp;
      p.dir = spec.dir || null;
    } else {
      p.maxHp = 1; p.hp = 1;
      p.shielded = st.mods.armor;
    }
    st.board[idx(p.x, p.y)] = p;
    return p;
  }

  function allPieces(st) {
    const out = [];
    for (let i = 0; i < st.board.length; i++) if (st.board[i]) out.push(st.board[i]);
    return out;
  }

  function removePiece(st, p) {
    if (!p) return;
    if (st.board[idx(p.x, p.y)] === p) st.board[idx(p.x, p.y)] = null;
    p.dead = true;
  }

  const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

  function kingOf(st) {
    return allPieces(st).find(p => p.type === 'king' && p.side === 'player') || null;
  }

  /* ============================================================ 走法生成 */
  // 这是整个游戏唯一的规则来源。攻击范围 = 走法落点。两者共用。

  // 玩家方要走的方向（兵）/ 一个棋子能落到的空格
  function forwardOf(st, p) {
    if (p.side === 'player') return [0, 1];
    // 敌方兵：每 beat 重新朝王的方向取主轴
    const k = kingOf(st);
    if (!k) return [0, -1];
    const dx = k.x - p.x, dy = k.y - p.y;
    if (dx === 0) return [0, Math.sign(dy)];
    if (dy === 0) return [Math.sign(dx), 0];
    return Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
  }

  /**
   * 攻击目标：返回所有「被这个棋子攻击到的敌方棋子」。
   * 射线类被第一个棋子挡住（无论敌我）；穿透遗物让它可以穿过敌人。
   */
  function attackTargets(st, p) {
    const out = [];
    const push = (x, y) => {
      if (!inB(x, y)) return;
      const q = st.board[idx(x, y)];
      if (q && q.side !== p.side) out.push(q);
    };

    if (p.type === 'knight') {
      for (const [dx, dy] of JUMPS) push(p.x + dx, p.y + dy);
      if (st.mods.knightRing) for (const [dx, dy] of ALL8) push(p.x + dx, p.y + dy);
      return out;
    }

    if (p.type === 'king') {
      const R = st.mods.kingRange;
      for (let dx = -R; dx <= R; dx++)
        for (let dy = -R; dy <= R; dy++) {
          if (!dx && !dy) continue;
          push(p.x + dx, p.y + dy);
        }
      return out;
    }

    if (p.type === 'pawn') {
      const [fx, fy] = forwardOf(st, p);
      const [ax, ay] = perp(fx, fy);
      push(p.x + ax + fx, p.y + ay + fy);
      push(p.x - ax + fx, p.y - ay + fy);
      return out;
    }

    // 射线类：车 / 象 / 后
    let dirs;
    if (p.type === 'rook') dirs = ORTHO;
    else if (p.type === 'bishop') dirs = DIAG;
    else dirs = ALL8;

    const pierce = st.mods.pierce && p.side === 'player';
    for (const [dx, dy] of dirs) {
      let x = p.x + dx, y = p.y + dy;
      while (inB(x, y)) {
        // 地形挡视线：射线撞上山体就到此为止，山后面的东西看不见也打不到。
        // 注意这是「地形」而不是「棋子」——穿透遗物能穿棋子，但穿不了山。
        if (terrainBlocks(st, p.x, p.y, x, y)) break;
        const q = st.board[idx(x, y)];
        if (q) {
          if (q.side !== p.side) {
            out.push(q);
            if (!pierce) break;
          } else {
            break;                       // 友军永远挡路
          }
        }
        x += dx; y += dy;
      }
    }
    return out;
  }

  /** 这个棋子能移动到的所有格子：[{x,y,capture}]，capture 为敌方棋子时表示吃子 */
  function movesFor(st, p) {
    const out = [];
    const stepEmpty = (x, y) => {
      if (!inB(x, y)) return false;
      if (!st.board[idx(x, y)]) { out.push({ x, y, capture: null }); return true; }
      return false;
    };
    const stepCapture = (x, y) => {
      if (!inB(x, y)) return false;
      const q = st.board[idx(x, y)];
      if (q && q.side !== p.side) { out.push({ x, y, capture: q }); return true; }
      return false;
    };

    if (p.type === 'knight') {
      for (const [dx, dy] of JUMPS) {
        if (!stepCapture(p.x + dx, p.y + dy)) stepEmpty(p.x + dx, p.y + dy);
      }
      return out;
    }
    if (p.type === 'king') {
      for (const [dx, dy] of ALL8) {
        if (!stepCapture(p.x + dx, p.y + dy)) stepEmpty(p.x + dx, p.y + dy);
      }
      return out;
    }
    if (p.type === 'pawn') {
      const [fx, fy] = forwardOf(st, p);
      const [ax, ay] = perp(fx, fy);
      stepEmpty(p.x + fx, p.y + fy);
      stepCapture(p.x + ax + fx, p.y + ay + fy);
      stepCapture(p.x - ax + fx, p.y - ay + fy);
      return out;
    }

    let dirs;
    if (p.type === 'rook') dirs = ORTHO;
    else if (p.type === 'bishop') dirs = DIAG;
    else dirs = ALL8;

    for (const [dx, dy] of dirs) {
      let x = p.x + dx, y = p.y + dy;
      while (inB(x, y)) {
        const q = st.board[idx(x, y)];
        if (q) { if (q.side !== p.side) out.push({ x, y, capture: q }); break; }
        out.push({ x, y, capture: null });
        x += dx; y += dy;
      }
    }
    return out;
  }

  /** 玩家塔的攻击覆盖格（给 UI 画高亮 / 给敌人 AI 躲避用） */
  function attackSquares(st, p) {
    const seen = new Set(), out = [];
    for (const q of attackTargets(st, p)) {
      const k = idx(q.x, q.y);
      if (!seen.has(k)) { seen.add(k); out.push({ x: q.x, y: q.y, piece: q }); }
    }
    return out;
  }

  /** 全图威胁图：被玩家塔覆盖的格子集合（Set of flat idx） */
  function threatMap(st) {
    const s = new Set();
    for (const p of allPieces(st)) {
      if (p.side !== 'player') continue;
      for (const q of attackTargets(st, p)) s.add(idx(q.x, q.y));
    }
    return s;
  }

  /** 你的哪些棋子下一 beat 可能被吃 —— UI 用来标红 */
  function threatenedPieces(st) {
    const bad = new Set();
    for (const e of allPieces(st)) {
      if (e.side !== 'enemy') continue;
      for (const m of movesFor(st, e)) if (m.capture) bad.add(m.capture.id);
    }
    return bad;
  }

  /* ============================================================ 敌方 AI */
  // 完全确定性：优先吃最值钱的，否则朝王靠近，同时轻微躲避你的火力覆盖。

  function enemyChooseMove(st, e) {
    const ms = movesFor(st, e);
    if (!ms.length) return null;
    const k = kingOf(st);

    const caps = ms.filter(m => m.capture);
    if (caps.length) {
      caps.sort((a, b) => {
        const dv = (VALUE[b.capture.type] || 0) - (VALUE[a.capture.type] || 0);
        if (dv) return dv;
        if (!k) return 0;
        return cheb(a.x, a.y, k.x, k.y) - cheb(b.x, b.y, k.x, k.y);
      });
      return caps[0];
    }

    const threat = st._threat || new Set();
    let best = null, bestScore = -Infinity;
    for (const m of ms) {
      let s = -(k ? cheb(m.x, m.y, k.x, k.y) : 0) * 10;
      if (threat.has(idx(m.x, m.y))) s -= 8;   // 轻微躲火力，但不会因此原地不动
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  /* ============================================================ 单 beat */

  function spawnPhase(st) {
    // 每 beat 只放一个敌人进场，形成可读的流水线，而不是一次涌出一堆
    if (!st.queue.length) return;
    const spec = st.queue[0];
    if (st.board[idx(spec.x, spec.y)]) return;      // 入口被堵住，下个 beat 再来
    st.queue.shift();
    const p = place(st, { side: 'enemy', type: spec.t, x: spec.x, y: spec.y, dir: spec.dir });
    p.fresh = true;                                 // 入场当拍不动
    st.events.spawned.push({ x: p.x, y: p.y, type: p.type });
    st.log.push(`${ENEMY_STATS[spec.t].name} 从 ${squareName(spec.x, spec.y)} 进入战场。`);
  }

  function firePhase(st) {
    const towers = allPieces(st).filter(p => p.side === 'player');
    const dmg = new Map();     // 敌人 id -> 本 beat 累计伤害
    const by = new Map();      // 敌人 id -> 打中它的塔（用于「升变」归属）

    for (const t of towers) {
      t.shots = 0;
      const targets = attackTargets(st, t);
      if (!targets.length) continue;
      t.shots = targets.length;
      for (const q of targets) {
        dmg.set(q.id, (dmg.get(q.id) || 0) + st.mods.dmg);
        if (!by.has(q.id)) by.set(q.id, []);
        by.get(q.id).push(t);
        // 记录「谁打谁」，UI 用它在棋盘上画攻击光束
        st.events.shots.push({ fx: t.x, fy: t.y, tx: q.x, ty: q.y, type: t.type });
      }
    }

    // 同时结算：本 beat 的伤害基于开火瞬间的棋盘，不产生连锁
    const dying = [];
    for (const q of allPieces(st)) {
      if (q.side !== 'enemy') continue;
      const d = dmg.get(q.id);
      if (!d) continue;
      q.hp -= d;
      st.events.hits.push({ x: q.x, y: q.y, id: q.id });
      if (q.hp <= 0) dying.push({ q, towers: by.get(q.id) || [] });
    }

    for (const { q, towers: ts } of dying) {
      removePiece(st, q);
      st.stats.kills++;
      st.gold += 1; st.stats.goldEarned += 1;
      st.events.kills.push({ x: q.x, y: q.y, type: q.type });
      if (st.mods.promote) {
        const t = ts.find(z => z.side === 'player' && z.type === 'pawn');
        if (t) {
          t.kills++;
          if (t.kills >= st.mods.promote) {
            t.type = 'queen';
            st.events.promotions.push({ x: t.x, y: t.y, side: 'player' });
            st.log.push('一个兵升变成了后！');
          }
        }
      }
    }
  }

  function enemyPhase(st) {
    st._threat = threatMap(st);
    const k = kingOf(st);
    const enemies = allPieces(st).filter(p => p.side === 'enemy' && !p.fresh);
    enemies.sort((a, b) => {
      const da = k ? cheb(a.x, a.y, k.x, k.y) : 0;
      const db = k ? cheb(b.x, b.y, k.x, k.y) : 0;
      return da - db || a.id - b.id;
    });

    for (const e of enemies) {
      if (e.dead) continue;
      const m = enemyChooseMove(st, e);
      if (!m) continue;
      if (m.capture) {
        const victim = m.capture;
        if (victim.shielded) {
          victim.shielded = false;
          st.log.push(`重甲挡下了对 ${PLAYER_KINDS[victim.type].name} 的一次攻击！`);
          continue;                                   // 攻击被抵消，敌方这步作废
        }
        removePiece(st, victim);
        st.stats.lost++;
        st.events.captures.push({ x: victim.x, y: victim.y, type: victim.type });
        if (st.mods.refund) {
          const back = Math.floor(priceOf(st, victim.type) * st.mods.refund);
          st.gold += back;
        }
        if (victim.type === 'king') {
          st.phase = 'lost';
          st.log.push('王被吃掉了。');
          return;
        }
        st.log.push(`你的 ${PLAYER_KINDS[victim.type].name} 被 ${ENEMY_STATS[e.type].name} 吃掉了。`);
      }
      st.board[idx(e.x, e.y)] = null;
      st.board[idx(m.x, m.y)] = e;
      e.x = m.x; e.y = m.y;

      // 敌兵抵达你的底线 → 升变为黑后。
      // 这条规则同时是「不许什么都不做」的保险丝：你放任不管，底线就会长出后。
      if (e.type === 'pawn' && e.y === 0) {
        e.type = 'queen';
        e.hp = ENEMY_STATS.queen.hp;
        e.maxHp = ENEMY_STATS.queen.hp;
        st.events.promotions.push({ x: e.x, y: e.y, side: 'enemy' });
        st.log.push('黑兵抵达底线，升变为黑后！');
      }

      st.events.moves.push({ id: e.id, x: m.x, y: m.y });
    }
  }

  /** 溃散：节拍耗尽后残余敌军撤退，未能入场的也一并作罢，每个倒扣 1 金 */
  function routPhase(st) {
    const left = allPieces(st).filter(p => p.side === 'enemy');
    const neverCame = st.queue.length;
    st.queue = [];
    if (!left.length && !neverCame) return 0;
    for (const e of left) removePiece(st, e);
    const total = left.length + neverCame;
    const fine = Math.min(st.gold, total * (st.diff ? st.diff.routFine : ROUT_FINE));
    st.gold -= fine;
    st.stats.routed = (st.stats.routed || 0) + total;
    st.log.push(`敌军溃散 —— ${total} 个敌人没能拿下你，掠走 ${fine} 金。`);
    return total;
  }

  function checkWaveEnd(st) {
    if (st.phase !== 'battle') return;
    if (st.queue.length) return;
    if (allPieces(st).some(p => p.side === 'enemy')) return;
    if (st.wave >= WAVES.length) { st.phase = 'won'; st.log.push('全部波次清空。你守住了最后一排。'); return; }
    st.phase = 'reward';
    st.offers = rollRelics(st, 3);
    st.log.push(`第 ${st.wave} 波清空。`);
  }

  function tick(st) {
    if (st.phase !== 'battle') return st.events;
    st.beat++;
    st.events = { kills: [], hits: [], captures: [], moves: [], spawned: [], shots: [], promotions: [], routed: 0 };
    for (const p of allPieces(st)) p.fresh = false;

    spawnPhase(st);
    firePhase(st);

    if (st.phase === 'battle') {
      st.clock--;
      if (st.clock <= 0) {
        st.events.routed = routPhase(st);
        checkWaveEnd(st);
        return st.events;
      }
      enemyPhase(st);
    }
    if (st.phase === 'battle') checkWaveEnd(st);
    return st.events;
  }

  /* ============================================================ 玩家操作 */

  function canPlaceAt(st, x, y) {
    if (st.phase !== 'build') return { ok: false, err: '只能在布阵阶段放置' };
    if (!inB(x, y)) return { ok: false, err: '越界' };
    if (y === ENTRY_ROW) return { ok: false, err: '敌方底线（第 8 横排）不能布阵' };
    if (st.board[idx(x, y)]) return { ok: false, err: '这一格已经有棋子了' };
    return { ok: true };
  }

  function buy(st, type, x, y) {
    const c = canPlaceAt(st, x, y);
    if (!c.ok) return c;
    const cost = priceOf(st, type);
    if (st.gold < cost) return { ok: false, err: '金币不够' };
    st.gold -= cost;
    const p = place(st, { side: 'player', type, x, y });
    return { ok: true, piece: p, cost };
  }

  function sell(st, p) {
    if (st.phase !== 'build') return { ok: false, err: '只能在布阵阶段调整' };
    if (p.type === 'king') return { ok: false, err: '王不能卖' };
    const back = priceOf(st, p.type);
    removePiece(st, p);
    st.gold += back;
    return { ok: true, refund: back };
  }

  function move(st, p, x, y) {
    if (st.phase !== 'build') return { ok: false, err: '只能在布阵阶段调整' };
    if (p.type === 'king') return { ok: false, err: '王不能移动' };
    const c = canPlaceAt(st, x, y);
    if (!c.ok) return c;
    st.board[idx(p.x, p.y)] = null;
    p.x = x; p.y = y;
    st.board[idx(x, y)] = p;
    return { ok: true };
  }

  function startWave(st) {
    if (st.phase !== 'build') return { ok: false, err: '现在不能开始' };
    const def = WAVES[st.wave - 1];
    st.queue = def.spawns.map(s => ({ t: s.t, x: s.x, y: s.y, dir: s.dir || null }));
    st.gold += st.mods.income;
    st.clock = Math.max(6, Math.round(def.patience * (st.diff ? st.diff.patienceMul : 1)));
    for (const p of allPieces(st)) if (p.side === 'player') p.shielded = st.mods.armor;
    st.phase = 'battle';
    st.log.push(`第 ${st.wave} 波 · ${def.name} 开始。`);
    return { ok: true, wave: st.wave, def };
  }

  function rollRelics(st, n) {
    const pool = RELICS.filter(r => !st.relics.includes(r.id));
    const out = [];
    while (out.length < n && pool.length) {
      const i = Math.floor(st.rng() * pool.length);
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  function takeRelic(st, id) {
    const r = RELICS.find(x => x.id === id);
    if (!r) return { ok: false };
    r.apply(st);
    st.relics.push(id);
    st.offers = [];
    st.wave++;
    st.phase = 'build';
    return { ok: true, relic: r };
  }

  function restart(st, opts) {
    const seed = (st.rng() * 1e9) | 0;
    const o = Object.assign({ difficulty: st.diff ? st.diff.id : 'normal' }, opts, { seed });
    const fresh = createGame(o);
    Object.keys(st).forEach(k => delete st[k]);
    Object.assign(st, fresh);
    return st;
  }

  /* --------------------------------------------------------------- 工具 */

  function fileOf(x) { return 'abcdefgh'[x]; }
  function squareName(x, y) { return fileOf(x) + (y + 1); }

  function waveDef(st) { return WAVES[st.wave - 1] || null; }

  function pieceInfo(st, type) { return PLAYER_KINDS[type]; }

  const RAY_TYPES = { rook: 1, bishop: 1, queen: 1 };

  /**
   * 把射线类棋子的每条射线拆成可视化数据 —— 给 3D 光束用。
   * 每条返回 { dx, dy, path:[{x,y}...], stopped:{x,y,kind}|null }
   * kind ∈ terrain | friend | enemy —— UI 用不同颜色画断点。
   * 这是「让你一眼看出山把射线挡在哪」的核心可读性功能。
   */
  function rayPaths(st, p) {
    if (!RAY_TYPES[p.type]) return [];
    const dirs = p.type === 'rook' ? ORTHO : p.type === 'bishop' ? DIAG : ALL8;
    const pierce = st.mods.pierce && p.side === 'player';
    const out = [];
    for (const [dx, dy] of dirs) {
      const path = [];
      let stopped = null;
      let x = p.x + dx, y = p.y + dy;
      while (inB(x, y)) {
        if (terrainBlocks(st, p.x, p.y, x, y)) {
          path.push({ x, y });                       // 射线画到山体上就断
          stopped = { x, y, kind: 'terrain' };
          break;
        }
        const q = st.board[idx(x, y)];
        if (q) {
          if (q.side !== p.side) {
            path.push({ x, y });
            if (!pierce) { stopped = { x, y, kind: 'enemy' }; break; }
          } else {
            stopped = { x, y, kind: 'friend' };
            break;
          }
        } else {
          path.push({ x, y });
        }
        x += dx; y += dy;
      }
      out.push({ dx, dy, path, stopped });
    }
    return out;
  }

  return {
    W, H, ENTRY_ROW, idx, inB, at, fileOf, squareName, cheb,
    GLYPH, PLAYER_KINDS, ENEMY_STATS, VALUE, WAVES, RELICS, DIFFICULTIES,
    TERRAIN_TEMPLATES, TERRAIN_NAMES, generateTerrain, terrainAt, terrainBlocks, terrainBlockAt,
    RAY_TYPES, rayPaths,
    createGame, allPieces, kingOf, priceOf,
    attackTargets, attackSquares, movesFor, threatMap, threatenedPieces,
    enemyChooseMove, tick, startWave, buy, sell, move, takeRelic, restart,
    waveDef, pieceInfo, rollRelics,
  };
});
