/* ============================================================================
   LAST RANK · 3D 体素渲染层
   ----------------------------------------------------------------------------
   职责：把引擎的状态画成一个可以转、可以缩的体素战场。

   关键设计：地形不是装饰，是玩法 —— 山脊会挡住射线，所以画面上必须能一眼
   看出「这条射线被哪一格的哪一面山挡住了」。射线预览会真的断在山体上。

   命名约定（重要）：调色板叫 PAL，顶点数组叫 vP/vN/vC/vI。
   绝不能让局部变量遮蔽调色板 —— new THREE.Color(undefined) 会静默返回白色，
   整个场景变成一片白且不报任何错。
   ========================================================================== */
(function (root) {
  'use strict';

  const THREE = root.THREE;
  const E = root.Engine;
  const V = root.Voxel;

  /* ---------------------------------------------------------------- 尺度 */

  const W = 8, H = 8;
  const VOXEL = 0.095;          // 单个体素的世界尺寸
  const LEVEL_H = 0.42;         // 地形每层的高度
  const BASE_H = 1.6;           // 棋盘底板的厚度（悬空台地要有实体感）

  const wx = x => x - (W - 1) / 2;      // 格子 → 世界 X
  const wz = y => y - (H - 1) / 2;      // 格子 → 世界 Z（y=0 近相机 = 我方）
  const topAt = (st, x, y) => E.terrainAt(st, x, y) * LEVEL_H;

  /* ---------------------------------------------------------------- 配色 */

  const PAL = {
    skyTop: 0x0f2a40,
    skyMid: 0x2f6d80,
    skyLow: 0xd9b678,
    fog: 0x7396a2,

    rockLow: 0x4c6f59,
    rockMid: 0x6d8070,
    rockHigh: 0x9aa39c,
    soil: 0x3a4a3f,

    tileLight: 0xe9e0c2,    // 棋盘格：骨白
    tileDark: 0x3d6b60,     // 棋盘格：墨绿

    sea: 0x16303c,
    mount: [0x1e3a4a, 0x27485a, 0x2f5266],
    snow: 0x9fb8c4,

    you: 0xece6d6,
    foe: 0x232b31,

    hlCover: 0xfff3d0,
    hlRange: 0x9fb4b0,
    hlPlace: 0xe8b455,
    hlBad: 0xe2603f,
    hlSelect: 0xffd479,
  };

  /* ---------------------------------------------------------------- 状态 */

  const world = {
    scene: null, camera: null, renderer: null, canvas: null,
    terrain: null, pieces: null, fx: null, marks: null, env: null,
    pieceMeshes: new Map(),
    cam: { az: 0.20, el: 0.76, dist: 14.0, target: new THREE.Vector3(0, 0.0, 0.0) },
    beams: [],
    effects: [],
    hoverCell: null,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
  };

  /* ------------------------------------------------------------ 天空贴图 */

  function makeSkyTexture() {
    const cv = document.createElement('canvas');
    cv.width = 8; cv.height = 256;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 256);
    const hex = n => '#' + n.toString(16).padStart(6, '0');
    grd.addColorStop(0.00, hex(PAL.skyTop));
    grd.addColorStop(0.44, hex(0x1d4b66));
    grd.addColorStop(0.66, hex(PAL.skyMid));
    grd.addColorStop(0.84, hex(0x7ba096));
    grd.addColorStop(0.94, hex(PAL.skyLow));
    grd.addColorStop(1.00, hex(0xf2cd90));
    g.fillStyle = grd;
    g.fillRect(0, 0, 8, 256);
    const t = new THREE.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }

  /* ------------------------------------------------------------ 初始化 */

  function init(canvas) {
    world.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    world.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = makeSkyTexture();
    scene.fog = new THREE.Fog(PAL.fog, 26, 64);
    world.scene = scene;

    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400);
    world.camera = camera;

    // 光照预算压在 1.0 附近，否则 Lambert 会把浅色面打爆成纯白：
    // 环境 0.42 + 半球 0.30 + 主光 0.55×dot(≈0.75) + 补光 0.12 ≈ 0.99
    scene.add(new THREE.AmbientLight(0x8fb0c4, 0.42));
    scene.add(new THREE.HemisphereLight(0xbfd8e8, 0x2e3a30, 0.30));

    const sun = new THREE.DirectionalLight(0xffe0b0, 0.55);
    sun.position.set(-10, 14, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 10;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 50;
    sun.shadow.bias = -0.0012;
    scene.add(sun);
    scene.add(sun.target);

    const rim = new THREE.DirectionalLight(0x7fc6e0, 0.12);
    rim.position.set(9, 6, -10);
    scene.add(rim);

    world.pieces = new THREE.Group(); scene.add(world.pieces);
    world.fx = new THREE.Group(); scene.add(world.fx);
    world.marks = new THREE.Group(); scene.add(world.marks);

    buildEnvironment();
    updateCamera();
    resize();
  }

  /* ------------------------------------------------------- 相机 / 交互 */

  function updateCamera() {
    const c = world.cam;
    const ce = Math.cos(c.el), se = Math.sin(c.el);
    world.camera.position.set(
      c.target.x + c.dist * Math.sin(c.az) * ce,
      c.target.y + c.dist * se,
      c.target.z - c.dist * Math.cos(c.az) * ce
    );
    world.camera.lookAt(c.target);
  }

  function orbit(dx, dy) {
    world.cam.az = Math.max(-1.15, Math.min(1.15, world.cam.az + dx * 0.006));
    world.cam.el = Math.max(0.34, Math.min(1.36, world.cam.el + dy * 0.005));
    updateCamera();
  }

  function zoom(f) {
    world.cam.dist = Math.max(8, Math.min(30, world.cam.dist * f));
    updateCamera();
  }

  function resize() {
    const cv = world.canvas;
    const w = cv.clientWidth || 800, h = cv.clientHeight || 600;
    world.renderer.setSize(w, h, false);
    world.camera.aspect = w / h;
    world.camera.updateProjectionMatrix();
  }

  /** 屏幕坐标 → 棋盘格子（打在地形表面取整）。null 表示没打中。 */
  function pickCell(clientX, clientY) {
    const r = world.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    world.pointer.x = ((clientX - r.left) / r.width) * 2 - 1;
    world.pointer.y = -((clientY - r.top) / r.height) * 2 + 1;
    world.raycaster.setFromCamera(world.pointer, world.camera);
    const hits = world.raycaster.intersectObject(world.terrain, false);
    if (!hits.length) return null;
    const p = hits[0].point;
    const x = Math.round(p.x + (W - 1) / 2);
    const y = Math.round(p.z + (H - 1) / 2);
    if (x < 0 || x > W - 1 || y < 0 || y > H - 1) return null;
    return { x, y };
  }

  /* ------------------------------------------------------------ 几何工具 */

  /** 往顶点数组里塞一个四边形（拆成两个三角形） */
  function quad(vP, vN, vC, vI, a, b, c, d, n, col) {
    const base = vP.length / 3;
    for (const v of [a, b, c, d]) {
      vP.push(v[0], v[1], v[2]);
      vN.push(n[0], n[1], n[2]);
      vC.push(col[0], col[1], col[2]);
    }
    vI.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  function rgb(hex, mul) {
    // 防御：new THREE.Color(undefined) 会静默返回白色，让整个场景变成一片白
    // 而且不报任何错。宁可在这里炸掉，也不要再花半小时找"为什么全是白的"。
    if (typeof hex !== 'number') throw new Error('rgb(): 调色板键不存在 → ' + hex);
    const c = new THREE.Color(hex);
    const k = mul == null ? 1 : mul;
    return [c.r * k, c.g * k, c.b * k];
  }

  /* ------------------------------------------------------------ 环境 */
  // 棋盘是一块悬在峡湾上空的台地。相机俯角很陡，所以"地平线"基本看不到，
  // 环境必须放得**近而低**，才能出现在画面边缘当参照物。

  function buildEnvironment() {
    const g = new THREE.Group();

    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.MeshLambertMaterial({ color: PAL.sea })
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -9;
    g.add(sea);

    const rockMat = PAL.mount.map(c => new THREE.MeshLambertMaterial({ color: c }));
    const snowMat = new THREE.MeshLambertMaterial({ color: PAL.snow });

    // 相机俯角很陡（~43°），画面顶边其实已经切到地平线以下，
    // 所以山必须「矮而远」才不会糊在画面顶部变成一大块黑影
    for (let i = 0; i < 34; i++) {
      const h = 5 + ((i * 37) % 9) * 0.75;
      const r = 7 + ((i * 53) % 7);
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5), rockMat[i % 3]);
      const ang = (i / 34) * Math.PI * 2 + (i % 3) * 0.1;
      const rad = 24 + ((i * 29) % 14);
      m.position.set(Math.sin(ang) * rad, -10 + h / 2, Math.cos(ang) * rad);
      m.rotation.y = i * 0.7;
      g.add(m);

      if (h > 9.5) {
        const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.4, h * 0.26, 5), snowMat);
        cap.position.copy(m.position);
        cap.position.y += h * 0.37;
        cap.rotation.y = m.rotation.y;
        g.add(cap);
      }
    }

    world.env = g;
    world.scene.add(g);
    return g;
  }

  /* ------------------------------------------------------------ 地形网格 */

  /**
   * 把 8x8 的高度图编译成一个合并网格。
   * 顶面涂棋盘格（保住象棋可读性），侧面涂岩层（保住地形可读性）。
   * 相邻格高度够高时跳过被遮住的侧面，省掉一大半三角形。
   */
  function buildTerrain(st) {
    if (world.terrain) { world.scene.remove(world.terrain); world.terrain.geometry.dispose(); }

    const vP = [], vN = [], vC = [], vI = [];
    // 越界当作「深不可测」而不是 0 —— 否则边界格的外墙会被 0>=0 判成"被挡住"，
    // 整个棋盘就变成一张没有厚度的纸片浮在空中
    const cellH = (x, y) =>
      (x < 0 || x > W - 1 || y < 0 || y > H - 1) ? -99 : E.terrainAt(st, x, y);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const h = cellH(x, y);
        const y0 = -BASE_H, y1 = h * LEVEL_H;
        const X0 = wx(x) - 0.5, X1 = wx(x) + 0.5;
        const Z0 = wz(y) - 0.5, Z1 = wz(y) + 0.5;

        // --- 侧面（被相邻的高地形挡住就不画）
        const rockHex = h >= 2 ? PAL.rockHigh : h >= 1 ? PAL.rockMid : PAL.rockLow;
        const shade = 0.88 + h * 0.04;
        const west = cellH(x - 1, y), east = cellH(x + 1, y);
        const south = cellH(x, y - 1), north = cellH(x, y + 1);

        if (!(west >= h)) quad(vP, vN, vC, vI, [X0, y0, Z1], [X0, y0, Z0], [X0, y1, Z0], [X0, y1, Z1], [-1, 0, 0], rgb(rockHex, shade));
        if (!(east >= h)) quad(vP, vN, vC, vI, [X1, y0, Z0], [X1, y0, Z1], [X1, y1, Z1], [X1, y1, Z0], [1, 0, 0], rgb(rockHex, shade * 0.97));
        if (!(south >= h)) quad(vP, vN, vC, vI, [X0, y0, Z0], [X1, y0, Z0], [X1, y1, Z0], [X0, y1, Z0], [0, 0, -1], rgb(rockHex, shade * 0.94));
        if (!(north >= h)) quad(vP, vN, vC, vI, [X1, y0, Z1], [X0, y0, Z1], [X0, y1, Z1], [X1, y1, Z1], [0, 0, 1], rgb(rockHex, shade * 1.04));

        // --- 顶面：棋盘格。这是保住"这是个象棋盘"的关键一眼
        const light = (x + y) % 2 === 1;
        const tint = 1 + h * 0.035;
        quad(vP, vN, vC, vI,
          [X0, y1, Z1], [X1, y1, Z1], [X1, y1, Z0], [X0, y1, Z0],
          [0, 1, 0], rgb(light ? PAL.tileLight : PAL.tileDark, tint));
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(vP, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(vN, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(vC, 3));
    g.setIndex(vI);

    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.userData.tris = vI.length / 3;
    world.terrain = mesh;
    world.scene.add(mesh);
    return mesh;
  }

  /* -------------------------------------------------------------- 棋子 */

  function pieceGeometry(type, side) { return V.geometryFor(type, side, VOXEL); }
  function footY(st, p) { return topAt(st, p.x, p.y); }

  function syncPieces(st, hard) {
    const alive = new Set();

    for (const p of E.allPieces(st)) {
      alive.add(p.id);
      let mesh = world.pieceMeshes.get(p.id);
      const geo = pieceGeometry(p.type, p.side);

      if (!mesh) {
        mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { id: p.id, scale: 0.01, tx: null, ty: 0, tz: 0 };
        world.pieces.add(mesh);
        world.pieceMeshes.set(p.id, mesh);
      } else if (mesh.geometry !== geo) {
        mesh.geometry = geo;                  // 升变了，换模型
      }

      const u = mesh.userData;
      const first = u.tx === null;
      u.tx = wx(p.x); u.tz = wz(p.y); u.ty = footY(st, p);
      u.side = p.side; u.type = p.type;
      u.hpFrac = p.maxHp > 1 ? Math.max(0, p.hp / p.maxHp) : 1;
      if (first || hard) mesh.position.set(u.tx, u.ty, u.tz);
    }

    for (const [id, mesh] of Array.from(world.pieceMeshes)) {
      if (alive.has(id)) continue;
      world.pieceMeshes.delete(id);
      world.effects.push({ mesh, t: 0, dur: 340, kind: 'die' });
    }
  }

  /* ------------------------------------------------------------ 高亮标记 */

  const MARK_GEO = new THREE.BoxGeometry(0.84, 0.05, 0.84);
  const MARK_RING_GEO = new THREE.BoxGeometry(0.96, 0.04, 0.96);

  function clearMarks() {
    for (const m of world.marks.children.slice()) {
      world.marks.remove(m);
      if (m.material) m.material.dispose();
    }
  }

  function addMark(x, y, st, color, opacity) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: opacity == null ? 0.5 : opacity, depthWrite: false,
    });
    const m = new THREE.Mesh(MARK_GEO, mat);
    m.position.set(wx(x), topAt(st, x, y) + 0.035, wz(y));
    m.renderOrder = 3;
    world.marks.add(m);
    return m;
  }

  /* ------------------------------------------------------------ 光束 */

  const BEAM_GEO = new THREE.BoxGeometry(1, 1, 1);
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

  function makeBeam(a, b, color, thick, opacity) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return null;
    const m = new THREE.Mesh(BEAM_GEO, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: opacity == null ? 0.9 : opacity, depthWrite: false,
    }));
    m.scale.set(thick, thick, len);
    m.position.copy(a).addScaledVector(dir, 0.5);
    m.lookAt(b);
    m.renderOrder = 4;
    return m;
  }

  function drawShots(st, shots) {
    for (const s of shots) {
      const a = v3(wx(s.fx), topAt(st, s.fx, s.fy) + 0.55, wz(s.fy));
      const b = v3(wx(s.tx), topAt(st, s.tx, s.ty) + 0.45, wz(s.ty));
      const knight = s.type === 'knight';
      const m = makeBeam(a, b, knight ? 0xd8e8ff : 0xfff2cf, knight ? 0.03 : 0.055, 0.95);
      if (!m) continue;
      world.fx.add(m);
      world.beams.push({ mesh: m, t: 0, dur: 280 });
    }
  }

  function spawnBurst(st, x, y, color, size, dur) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(size, 8, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false })
    );
    m.position.set(wx(x), topAt(st, x, y) + 0.5, wz(y));
    world.fx.add(m);
    world.effects.push({ mesh: m, t: 0, dur: dur || 380, kind: 'burst' });
  }

  /* --------------------------------------------------- 射线预览（核心） */

  /**
   * 把选中棋子的每一条射线画出来，**并且真的画到被挡住的那一格为止**。
   * 被山挡住的断点涂红 —— 这是 3D 化之后最重要的一眼可读性。
   */
  function drawRayPreview(st, p) {
    const rays = E.rayPaths(st, p);
    if (!rays.length) return;
    const eye = v3(wx(p.x), topAt(st, p.x, p.y) + 0.55, wz(p.y));

    for (const r of rays) {
      let prev = eye;
      for (let i = 0; i < r.path.length; i++) {
        const cell = r.path[i];
        const last = i === r.path.length - 1;
        const blocked = last && r.stopped && r.stopped.kind === 'terrain';
        const cur = v3(wx(cell.x), topAt(st, cell.x, cell.y) + (blocked ? 0.2 : 0.42), wz(cell.y));
        const col = blocked ? PAL.hlBad
          : (r.stopped && r.stopped.kind === 'friend' && last) ? PAL.hlRange
            : 0xfff0cc;
        const m = makeBeam(prev, cur, col, blocked ? 0.075 : 0.036, blocked ? 0.95 : 0.62);
        if (m) { m.renderOrder = 2; world.marks.add(m); }
        prev = cur;
        if (blocked) break;
      }
      if (r.stopped && r.stopped.kind === 'terrain') addMark(r.stopped.x, r.stopped.y, st, PAL.hlBad, 0.5);
    }
  }

  /* --------------------------------------------------------- 高亮刷新 */

  function updateMarks(st, view) {
    clearMarks();

    if (view.focus && view.focus.side === 'player') {
      const hits = new Set(E.attackSquares(st, view.focus).map(q => E.idx(q.x, q.y)));

      // 「射程」也必须算上地形 —— 否则会在山后面画出其实打不到的格子，
      // 那是骗玩家。射线类走 rayPaths（撞山即止），其余走 movesFor。
      const reach = [];
      const rays = E.rayPaths(st, view.focus);
      if (rays.length) {
        for (const r of rays) {
          for (const c of r.path) {
            const blockedHere = r.stopped && r.stopped.kind === 'terrain' &&
              c.x === r.stopped.x && c.y === r.stopped.y;
            if (!blockedHere) reach.push(c);
          }
        }
      } else {
        for (const m of E.movesFor(st, view.focus)) reach.push(m);
      }
      for (const c of reach) {
        const k = E.idx(c.x, c.y);
        if (!hits.has(k)) addMark(c.x, c.y, st, PAL.hlRange, 0.20);
      }
      for (const k of hits) addMark(k % W, Math.floor(k / W), st, PAL.hlCover, 0.6);
      addMark(view.focus.x, view.focus.y, st, PAL.hlSelect, 0.8);
      drawRayPreview(st, view.focus);
    }

    if (view.phase === 'build') {
      if (view.placeType) {
        for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++)
          if (!E.at(st, x, y)) addMark(x, y, st, PAL.hlPlace, 0.13);
      }
      if (view.sel && view.sel.type !== 'king') {
        for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++)
          if (!E.at(st, x, y)) addMark(x, y, st, 0x7fcf9b, 0.17);
      }
      if (view.spawns) for (const s of view.spawns) addMark(s.x, s.y, st, PAL.hlBad, 0.34);
    }

    if (view.phase === 'battle') {
      const byId = new Map();
      for (const p of E.allPieces(st)) if (p.side === 'player') byId.set(p.id, p);
      for (const id of E.threatenedPieces(st)) {
        const p = byId.get(id);
        if (p) addMark(p.x, p.y, st, PAL.hlBad, 0.6);
      }
      st._threat = E.threatMap(st);
      const seen = new Set();
      for (const e of E.allPieces(st)) {
        if (e.side !== 'enemy' || e.fresh) continue;
        const m = E.enemyChooseMove(st, e);
        if (!m) continue;
        const k = E.idx(m.x, m.y);
        if (seen.has(k)) continue;
        seen.add(k);
        addMark(m.x, m.y, st, PAL.hlBad, 0.32);
      }
    }

    if (world.hoverCell) addMark(world.hoverCell.x, world.hoverCell.y, st, 0xffffff, 0.2);
  }

  /* ------------------------------------------------------------ 每帧 */

  let last = 0;
  function step(now) {
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;

    for (const [, mesh] of world.pieceMeshes) {
      const u = mesh.userData;
      const k = Math.min(1, dt / 90);
      mesh.position.x += (u.tx - mesh.position.x) * k;
      mesh.position.z += (u.tz - mesh.position.z) * k;
      mesh.position.y += (u.ty - mesh.position.y) * k;
      if (u.scale < 1) u.scale = Math.min(1, u.scale + dt / 220);
      const e = 1 - Math.pow(1 - u.scale, 3);
      let s = 0.25 + e * 0.75;
      if (u.side === 'enemy' && u.hpFrac < 1) s *= 1 + Math.sin(now / 90) * 0.03;
      mesh.scale.setScalar(s);
    }

    for (let i = world.beams.length - 1; i >= 0; i--) {
      const b = world.beams[i];
      b.t += dt;
      const k = 1 - b.t / b.dur;
      if (k <= 0) { world.fx.remove(b.mesh); b.mesh.material.dispose(); world.beams.splice(i, 1); }
      else b.mesh.material.opacity = 0.95 * k;
    }

    for (let i = world.effects.length - 1; i >= 0; i--) {
      const e = world.effects[i];
      e.t += dt;
      const k = e.t / e.dur;
      if (k >= 1) {
        if (e.kind === 'die') world.pieces.remove(e.mesh);
        else { world.fx.remove(e.mesh); e.mesh.geometry.dispose(); }
        e.mesh.material.dispose();
        world.effects.splice(i, 1);
        continue;
      }
      if (e.kind === 'die') {
        e.mesh.position.y += dt * 0.0007;
        e.mesh.scale.setScalar((1 - k) * 0.9 + 0.1);
        e.mesh.material.transparent = true;
        e.mesh.material.opacity = 1 - k;
      } else {
        e.mesh.scale.setScalar(0.4 + k * 2.2);
        e.mesh.material.opacity = 0.95 * (1 - k);
      }
    }

    world.renderer.render(world.scene, world.camera);
    requestAnimationFrame(step);
  }

  function start() { requestAnimationFrame(step); }

  function reset(st) {
    for (const [, m] of world.pieceMeshes) world.pieces.remove(m);
    world.pieceMeshes.clear();
    for (const m of world.fx.children.slice()) world.fx.remove(m);
    world.beams.length = 0;
    world.effects.length = 0;
    clearMarks();
    buildTerrain(st);
    syncPieces(st, true);
  }

  root.Render3D = {
    init, start, resize, orbit, zoom, pickCell,
    buildTerrain, syncPieces, updateMarks, drawShots, spawnBurst, reset,
    world, PAL, wx, wz, topAt, LEVEL_H, VOXEL, BASE_H,
  };
})(typeof window !== 'undefined' ? window : globalThis);
