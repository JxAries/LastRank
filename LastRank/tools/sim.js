/* ============================================================================
   tools/sim.js — 无头模拟器
   目的：在没有浏览器的情况下把引擎跑几千遍，验证
     1. 不崩溃（每一波、每一种随机布阵下）
     2. 棋盘状态永远自洽（无重影、无坐标错位、无孤儿棋子）
     3. 波次难度是否合理（随机布阵 vs 合理布阵的存活率）
   用法： node tools/sim.js
   ========================================================================== */
'use strict';

const E = require('../js/engine.js');
const { W, H, idx } = E;

/* ------------------------------------------------------------ 状态自检 */

function checkInvariants(st, tag) {
  const seen = new Map();
  let count = 0;
  for (let i = 0; i < st.board.length; i++) {
    const p = st.board[i];
    if (!p) continue;
    count++;
    if (seen.has(p.id)) {
      throw new Error(`[${tag}] 棋子 id=${p.id} 同时出现在 ${seen.get(p.id)} 和 ${i}`);
    }
    seen.set(p.id, i);
    if (idx(p.x, p.y) !== i) {
      throw new Error(`[${tag}] 棋子 id=${p.id} 坐标(${p.x},${p.y}) 与格子 ${i} 不一致`);
    }
    if (p.side === 'enemy' && p.hp <= 0) {
      throw new Error(`[${tag}] 0 血敌人 id=${p.id} 还留在棋盘上`);
    }
  }
  const derived = E.allPieces(st).length;
  if (derived !== count) throw new Error(`[${tag}] allPieces 数量 ${derived} != 棋盘计数 ${count}`);
  const king = E.kingOf(st);
  if (!king && st.phase !== 'lost') throw new Error(`[${tag}] 王不见了但游戏没结束 (phase=${st.phase})`);
}

/* ------------------------------------------------------------ 棋盘打印 */

function render(st) {
  const lines = [];
  lines.push('    a b c d e f g h');
  for (let y = H - 1; y >= 0; y--) {
    let row = ` ${y + 1}  `;
    for (let x = 0; x < W; x++) {
      const p = st.board[idx(x, y)];
      if (!p) row += '· ';
      else {
        const g = E.GLYPH[p.type];
        row += (p.side === 'player' ? g.toUpperCase() : g) + ' ';
      }
    }
    lines.push(row);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------ 自动布阵 */

/* ------------------------------------------------------- 贪心 AI 玩家 */
// 一个「会玩的人」的近似：每一波开打前，枚举所有 (棋子, 空格) 组合，
// 用引擎自己的 movesFor() 算出这个棋子能覆盖多少「敌人必经格」，取性价比最高的买。
// 这是量尺——用来判断难度到底靠不靠谱，不是给真人玩的。

const TYPE_WEIGHT = { pawn: 1.0, knight: 1.15, bishop: 1.0, rook: 1.25, queen: 1.3 };

function desiredSquares(st) {
  const want = new Map();                        // flatIdx -> 权重
  const add = (x, y, w) => {
    if (x < 0 || x > 7 || y < 0 || y > 7) return;
    const k = idx(x, y);
    want.set(k, Math.max(want.get(k) || 0, w));
  };
  const def = E.waveDef(st);
  for (const s of def.spawns) {
    for (let y = 0; y <= s.y; y++) {
      add(s.x, y, 1);                            // 敌人要走的直线
      add(s.x - 1, y, 0.8); add(s.x + 1, y, 0.8); // 兵吃子的斜线
    }
    // 它跳/斜插能到的地方
    add(s.x, Math.max(0, s.y - 2), 0.9);
    add(s.x - 2, Math.max(0, s.y - 1), 0.9);
    add(s.x + 2, Math.max(0, s.y - 1), 0.9);
  }
  const k = E.kingOf(st);
  if (k) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) add(k.x + dx, k.y + dy, 2.2);
  return want;
}

function greedyBuild(st) {
  const want = desiredSquares(st);
  let guard = 0;
  while (guard++ < 24) {
    const types = ['pawn', 'knight', 'bishop', 'rook', 'queen'].filter(t => E.priceOf(st, t) <= st.gold);
    if (!types.length) break;
    let best = null;
    for (const t of types) {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 8; x++) {
        if (E.at(st, x, y)) continue;
        const r = E.buy(st, t, x, y);            // 真的放上去，用引擎算覆盖
        if (!r.ok) continue;
        const p = r.piece;
        let cover = 0;
        for (const m of E.movesFor(st, p)) cover += want.get(idx(m.x, m.y)) || 0;
        E.sell(st, p);                            // 立刻撤回，只做评估
        // 越靠前越容易被吃，扣分；否则 AI 会把棋子全推到 y=6 送人头
        const danger = y * 1.6 + (y >= 4 ? 6 : 0);
        const score = cover * (TYPE_WEIGHT[t] || 1) - E.priceOf(st, t) * 0.12 - danger;
        if (!best || score > best.score) best = { t, x, y, score };
      }
    }
    if (!best || best.score <= 0.5) break;
    if (!E.buy(st, best.t, best.x, best.y).ok) break;
  }
  // 兜底：还有钱就再塞便宜棋子，别留着金币不打
  let spare = 0;
  while (st.gold >= E.priceOf(st, 'pawn') && spare++ < 8) {
    const k = E.kingOf(st);
    const spots = [];
    for (let dx = -2; dx <= 2; dx++) for (let dy = 0; dy <= 2; dy++) {
      const x = k.x + dx, y = k.y + dy;
      if (x >= 0 && x < 8 && y >= 0 && y < 7 && !E.at(st, x, y)) spots.push([x, y]);
    }
    if (!spots.length) break;
    const s = spots[spare % spots.length];
    if (!E.buy(st, 'pawn', s[0], s[1]).ok) break;
  }
}

function scriptedBuild(st) {
  for (const [t, x, y] of SCRIPTED_PLAN) {
    if (st.gold < E.priceOf(st, t)) continue;
    if (E.at(st, x, y)) continue;
    E.buy(st, t, x, y);
  }
}

function randomBuild(st, rnd) {
  let guard = 0;
  while (guard++ < 40) {
    const types = ['pawn', 'knight', 'bishop', 'rook', 'queen'].filter(t => E.priceOf(st, t) <= st.gold);
    if (!types.length) break;
    const t = types[Math.floor(rnd() * types.length)];
    E.buy(st, t, Math.floor(rnd() * W), Math.floor(rnd() * (H - 1)));
  }
}

// 「什么都不做」：只靠王硬扛。这条必须 0% —— 否则玩家可以直接拍空格通关。
function idleBuild() { /* 什么都不买 */ }

/* ------------------------------------------------------------ 单局运行 */

function playGame(opts) {
  const rnd = opts.rnd;
  const st = E.createGame({ seed: opts.seed, difficulty: opts.difficulty });
  const build = opts.build;
  let ticks = 0;
  let guard = 0;

  while (st.phase !== 'won' && st.phase !== 'lost' && guard++ < 4000) {
    checkInvariants(st, `wave${st.wave}/${st.phase}`);
    if (st.phase === 'build') {
      build(st, rnd);
      E.startWave(st);
    } else if (st.phase === 'reward') {
      if (!st.offers.length) throw new Error('reward 阶段却没有遗物可选');
      E.takeRelic(st, st.offers[Math.floor(rnd() * st.offers.length)].id);
    } else if (st.phase === 'battle') {
      E.tick(st);
      ticks++;
    } else {
      throw new Error('未知阶段 ' + st.phase);
    }
  }
  if (guard >= 4000) throw new Error('游戏没有终止（可能死循环）');
  checkInvariants(st, 'final');
  return { result: st.phase, wave: st.wave, ticks, st };
}

/* ------------------------------------------------------------ 主流程 */

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function main() {
  console.log('=== LAST RANK 引擎模拟 ===\n');

  // --- 0. 「什么都不做」必须输
  const N_IDLE = 60;
  let winsI = 0, idleReach = {};
  for (let i = 0; i < N_IDLE; i++) {
    const r = playGame({ seed: 300 + i, rnd: seeded(400 + i), build: idleBuild });
    if (r.result === 'won') winsI++;
    idleReach[r.wave] = (idleReach[r.wave] || 0) + 1;
  }
  console.log(`什么都不做  x${N_IDLE}`);
  console.log(`  通关          : ${winsI}  (${(winsI / N_IDLE * 100).toFixed(1)}%)   ← 必须是 0`);
  console.log(`  到达波次分布  : ${JSON.stringify(idleReach)}`);

  // --- 1. 随机布阵压力测试（主要目的是抓崩溃 / 状态错乱）
  const N_RANDOM = 600;
  let crashes = 0, winsR = 0;
  const waveReach = {};
  for (let i = 0; i < N_RANDOM; i++) {
    try {
      const r = playGame({ seed: 1000 + i, rnd: seeded(7000 + i), build: randomBuild });
      if (r.result === 'won') winsR++;
      waveReach[r.wave] = (waveReach[r.wave] || 0) + 1;
    } catch (err) {
      crashes++;
      if (crashes <= 3) console.log('  ✗ ' + err.message);
    }
  }
  console.log(`随机布阵  x${N_RANDOM}`);
  console.log(`  崩溃/状态错乱 : ${crashes}`);
  console.log(`  通关          : ${winsR}  (${(winsR / N_RANDOM * 100).toFixed(1)}%)`);

  // --- 2. 贪心 AI：量「会玩的人」能打到哪
  const N_SMART = 120;
  let winsS = 0, lostAt = {};
  const t0 = Date.now();
  for (let i = 0; i < N_SMART; i++) {
    const r = playGame({ seed: 5000 + i, rnd: seeded(9000 + i), build: greedyBuild });
    if (r.result === 'won') winsS++;
    else lostAt[r.wave] = (lostAt[r.wave] || 0) + 1;
  }
  console.log(`\n贪心 AI 布阵 x${N_SMART}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);  console.log(`  通关          : ${winsS}  (${(winsS / N_SMART * 100).toFixed(1)}%)`);
  console.log(`  失败分布      : ${JSON.stringify(lostAt)}`);

  // --- 2b. 三档难度下的随机布阵通关率
  console.log('\n各难度 · 随机布阵通关率');
  for (const diff of ['normal', 'hard', 'nightmare']) {
    let w = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const r = playGame({ seed: 2000 + i, rnd: seeded(6000 + i), build: randomBuild, difficulty: diff });
      if (r.result === 'won') w++;
    }
    console.log(`  ${E.DIFFICULTIES[diff].name.padEnd(4, '　')}  ${(w / N * 100).toFixed(1)}%`);
  }

  // --- 2b. 随机布阵的失败分布，用来对比「卡在哪一波」
  const lossR = {};
  for (let i = 0; i < N_RANDOM; i++) {
    const r = playGame({ seed: 1000 + i, rnd: seeded(7000 + i), build: randomBuild });
    if (r.result !== 'won') lossR[r.wave] = (lossR[r.wave] || 0) + 1;
  }
  console.log(`  随机布阵失败分布: ${JSON.stringify(lossR)}`);

  // --- 3. 地形视线遮挡：这是「立体塔防」的核心机制，必须证明它真的生效，
  //        而且要证明平原图完全没有遮挡（纯象棋几何的手感不能被破坏）
  console.log('\n地形视线遮挡（把车摆在每一个格子上，统计有多少条射线被山挡住）');
  let plainBlocked = -1;
  for (const key of Object.keys(E.TERRAIN_TEMPLATES)) {
    const st = E.createGame({ terrainSeed: 0 });
    st.terrain = { id: key, name: E.TERRAIN_NAMES[key], heights: E.TERRAIN_TEMPLATES[key].map(r => r.slice()) };
    let blocked = 0, total = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const fake = { x, y, type: 'rook', side: 'player' };
        for (const r of E.rayPaths(st, fake)) {
          total++;
          if (r.stopped && r.stopped.kind === 'terrain') blocked++;
        }
      }
    }
    if (key === 'plain') plainBlocked = blocked;
    console.log(`  ${E.TERRAIN_NAMES[key].padEnd(4, '　')}  ${String(blocked).padStart(4)}/${total}  (${(blocked / total * 100).toFixed(0)}%)`);
  }
  if (plainBlocked === 0) {
    console.log('  ✓ 平原图 0 遮挡 —— 纯象棋几何的手感被保住了');
  } else {
    console.log(`  ✗ 平原图不该有任何遮挡，实际有 ${plainBlocked} 条`);
    process.exitCode = 1;
  }

  // --- 3b. 高地优势：这是整个 3D 方向的核心卖点，必须能直接断言出来
  //         台地图：平地互射被方山挡死；站上方山顶就能越过它打穿全场
  {
    const st2 = E.createGame({ terrainSeed: 0 });
    st2.terrain = {
      id: 'plateau', name: '台地',
      heights: E.TERRAIN_TEMPLATES.plateau.map(r => r.slice()),
    };
    const flatLow = E.terrainBlocks(st2, 7, 3, 0, 3);   // 平地 → 平地，要穿过方山
    const fromTop = E.terrainBlocks(st2, 1, 3, 7, 3);   // 方山顶 → 平地，应该看得见
    console.log('\n高地优势（台地图）');
    console.log(`  平地(7,3) → 平地(0,3)   被山挡住 = ${flatLow}`);
    console.log(`  山顶(1,3) → 平地(7,3)   被山挡住 = ${fromTop}`);
    if (flatLow && !fromTop) {
      console.log('  ✓ 低处打不通，站上高地就打通了 —— 地形真的在改变战术');
    } else {
      console.log('  ✗ 高地优势没有体现出来');
      process.exitCode = 1;
    }
  }

  // --- 4. 完整走一局，肉眼检查节奏
  console.log('\n--- 样板局（贪心 AI）---');
  const st = E.createGame({ seed: 424242 });
  const rnd = seeded(11);
  let guard = 0;
  while (st.phase !== 'won' && st.phase !== 'lost' && guard++ < 500) {
    if (st.phase === 'build') {
      greedyBuild(st);
      console.log(`\n[布阵] 第 ${st.wave} 波 · ${E.waveDef(st).name}  金币=${st.gold}  遗物=[${st.relics.join(',') || '无'}]`);
      console.log(render(st));
      E.startWave(st);
    } else if (st.phase === 'reward') {
      E.takeRelic(st, st.offers[0].id);
    } else {
      E.tick(st);
    }
  }
  console.log(`\n结果: ${st.phase}  到达第 ${st.wave} 波  节拍数=${st.beat}  击杀=${st.stats.kills}  损失=${st.stats.lost}`);
  console.log(render(st));

  console.log('\n=== 模拟结束 ===');
}

main();
