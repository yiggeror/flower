// -----------------------------------------------------------------------------
// 《花》— 网页端 3D 体验
// 一群飘浮的花瓣掠过起伏的草原，所到之处开出花来。
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { env } from './core/env.js';
import { Heightfield } from './world/heightfield.js';
import { createTerrain } from './world/terrain.js';
import { createSky } from './world/sky.js';
import { BloomMap } from './world/bloommap.js';
import { Grass } from './world/grass.js';
import { Flowers } from './world/flowers.js';
import { Weather } from './world/weather.js';
import { PetalFlock } from './entities/petals.js';
import { Input } from './core/input.js';
import { CameraRig } from './core/camerarig.js';
import { PostFX } from './post/composer.js';

const qs = new URLSearchParams(location.search);
const num = (k, d) => (qs.has(k) ? parseFloat(qs.get(k)) : d);
const has = (k) => qs.has(k);

const status = (t) => { const e = document.getElementById('status'); if (e) e.textContent = t; };
const progress = (p) => { const e = document.querySelector('#bar i'); if (e) e.style.width = (p * 100) + '%'; };
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// 画质档位：手机与低端 GPU 会自动降档，高端则升回来
const TIERS = [
  { grass: 0.30, flowers: 0.34, atmos: 0.34, csteps: 18, lsteps: 3, msteps: 8,  rain: 0.4 },
  { grass: 0.52, flowers: 0.55, atmos: 0.40, csteps: 24, lsteps: 4, msteps: 10, rain: 0.6 },
  { grass: 0.76, flowers: 0.78, atmos: 0.46, csteps: 32, lsteps: 4, msteps: 12, rain: 0.8 },
  { grass: 1.00, flowers: 1.00, atmos: 0.52, csteps: 40, lsteps: 5, msteps: 14, rain: 1.0 },
];

class Game {
  constructor() {
    this.clock = new THREE.Clock();
    this.container = document.getElementById('app');

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, powerPreference: 'high-performance', stencil: false, depth: true,
    });
    this.dpr = Math.min(devicePixelRatio || 1, has('dpr') ? num('dpr', 2) : 1.75);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;   // 由调色通道统一做 ACES
    this.renderer.setClearColor(0x8fb6d8, 1);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.35, 4000);
    this.camera.position.set(0, 12, 26);

    this.focusX = 0; this.focusZ = 0;
    this.bloomArea = 0;
    this.paused = false;

    // 画质档位
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.tier = has('tier') ? num('tier', 3) : (coarse ? 1 : 3);
    this.maxTier = this.tier;
    this.frameAvg = 16;
    this.tierCooldown = 3;

    addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => { this.clock.getDelta(); });
  }

  async build() {
    const t = TIERS[this.tier];

    status('正在隆起山峦…'); progress(0.08); await frame();
    this.hf = new Heightfield({ size: env.worldSize, res: env.hfRes });

    status('正在铺展大地…'); progress(0.24); await frame();
    this.terrain = createTerrain(this.hf, { segments: 512 });
    this.scene.add(this.terrain);
    this.sky = createSky();
    this.scene.add(this.sky);

    status('正在等待花开…'); progress(0.38); await frame();
    this.bloomMap = new BloomMap(this.renderer, { size: 1024, world: env.worldSize });
    env.uniforms.uBloomMap.value = this.bloomMap.texture;
    env.uniforms.uBloomWorld.value = env.worldSize;

    status('正在种下青草…'); progress(0.52); await frame();
    this.grassBase = Math.round(num('grass', 190000));
    this.grass = new Grass(this.hf, { count: this.grassBase });
    this.scene.add(this.grass.mesh);
    // 远景草层：从中景淡入、在雾里淡出，抹掉近景草坪的圆形边界
    this.grassFarBase = Math.round(this.grassBase * 1.5);
    this.grassFar = new Grass(this.hf, {
      count: this.grassFarBase, tile: 200, bladeH: 0.95, width: 0.115,
      fadeIn: [40, 72], fadeStart: 92, fadeEnd: 122,
    });
    this.scene.add(this.grassFar.mesh);

    status('正在埋下花种…'); progress(0.70); await frame();
    this.flowerBase = Math.round(num('flowers', 30000));
    this.flowers = new Flowers(this.hf, { count: this.flowerBase });
    this.scene.add(this.flowers.mesh);

    status('风起了…'); progress(0.82); await frame();
    this.weather = new Weather(this.scene, { autoSeconds: num('wauto', 82) });
    if (has('w')) { this.weather.next(num('w', 0)); this.weather.blend = 1; this.weather.apply(1); }

    status('花瓣正在苏醒…'); progress(0.90); await frame();
    this.flock = new PetalFlock(this.hf, { count: Math.round(num('petals', 240)) });
    this.scene.add(this.flock.mesh);

    this.input = new Input(this.renderer.domElement);
    this.rig = new CameraRig(this.camera, this.hf);
    this.rig.pos.copy(this.flock.pos).add(new THREE.Vector3(0, 4, 13));
    this.rig.look.copy(this.flock.pos);

    this.post = new PostFX(this.renderer, this.scene, this.camera, {
      atmosScale: num('atmos', t.atmos),
      cloudSteps: num('csteps', t.csteps),
      lightSteps: num('lsteps', t.lsteps),
      mistSteps:  num('msteps', t.msteps),
    });
    this.post.setSize(innerWidth * this.dpr, innerHeight * this.dpr);
    this.applyTier(this.tier, true);

    this.bindKeys();
    progress(1.0); status('');
  }

  applyTier(i, force) {
    i = Math.max(0, Math.min(TIERS.length - 1, i));
    if (!force && i === this.tier) return;
    this.tier = i;
    const t = TIERS[i];
    if (this.grass) this.grass.mesh.geometry.instanceCount = Math.round(this.grassBase * t.grass);
    if (this.grassFar) this.grassFar.mesh.geometry.instanceCount = Math.round(this.grassFarBase * t.grass);
    if (this.flowers) this.flowers.mesh.geometry.instanceCount = Math.round(this.flowerBase * t.flowers);
    if (this.weather) this.weather.rain.geometry.instanceCount = Math.round(3200 * t.rain);
    if (this.post && !has('atmos')) {
      this.post.mAtmos.uniforms.uCloudSteps.value = t.csteps;
      this.post.mAtmos.uniforms.uLightSteps.value = t.lsteps;
      this.post.mAtmos.uniforms.uMistSteps.value = t.msteps;
      if (Math.abs(this.post.q.atmosScale - t.atmos) > 0.01) {
        this.post.q.atmosScale = t.atmos;
        this.post.setSize(this.post.width, this.post.height);
      }
    }
  }

  bindKeys() {
    const hud = document.getElementById('hud');
    const toast = document.getElementById('toast');
    let toastTimer = 0;
    this.showToast = (txt) => {
      toast.textContent = txt;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 1700);
    };
    this.input.onKey = (code) => {
      if (code === 'KeyC') { const p = this.weather.next(); this.showToast(p.name); }
      else if (code === 'KeyH') hud.classList.toggle('on');
      else if (code === 'KeyP') this.paused = !this.paused;
      else if (/^Digit[1-5]$/.test(code)) {
        const p = this.weather.next(parseInt(code.slice(5), 10) - 1);
        this.showToast(p.name);
      }
    };
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    if (this.post) this.post.setSize(innerWidth * this.dpr, innerHeight * this.dpr);
  }

  step(dt, override) {
    const ctrl = override || (this.input ? this.input.sample()
      : { move: { x: 0, y: 0 }, orbit: { dx: 0, dy: 0 }, zoom: 0, boost: false, hold: false, rise: 0 });

    env.time += dt;
    env.cloudTime += dt;
    env.windPhase += dt * (0.55 + env.uniforms.uWindStrength.value * 0.80);
    env.uniforms.uTime.value = env.time;
    env.uniforms.uCloudTime.value = env.cloudTime;
    env.uniforms.uWindPhase.value = env.windPhase;

    if (this.weather) this.weather.update(dt);

    if (this.flock) {
      this.flock.update(dt, ctrl, this.rig.yaw);
      this.rig.update(dt, this.flock, ctrl);
      this.focusX = this.flock.centroid.x;
      this.focusZ = this.flock.centroid.z;

      // 花瓣所到之处，往绽放贴图上留下痕迹
      const c = this.flock.centroid;
      this.bloomMap.splat(c.x, c.z, 4.8, 1.7 * dt);
      for (let i = 0; i < 3; i++) {
        const p = this.flock.petals[(Math.random() * this.flock.count) | 0].p;
        this.bloomMap.splat(p.x, p.z, 2.6, 1.2 * dt);
      }
      this.bloomArea += this.flock.speed * dt * 7.5;
    }
  }

  updateHud() {
    if (!this.weather) return;
    const w = document.getElementById('weather');
    if (w.dataset.n !== this.weather.name) {
      w.dataset.n = this.weather.name;
      w.innerHTML = '<b>' + this.weather.name + '</b><span>' + this.weather.desc + '</span>';
    }
    const n = Math.floor(this.bloomArea * 1.15);
    const el = document.getElementById('bloomCount');
    if (el.dataset.v !== String(n)) {
      el.dataset.v = String(n);
      el.innerHTML = '<b>' + n.toLocaleString('zh-CN') + '</b><span>朵花已绽放</span>';
    }
  }

  render() {
    env.uniforms.uCamPos.value.copy(this.camera.position);
    if (this.grass) this.grass.update(this.focusX, this.focusZ);
    if (this.grassFar) this.grassFar.update(this.focusX, this.focusZ);
    if (this.flowers) this.flowers.update(this.focusX, this.focusZ);
    this.sky.position.copy(this.camera.position);
    this.sky.scale.setScalar(this.camera.far * 0.5);
    if (this.post) this.post.render(0, this.rig);
    else this.renderer.render(this.scene, this.camera);
  }

  // 自适应画质：连续掉帧就降档，长时间宽裕就升回去。
  // 注意要量真实帧耗时，不能用被 clamp 过的 dt，否则永远看不到卡顿。
  adapt(dt) {
    const now = performance.now();
    const ms = this._lastFrameAt ? (now - this._lastFrameAt) : 16;
    this._lastFrameAt = now;
    if (has('tier') || has('atmos')) return;
    this.frameAvg += (Math.min(ms, 400) - this.frameAvg) * 0.10;
    this.tierCooldown -= dt;
    if (this.tierCooldown > 0) return;
    if (this.frameAvg > 32 && this.tier > 0) { this.applyTier(this.tier - 1); this.tierCooldown = 4; }
    else if (this.frameAvg < 13 && this.tier < this.maxTier) { this.applyTier(this.tier + 1); this.tierCooldown = 8; }
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.paused) return;
    this.step(dt);
    this.adapt(dt);
    this.render();
    this.updateHud();
  }
}

const game = new Game();
window.__game = game;

game.build().then(() => {
  if (has('debug')) env.uniforms.uDebug.value = 1.0;
  if (qs.has('cam')) {
    const v = (k, d) => (qs.has(k) ? new THREE.Vector3(...qs.get(k).split(',').map(Number)) : d);
    game.camera.position.copy(v('cam', game.camera.position));
    game.camera.fov = num('fov', 52);
    game.camera.updateProjectionMatrix();
    game.camera.lookAt(v('look', new THREE.Vector3(0, 6, 0)));
  }

  // ---- 截图 / 调试接口：确定性快进 + 单帧渲染 ----
  window.__shot = {
    warp(seconds, ctrl, dt = 1 / 30) {
      const n = Math.min(Math.ceil(seconds / dt), 6000);
      const c = ctrl ? Object.assign({ move: { x: 0, y: 0 }, orbit: { dx: 0, dy: 0 }, zoom: 0,
                                       boost: false, hold: false, rise: 0 }, ctrl) : null;
      for (let i = 0; i < n; i++) game.step(dt, c);
    },
    drive(seconds, mx, my, opts) {
      window.__shot.warp(seconds, Object.assign({ move: { x: mx, y: my } }, opts || {}));
    },
    render() { game.render(); game.updateHud(); },
    setCam(o) {
      if (o.yaw !== undefined) game.rig.yaw = o.yaw;
      if (o.pitch !== undefined) game.rig.pitch = o.pitch;
      if (o.dist !== undefined) { game.rig.dist = o.dist; game.rig.distBias = 0; }
      game.rig.update(1 / 60, game.flock, { move: { x: 0, y: 0 }, orbit: { dx: 0, dy: 0 },
        zoom: 0, boost: false, hold: true, rise: 0 });
    },
    freeCam(px, py, pz, lx, ly, lz, fov) {
      const c = game.camera;
      c.position.set(px, py, pz);
      c.fov = fov || 55; c.updateProjectionMatrix();
      c.up.set(0, 1, 0); c.lookAt(lx, ly, lz);
      game.rig.focusDistance = c.position.distanceTo(new THREE.Vector3(lx, ly, lz));
      game.rig.aperture = 0.10;
    },
    weather(i) { game.weather.next(i); game.weather.blend = 1; game.weather.apply(1); },
    fillBloom(r) { const R = r || 260; for (let i = 0; i < 24; i++) game.bloomMap.splat(0, 0, R, 0.4); },
    paint(x, z, r, s) { game.bloomMap.splat(x, z, r, s); },
  };

  const intro = document.getElementById('intro');
  const hud = document.getElementById('hud');
  const start = document.getElementById('start');
  const begin = () => {
    intro.classList.add('hide');
    hud.classList.add('on');
    if (has('shot')) { intro.style.display = 'none'; hud.style.opacity = '1'; }
    setTimeout(() => { intro.style.display = 'none'; }, 1800);
  };
  start.classList.add('on');
  start.addEventListener('click', begin);
  addEventListener('keydown', (e) => {
    if (!intro.classList.contains('hide') && (e.code === 'Space' || e.code === 'Enter')) begin();
  });
  if (has('shot')) begin();

  game.updateHud();
  window.__ready = true;
  game.render();
  if (!has('still')) game.loop();
});
