/* 诊断：地形为什么是白的。直接读几何体顶点色 + 采样渲染像素 + 报告材质。 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const ARGS = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
              '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ARGS });
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const R = window.Render3D, THREE = window.THREE;
    const t = R.world.terrain;
    const g = t.geometry;
    const col = g.getAttribute('color');
    const pos = g.getAttribute('position');
    const out = {
      hasColorAttr: !!col,
      colorCount: col ? col.count : 0,
      posCount: pos ? pos.count : 0,
      matType: t.material.type,
      matVertexColors: t.material.vertexColors,
      matColor: t.material.color.getHexString(),
      rendererEncoding: R.world.renderer.outputEncoding,
      THREE_rev: THREE.REVISION,
    };
    if (col) {
      let mn = [9, 9, 9], mx = [-9, -9, -9], sum = [0, 0, 0];
      for (let i = 0; i < col.count; i++) {
        for (let c = 0; c < 3; c++) {
          const v = col.array[i * 3 + c];
          if (v < mn[c]) mn[c] = v;
          if (v > mx[c]) mx[c] = v;
          sum[c] += v;
        }
      }
      out.colorMin = mn.map(v => +v.toFixed(3));
      out.colorMax = mx.map(v => +v.toFixed(3));
      out.colorMean = sum.map(v => +(v / col.count).toFixed(3));
    }
    // 灯光总量
    let amb = 0, hemi = 0, dirs = [];
    R.world.scene.traverse(o => {
      if (o.isAmbientLight) amb += o.intensity;
      if (o.isHemisphereLight) hemi += o.intensity;
      if (o.isDirectionalLight) dirs.push({ i: o.intensity, p: o.position.toArray().map(v => +v.toFixed(1)) });
    });
    out.ambient = amb; out.hemi = hemi; out.dirs = dirs;
    out.camPos = R.world.camera.position.toArray().map(v => +v.toFixed(1));
    return out;
  });

  console.log(JSON.stringify(info, null, 2));

  // 采样画布中心偏下的像素（应该是棋盘顶面）
  const px = await page.evaluate(() => {
    const cv = document.getElementById('gl');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    const w = cv.width, h = cv.height;
    const buf = new Uint8Array(4);
    const pts = [[0.42, 0.62], [0.55, 0.7], [0.5, 0.5], [0.35, 0.4]];
    return pts.map(([fx, fy]) => {
      gl.readPixels(Math.floor(w * fx), Math.floor(h * (1 - fy)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2]];
    });
  });
  console.log('画布采样像素 (RGB):', JSON.stringify(px));

  await browser.close();
})();
