/* ============================================================================
   LAST RANK · 界面层（3D 版）
   ----------------------------------------------------------------------------
   棋盘不再是 DOM，而是一块可以转、可以缩的体素战场。
   输入全部走「鼠标 → 射线打在地形表面 → 取整成格子」这一条路。
   左键短按 = 操作；左键拖动 = 旋转视角；右键 = 卖出；滚轮 = 缩放。
   ========================================================================== */
(function () {
  'use strict';

  const E = window.Engine;
  const R = window.Render3D;
  const $ = id => document.getElementById(id);

  const el = {
    terrain: $('hud-terrain'), wave: $('hud-wave'), gold: $('hud-gold'),
    clock: $('hud-clock'), towers: $('hud-towers'),
    tag: $('wave-tag'), waveName: $('wave-name'), waveHint: $('wave-hint'),
    preview: $('enemy-preview'),
    shop: $('shop'), start: $('btn-start'), speed: $('btn-speed'), restart: $('btn-restart'),
    diffs: $('diffs'), relicCard: $('relic-card'), relics: $('relics'),
    viewport: $('viewport'), gl: $('gl'),
    vpTerrain: $('vp-terrain'), vpCam: $('vp-cam'), vpTip: $('vp-tip'),
    log: $('log'), overlay: $('overlay'),
  };

  /* ------------------------------------------------------------- 状态 */

  let st = E.createGame();
  let speed = 1;
  const SPEEDS = [1, 1.5, 2];
  let speedIdx = 0;
  let placeType = null;
  let selId = null;
  let hoverCell = null;
  let timer = null;

  const BEAT_MS = 950;         // 比 2D 版慢很多：3D 需要更多时间读战场

  /* --------------------------------------------------------- 启动 3D */

  R.init(el.gl);
  R.buildTerrain(st);
  R.syncPieces(st, true);
  R.start();

  /* ------------------------------------------------------------ 工具 */

  function findPiece(id) {
    if (id == null) return null;
    return E.allPieces(st).find(p => p.id === id) || null;
  }
  function hoverPiece() {
    if (!hoverCell) return null;
    return E.at(st, hoverCell.x, hoverCell.y);
  }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    R.syncPieces(st);
    const sel = findPiece(selId);
    const focus = hoverPiece() || sel;
    const def = st.phase === 'build' ? E.waveDef(st) : null;
    R.updateMarks(st, {
      focus, sel, placeType, phase: st.phase,
      spawns: def ? def.spawns : null,
    });
    renderHud();
  }

  function renderHud() {
    const def = E.waveDef(st);
    el.terrain.textContent = st.terrain.name;
    el.vpTerrain.textContent = '地形 · ' + st.terrain.name;
    el.wave.textContent = `${st.wave} / ${E.WAVES.length}`;
    el.gold.textContent = st.gold;
    el.clock.textContent = st.phase === 'battle' ? st.clock : '—';
    el.towers.textContent = E.allPieces(st).filter(p => p.side === 'player').length;

    el.tag.textContent = st.phase === 'battle' ? '交战中' : '布阵阶段';
    el.tag.classList.toggle('battle', st.phase === 'battle');
    if (def) { el.waveName.textContent = def.name; el.waveHint.textContent = def.hint; }

    const counts = {};
    if (def) for (const s of def.spawns) counts[s.t] = (counts[s.t] || 0) + 1;
    el.preview.innerHTML = '';
    for (const t in counts) {
      const d = document.createElement('div');
      d.className = 'ep';
      d.innerHTML = `<i>${E.GLYPH[t]}</i><b>${counts[t]}</b>`;
      el.preview.appendChild(d);
    }

    el.start.textContent = st.phase === 'battle' ? '交战中…' : `开始第 ${st.wave} 波`;
    el.start.disabled = st.phase !== 'build';
    el.speed.textContent = `速度 ${SPEEDS[speedIdx]}×`;

    // 商店
    el.shop.innerHTML = '';
    for (const t of ['pawn', 'knight', 'bishop', 'rook', 'queen']) {
      const info = E.PLAYER_KINDS[t];
      const cost = E.priceOf(st, t);
      const b = document.createElement('div');
      b.className = 'shopitem';
      if (st.gold < cost) b.classList.add('poor');
      if (placeType === t) b.classList.add('on');
      b.innerHTML = `<span class="g">${E.GLYPH[t]}</span>
        <span class="meta"><span class="nm">${info.name}</span><span class="cost">${cost} 金</span></span>`;
      b.onclick = () => { if (st.phase !== 'build') return; pickShop(t); };
      b.onmouseenter = () => showTip(`${info.name} · ${cost} 金`, info.blurb);
      b.onmouseleave = hideTip;
      el.shop.appendChild(b);
    }

    // 遗物
    if (st.relics.length) {
      el.relicCard.hidden = false;
      el.relics.innerHTML = '';
      for (const id of st.relics) {
        const r = E.RELICS.find(x => x.id === id);
        const d = document.createElement('div');
        d.className = 'relic';
        d.innerHTML = `<b>${r.name}</b><span>${r.desc}</span>`;
        el.relics.appendChild(d);
      }
    } else el.relicCard.hidden = true;

    // 难度
    el.diffs.innerHTML = '';
    for (const id of ['normal', 'hard', 'nightmare']) {
      const d = E.DIFFICULTIES[id];
      const b = document.createElement('button');
      b.textContent = d.name;
      if (st.diff.id === id) b.classList.add('on');
      b.onclick = () => {
        if (st.diff.id === id) return;
        clearTimeout(timer);
        E.restart(st, { difficulty: id });
        selId = null; placeType = null; hoverCell = null;
        R.reset(st);
        closeOverlay();
        render();
      };
      b.onmouseenter = () => showTip(d.name, `${d.note}\n起手 ${d.gold} 金 · 硬兵血 ×${d.hpMul} · 时间 ×${d.patienceMul}`);
      b.onmouseleave = hideTip;
      el.diffs.appendChild(b);
    }

    // 日志
    const lines = st.log.slice(-5).reverse();
    el.log.innerHTML = '';
    for (const t of lines) {
      const d = document.createElement('div');
      d.textContent = t;
      if (/黑兵.*升变/.test(t)) d.className = 'you-promote';
      else if (/被.*吃掉|输|王被|溃散/.test(t)) d.className = 'you-lost';
      else if (/升变|守住|清空/.test(t)) d.className = 'you-won';
      el.log.appendChild(d);
    }
  }

  function showTip(title, body) {
    el.vpTip.hidden = false;
    el.vpTip.innerHTML = `<b>${title}</b>` +
      String(body).split('\n').map(s => `<span class="d">${s}</span>`).join('');
  }
  function hideTip() { el.vpTip.hidden = true; }

  /* ------------------------------------------------------------ 交互 */

  function pickShop(t) {
    placeType = placeType === t ? null : t;
    selId = null;
    render();
  }

  function onClickCell(x, y) {
    const p = E.at(st, x, y);
    if (st.phase !== 'build') { selId = p && p.side === 'player' ? p.id : null; render(); return; }

    if (placeType) {
      if (p) { placeType = null; selId = p.side === 'player' && p.type !== 'king' ? p.id : null; render(); return; }
      const r = E.buy(st, placeType, x, y);
      if (!r.ok) st.log.push(r.err);
      render();
      return;
    }
    const sp = findPiece(selId);
    if (sp && !p) {
      const r = E.move(st, sp, x, y);
      if (r.ok) { selId = null; render(); return; }
      st.log.push(r.err);
    }
    if (sp && p && p.id === sp.id) { selId = null; render(); return; }
    selId = p && p.side === 'player' && p.type !== 'king' ? p.id : null;
    render();
  }

  function onRightClick(x, y) {
    if (st.phase !== 'build') return;
    const p = E.at(st, x, y);
    if (!p || p.side !== 'player') return;
    const r = E.sell(st, p);
    if (r.ok) st.log.push(`卖出 ${E.PLAYER_KINDS[p.type].name}，回收 ${r.refund} 金。`);
    else st.log.push(r.err);
    if (selId === p.id) selId = null;
    render();
  }

  function updateHover(cell) {
    const changed = (!!cell !== !!hoverCell) ||
      (cell && hoverCell && (cell.x !== hoverCell.x || cell.y !== hoverCell.y));
    if (!changed) return;
    hoverCell = cell;
    R.world.hoverCell = cell;

    if (cell) {
      const h = E.terrainAt(st, cell.x, cell.y);
      const p = E.at(st, cell.x, cell.y);
      if (p) {
        const info = p.side === 'player' ? E.PLAYER_KINDS[p.type] : E.ENEMY_STATS[p.type];
        const extra = p.side === 'enemy' && p.maxHp > 1 ? `（${p.hp}/${p.maxHp} 血）` : '';
        showTip(info.name + extra,
          (p.side === 'player' ? info.blurb : '按象棋规则移动，优先吃最值钱的子。') +
          `\n地形高度 ${h}${p.side === 'player' ? ' · 站得高看得远' : ''}`);
      } else {
        showTip(E.squareName(cell.x, cell.y),
          `地形高度 ${h}` + (h >= 2 ? ' · 会挡住低处的射线' : h >= 1 ? ' · 轻微起伏' : ' · 平地'));
      }
    } else hideTip();
    render();
  }

  function resetCamera() {
    const c = R.world.cam;
    c.az = 0.34; c.el = 0.92; c.dist = 14.2;
    const ce = Math.cos(c.el), se = Math.sin(c.el);
    R.world.camera.position.set(
      c.target.x + c.dist * Math.sin(c.az) * ce,
      c.target.y + c.dist * se,
      c.target.z - c.dist * Math.cos(c.az) * ce);
    R.world.camera.lookAt(c.target);
    el.vpCam.textContent = '拖动旋转 · 滚轮缩放';
  }

  function bindViewport() {
    let dragging = false, moved = 0, lx = 0, ly = 0;

    el.gl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
    });
    addEventListener('mousemove', e => {
      if (dragging) {
        const dx = e.clientX - lx, dy = e.clientY - ly;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 4) { R.orbit(dx, dy); el.vpCam.textContent = '双击重置视角'; }
        lx = e.clientX; ly = e.clientY;
        return;
      }
      updateHover(R.pickCell(e.clientX, e.clientY));
    });
    addEventListener('mouseup', e => {
      if (e.button !== 0) return;
      const wasDrag = moved > 6;
      dragging = false;
      if (wasDrag) return;                       // 拖动过 → 不算点击
      const c = R.pickCell(e.clientX, e.clientY);
      if (c) onClickCell(c.x, c.y);
    });
    el.gl.addEventListener('contextmenu', e => {
      e.preventDefault();
      const c = R.pickCell(e.clientX, e.clientY);
      if (c) onRightClick(c.x, c.y);
    });
    el.gl.addEventListener('mouseleave', () => updateHover(null));
    el.gl.addEventListener('wheel', e => {
      e.preventDefault();
      R.zoom(e.deltaY > 0 ? 1.08 : 0.93);
    }, { passive: false });
    el.gl.addEventListener('dblclick', resetCamera);
  }

  /* ------------------------------------------------------- 战斗循环 */

  function startBattle() {
    const r = E.startWave(st);
    if (!r.ok) { st.log.push(r.err); render(); return; }
    placeType = null; selId = null;
    render();
    scheduleTick();
  }

  function scheduleTick() {
    clearTimeout(timer);
    if (st.phase !== 'battle') return;
    timer = setTimeout(beat, BEAT_MS / speed);
  }

  function beat() {
    if (st.phase !== 'battle') return;
    const ev = E.tick(st);

    R.drawShots(st, ev.shots);
    for (const h of ev.hits) R.spawnBurst(st, h.x, h.y, 0xfff0c0, 0.11, 300);
    for (const k of ev.kills) R.spawnBurst(st, k.x, k.y, 0xff7040, 0.2, 420);
    for (const pr of ev.promotions) R.spawnBurst(st, pr.x, pr.y, 0xff5a30, 0.34, 800);

    render();
    if (st.phase === 'battle') scheduleTick();
    else afterBattle();
  }

  function afterBattle() {
    clearTimeout(timer);
    render();
    if (st.phase === 'reward') setTimeout(showRelicChoice, 520);
    else if (st.phase === 'won' || st.phase === 'lost') setTimeout(showEnd, 520);
  }

  /* ------------------------------------------------------------ 弹层 */

  function closeOverlay() { el.overlay.hidden = true; el.overlay.innerHTML = ''; }

  function showRelicChoice() {
    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `<h2>第 ${st.wave} 波 守住了</h2><p>选择一件遗物，然后进入下一波布阵</p>`;
    const picks = document.createElement('div');
    picks.className = 'picks';
    for (const r of st.offers) {
      const d = document.createElement('div');
      d.className = 'pick';
      d.innerHTML = `<div class="pn">${r.name}</div><div class="pd">${r.desc}</div>`;
      d.onclick = () => { E.takeRelic(st, r.id); closeOverlay(); render(); };
      picks.appendChild(d);
    }
    box.appendChild(picks);
    el.overlay.innerHTML = '';
    el.overlay.appendChild(box);
    el.overlay.hidden = false;
  }

  function showEnd() {
    const won = st.phase === 'won';
    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `
      <h2>${won ? 'LAST RANK 守住了' : '王 被 吃 掉 了'}</h2>
      <p>${won ? '五波敌军全部清空。' : `你在第 ${st.wave} 波倒下了。`}</p>
      <div class="stats">
        <div><label>击杀</label><b>${st.stats.kills}</b></div>
        <div><label>损失棋子</label><b>${st.stats.lost}</b></div>
        <div><label>溃散逃兵</label><b>${st.stats.routed}</b></div>
        <div><label>总节拍</label><b>${st.beat}</b></div>
      </div>
      <button class="primary" id="btn-again">再来一局</button>`;
    el.overlay.innerHTML = '';
    el.overlay.appendChild(box);
    el.overlay.hidden = false;
    box.querySelector('#btn-again').onclick = () => {
      closeOverlay();
      E.restart(st);
      selId = null; placeType = null; hoverCell = null;
      R.reset(st);
      render();
    };
  }

  /* ------------------------------------------------------------ 绑定 */

  el.start.onclick = startBattle;
  el.speed.onclick = () => { speedIdx = (speedIdx + 1) % SPEEDS.length; speed = SPEEDS[speedIdx]; renderHud(); };
  el.restart.onclick = () => {
    clearTimeout(timer);
    E.restart(st);
    selId = null; placeType = null; hoverCell = null;
    R.reset(st);
    closeOverlay();
    render();
  };

  addEventListener('keydown', e => {
    if (e.key === 'Escape') { placeType = null; selId = null; render(); }
    if (e.code === 'Space') { e.preventDefault(); if (st.phase === 'build') startBattle(); }
    const map = { '1': 'pawn', '2': 'knight', '3': 'bishop', '4': 'rook', '5': 'queen' };
    if (map[e.key] && st.phase === 'build') pickShop(map[e.key]);
  });

  new ResizeObserver(() => R.resize()).observe(el.viewport);
  addEventListener('resize', () => R.resize());

  bindViewport();
  R.resize();
  render();

  // 给测试工具留的探针
  window.__game = {
    get state() { return st; },
    render, pickShop, onClickCell, startBattle,
  };
})();
