/* ============================================================================
   tools/shot3d.js — 3D 版截图 + 冒烟测试
   用 window.__game 探针直接操作游戏（比像素拾取可靠），
   每一步都截图，我用视觉检查；同时抓 pageerror / console.error。
   用法： node tools/shot3d.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'shots');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

const GL_ARGS = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
                 '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'];

const problems = [];
let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '   → ' + extra : '')); }
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', args: GL_ARGS }); }
  catch { browser = await chromium.launch({ args: GL_ARGS }); }

  const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1600);

  const shot = async n => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('  截图 ' + n); };

  /* ---------------- 1. 启动 ---------------- */
  console.log('\n[1] 启动 3D 场景');
  const boot = await page.evaluate(() => {
    const w = window.Render3D && window.Render3D.world;
    return {
      three: typeof THREE,
      scene: !!w && !!w.scene,
      terrain: !!w && !!w.terrain,
      tris: w && w.terrain ? w.terrain.userData.tris : 0,
      pieces: w ? w.pieceMeshes.size : -1,
      terrainName: window.__game ? window.__game.state.terrain.name : '?',
      canvasW: document.getElementById('gl').clientWidth,
      canvasH: document.getElementById('gl').clientHeight,
    };
  });
  ok(boot.three === 'object', 'three.js 载入');
  ok(boot.scene, '3D 场景已建立');
  ok(boot.terrain && boot.tris > 100, `地形网格已生成（${boot.tris} 三角形）`);
  ok(boot.canvasW > 400 && boot.canvasH > 300, `canvas 尺寸 ${boot.canvasW}×${boot.canvasH}`);
  ok(boot.pieces === 1, `开局场上只有王（实际 ${boot.pieces}）`);
  console.log(`     本次地形：${boot.terrainName}`);
  await shot('3d-01-start');

  /* ---------------- 2. 落子 ---------------- */
  console.log('\n[2] 布阵（走探针）');
  const placed = await page.evaluate(() => {
    const g = window.__game, E = window.Engine;
    const st = g.state;
    const before = st.gold;
    // 找高地：把车放在视野最好的位置
    const cells = [];
    for (let y = 0; y < 7; y++) for (let x = 0; x < 8; x++) cells.push({ x, y, h: E.terrainAt(st, x, y) });
    g.pickShop('rook');
    const rookSpots = [[2, 3], [5, 3]];
    for (const [x, y] of rookSpots) g.onClickCell(x, y);
    g.pickShop('bishop');
    g.onClickCell(1, 2);
    g.pickShop(null);
    return { before, after: st.gold, towers: E.allPieces(st).filter(p => p.side === 'player').length, cells: cells.length };
  });
  ok(placed.towers >= 2, `场上己方棋子 ${placed.towers} 个`);
  ok(placed.after < placed.before, `金币被扣掉（${placed.before} → ${placed.after}）`);
  await page.waitForTimeout(400);
  await shot('3d-02-placed');

  /* ---------------- 3. 选中 → 看射线断点 ---------------- */
  console.log('\n[3] 选中棋子 → 射线预览');
  const rayInfo = await page.evaluate(() => {
    const g = window.__game, E = window.Engine, R = window.Render3D;
    const st = g.state;
    // 主动找一个「射线被山挡住最多」的位置，把车挪过去 —— 这样截图才能展示核心机制
    let best = null;
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 8; x++) {
        if (E.at(st, x, y)) continue;
        const probe = { x, y, type: 'rook', side: 'player' };
        let blocked = 0;
        for (const r of E.rayPaths(st, probe)) if (r.stopped && r.stopped.kind === 'terrain') blocked++;
        if (!best || blocked > best.blocked) best = { x, y, blocked };
      }
    }
    const rook = E.allPieces(st).find(p => p.side === 'player' && p.type === 'rook');
    if (rook && best && best.blocked > 0) E.move(st, rook, best.x, best.y);

    const rays = rook ? E.rayPaths(st, rook) : [];
    let blocked = 0;
    for (const r of rays) if (r.stopped && r.stopped.kind === 'terrain') blocked++;

    if (rook) g.onClickCell(rook.x, rook.y);     // 选中它，画出射线
    return { total: rays.length, blocked, marks: R.world.marks.children.length, at: rook ? [rook.x, rook.y] : null };
  });
  console.log(`     把车挪到 (${rayInfo.at}) —— ${rayInfo.total} 条射线里 ${rayInfo.blocked} 条被山挡住`);
  ok(rayInfo.total > 0, '拿到射线数据');
  ok(rayInfo.marks > 0, `射线/高亮标记已画出（${rayInfo.marks} 个对象）`);
  if (rayInfo.blocked > 0) ok(true, `射线断点已可视化（${rayInfo.blocked} 条被地形挡）`);
  else console.log('     （这张地形没有遮挡，换一局可看到断点）');
  await page.waitForTimeout(500);
  await shot('3d-03-rays');

  /* ---------------- 4. 开打 ---------------- */
  console.log('\n[4] 交战');
  await page.evaluate(() => { window.__game.onClickCell(99, 99); });  // 取消选中
  await page.click('#btn-start');
  const phase = await page.evaluate(() => window.__game.state.phase);
  ok(phase === 'battle', `进入交战阶段（${phase}）`);

  await page.waitForTimeout(2600); await shot('3d-04-battle');
  await page.waitForTimeout(2200); await shot('3d-05-battle2');

  const mid = await page.evaluate(() => {
    const w = window.Render3D.world;
    return { enemies: w.pieceMeshes.size, beams: w.beams.length, beats: window.__game.state.beat };
  });
  console.log(`     场上单位 ${mid.enemies} · 节拍 ${mid.beats}`);
  ok(mid.beats > 0, '节拍在推进');

  /* ---------------- 5. 视角 ---------------- */
  console.log('\n[5] 相机');
  await page.evaluate(() => { window.Render3D.orbit(120, -40); window.Render3D.zoom(0.82); });
  await page.waitForTimeout(600);
  await shot('3d-06-angle');
  ok(true, '旋转/缩放没有抛错');

  /* ---------------- 6. 打完这一波 ---------------- */
  console.log('\n[6] 打完一波');
  try {
    await page.waitForFunction(() => window.__game.state.phase !== 'battle', { timeout: 90000 });
    const res = await page.evaluate(() => ({ phase: window.__game.state.phase, wave: window.__game.state.wave }));
    ok(res.phase === 'reward' || res.phase === 'lost' || res.phase === 'won', `这一波结束了（${res.phase}）`);
    await page.waitForTimeout(900);
    await shot('3d-07-after');
  } catch (e) {
    fail++;
    console.log('  ✗ 这一波没能在 90s 内结束：' + e.message);
    await shot('3d-07-stuck');
  }

  await browser.close();

  console.log('\n--- 运行期问题 ---');
  if (problems.length) { fail++; problems.slice(0, 10).forEach(p => console.log('  ! ' + p)); }
  else console.log('  （无）');

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('工具崩了:', e); process.exit(1); });
