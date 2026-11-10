/* 探针：验证无头浏览器能不能真的渲染 WebGL 并截图。
   如果这一步不通过，整个 3D 方向就没法验证，必须先解决。 */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const args = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
                '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'];
  const browser = await chromium.launch({ channel: 'msedge', args });
  const page = await browser.newPage({ viewport: { width: 720, height: 520 } });

  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.setContent('<!doctype html><html><body style="margin:0;background:#111"></body></html>');
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'vendor/three.min.js'), 'utf8') });

  const info = await page.evaluate(() => {
    const out = { three: typeof THREE, rev: THREE && THREE.REVISION, webgl: null, renderer: null };
    if (!THREE) return out;
    const cv = document.createElement('canvas');
    out.webgl = !!(cv.getContext('webgl2') || cv.getContext('webgl'));
    try {
      const sc = new THREE.Scene();
      sc.background = new THREE.Color(0x1b3a52);
      const cam = new THREE.PerspectiveCamera(45, 720 / 520, 0.1, 200);
      cam.position.set(5, 6, 8);
      cam.lookAt(0, 0, 0);
      const r = new THREE.WebGLRenderer({ antialias: true });
      r.setSize(720, 520);
      r.shadowMap.enabled = true;
      document.body.appendChild(r.domElement);
      sc.add(new THREE.AmbientLight(0xffffff, 0.55));
      const dl = new THREE.DirectionalLight(0xfff0d0, 1.15);
      dl.position.set(6, 10, 5);
      sc.add(dl);
      // 几个体素方块，模拟真实场景的复杂度
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mats = [0xe8b455, 0x5d7f78, 0xdcd5c0].map(c => new THREE.MeshLambertMaterial({ color: c }));
      for (let x = -3; x <= 3; x++) {
        for (let z = -3; z <= 3; z++) {
          const h = Math.round(1 + 2 * Math.abs(Math.sin(x * 0.7) * Math.cos(z * 0.6)));
          for (let y = 0; y < h; y++) {
            const m = new THREE.Mesh(geo, mats[(x + z + y) % 3]);
            m.position.set(x, y + 0.5, z);
            sc.add(m);
          }
        }
      }
      r.render(sc, cam);
      out.renderer = r.getContext() ? 'ctx-ok' : 'ctx-fail';
      out.drawn = sc.children.length;
    } catch (e) {
      out.renderer = 'throw: ' + e.message;
    }
    return out;
  });

  console.log('THREE:      ' + info.three + '  r' + info.rev);
  console.log('WebGL 支持: ' + info.webgl);
  console.log('渲染器:     ' + info.renderer);
  console.log('场景对象数: ' + info.drawn);

  await page.screenshot({ path: path.join(OUT, 'probe3d.png') });
  console.log('截图:       shots/probe3d.png');
  console.log('错误:       ' + (errs.length ? errs.slice(0, 4).join(' | ') : '（无）'));

  await browser.close();
  process.exit(info.renderer === 'ctx-ok' && !errs.length ? 0 : 1);
})().catch(e => { console.error('探针崩了:', e); process.exit(1); });
