// -----------------------------------------------------------------------------
// flowers.js — 花瓣所到之处，逐渐长出的鲜花。
// 花的位置在世界里是固定的伪随机分布（随玩家取模平铺），
// 是否开放、开得多大，完全由世界空间的"绽放贴图"决定 —— 于是
// 花海会精确地沿着你走过的路蔓延开来。
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { withEnv } from '../core/env.js';
import { shuffleInstances } from './grass.js';
import { ENV_UNIFORMS, NOISE, CLOUD, ATMOS, HEIGHTFIELD, BLOOMMAP, WIND } from '../shaders/common.js';

const VERT = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
${NOISE}
${HEIGHTFIELD}
${BLOOMMAP}
${WIND}

uniform vec2  uPlayerXZ;
uniform float uTile;
uniform float uFadeStart;
uniform float uFadeEnd;

attribute float aPart;    // 0 茎 1 花瓣 2 花心
attribute float aUp;      // 0..1 离地高度比例（摆动用）
attribute float aGrad;    // 花瓣上从根到尖的渐变
attribute vec2  aOffset;
attribute vec4  aRand;    // x:朝向 y:大小 z:种类 w:开放阈值
attribute vec3  aCol;

varying vec3  vWorld;
varying vec3  vNormal;
varying float vPart;
varying vec3  vCol;
varying float vGrow;
varying float vUp;
varying float vGrad;

void main(){
  vec2 rel = uPlayerXZ - aOffset;
  vec2 w = aOffset + uTile * floor(rel / uTile + 0.5);

  float d = length(w - uPlayerXZ);
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, d);

  vec4 hs = sampleHF(w);
  vec3 gnorm = normalize(vec3(hs.g, sqrt(max(1.0 - hs.g*hs.g - hs.b*hs.b, 0.02)), hs.b));
  float slopeOk = smoothstep(0.58, 0.88, gnorm.y);

  // ---- 开放程度：完全由绽放贴图驱动 ----
  float bl = bloomAt(w);
  float thr = aRand.w * 0.42;                       // 每朵花的开放门槛不同 → 逐渐、错落地开
  float grow = smoothstep(thr, thr + 0.30, bl);
  // 冒头时有一点点回弹，像真的顶开了草
  float pop = grow * (1.0 + 0.16 * sin(grow * 3.14159));

  float scale = (0.88 + aRand.y * 0.95) * pop * fade * slopeOk;

  float ang = aRand.x * 6.2831853;
  float ca = cos(ang), sa = sin(ang);
  vec3 p = position;
  p.xz = vec2(p.x * ca - p.z * sa, p.x * sa + p.z * ca);
  p *= scale;

  // ---- 随风摆动 ----
  vec3 wf = windField(w * 1.0 + aRand.x * 7.0);
  vec2 wdir = normalize(uWind + 1e-5);
  float bend = (wf.x * 0.30 + 0.05) * pow(aUp, 1.5) * scale;
  p.xz += wdir * bend + vec2(-wdir.y, wdir.x) * wf.y * 0.16 * pow(aUp, 1.5) * scale;

  vec3 wp = vec3(w.x, hs.r - 0.04, w.y) + p;

  vec3 n = normal;
  n.xz = vec2(n.x * ca - n.z * sa, n.x * sa + n.z * ca);

  vWorld = wp;
  vNormal = normalize(mix(n, gnorm, 0.15));
  vPart = aPart;
  vCol = aCol;
  vGrow = grow;
  vUp = aUp;
  vGrad = aGrad;

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, scale > 0.001 ? 1.0 : 0.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
${NOISE}
${CLOUD}
${ATMOS}
varying vec3  vWorld;
varying vec3  vNormal;
varying float vPart;
varying vec3  vCol;
varying float vGrow;
varying float vUp;
varying float vGrad;

void main(){
  if (vGrow < 0.01) discard;
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vNormal);
  // 薄片体（花瓣/叶）的着色法线应当朝向观察者：辐射排列时几何绕序会翻转，
  // 用 gl_FrontFacing 判断会把一半的花照成黑的。
  if (dot(N, V) < 0.0) N = -N;

  vec3 col;
  float trans;
  if (vPart < 0.5) {            // 茎叶
    col = mix(uGrassDeep, uGrassLit, 0.55);
    trans = 0.5;
  } else if (vPart < 1.5) {     // 花瓣：根部略深、尖端更淡
    col = mix(mix(vCol, vec3(0.98, 0.86, 0.42), 0.30), mix(vCol, vec3(1.0), 0.40), smoothstep(0.05, 0.9, vGrad));
    trans = 1.4;
  } else {                      // 花心
    col = mix(vec3(1.0, 0.78, 0.16), vCol, 0.18);
    trans = 0.2;
  }

  float sh = cloudShadowAt(vWorld);
  float ndl = dot(N, uSunDir);
  float wrap = clamp((ndl + 0.42) / 1.42, 0.0, 1.0);
  vec3 diffuse = uSunColor * uSunPower * mix(max(ndl, 0.0), wrap, 0.6) * sh;

  float back = pow(clamp(dot(-V, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  vec3 sss = uSunColor * back * max(-ndl, 0.0) * trans * sh;

  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * uAmbPower * 1.1;
  // 花被草丛半掩，底部略暗
  float ao = mix(0.55, 1.0, smoothstep(0.0, 0.55, vUp));

  vec3 outc = col * (diffuse + amb + sss) * ao * 0.50;
  if (vPart > 1.5) outc += col * 0.20;                    // 花心一点点自发光
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  outc += col * rim * 0.10;

  outc = applyAtmosphere(outc, vWorld, uCamPos);
  gl_FragColor = vec4(outc, 1.0);
}
`;

// 一朵风格化的花：细茎 + 一片叶 + 五片分开的花瓣 + 微微隆起的花心
function flowerGeometry() {
  const pos = [], nor = [], part = [], up = [], grad = [], idx = [];
  const push = (x, y, z, nx, ny, nz, p, u, g) => {
    pos.push(x, y, z); nor.push(nx, ny, nz); part.push(p); up.push(u); grad.push(g);
    return pos.length / 3 - 1;
  };

  // --- 茎 ---
  const H = 0.44, R = 0.013, SEG = 3;
  let prevA = -1, prevB = -1;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const y = t * H;
    const r = R * (1.0 - t * 0.35);
    const a = push(-r, y, 0, -1, 0, 0, 0, t, 0);
    const b = push(r, y, 0, 1, 0, 0, 0, t, 0);
    if (i > 0) idx.push(prevA, a, prevB, prevB, a, b);
    prevA = a; prevB = b;
  }
  // --- 一片小叶 ---
  {
    const y = H * 0.42;
    const a = push(0, y, 0, 0, 1, 0, 0, 0.42, 0);
    const b = push(0.095, y + 0.045, 0.025, 0, 0.97, 0.22, 0, 0.5, 0);
    const c = push(0.175, y + 0.015, 0, 0, 1, 0, 0, 0.5, 0);
    const d = push(0.095, y - 0.015, -0.025, 0, 0.97, -0.22, 0, 0.46, 0);
    idx.push(a, b, c, a, c, d);
  }

  // --- 五片花瓣：宽度受"扇形夹角"约束，彼此分开才像花 ---
  const NP = 5, PL = 0.165, PW = 0.085, R0 = 0.026;
  const maxHalfAngle = (Math.PI / NP) * 0.80;     // 留出花瓣之间的缝
  for (let k = 0; k < NP; k++) {
    const a0 = (k / NP) * Math.PI * 2;
    const ca = Math.cos(a0), sa = Math.sin(a0);
    const rows = 5;
    const start = pos.length / 3;
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const rad = R0 + t * PL;
      const shape = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.52)), 0.85) * PW;
      const wdt = Math.min(shape, rad * Math.tan(maxHalfAngle));
      for (let i = -1; i <= 1; i += 2) {
        const across = i * wdt;
        // 沿长度先扬后垂；沿宽度两侧上翘 → 杯状
        const cup = (wdt > 1e-5 ? (across * across) / (PW * PW) : 0) * 0.075 * PL;
        const yy = H + Math.sin(0.62) * t * PL * 0.80 - t * t * PL * 0.34 + cup;
        const x = ca * rad - sa * across;
        const z = sa * rad + ca * across;
        const nx = ca * 0.26 - sa * i * 0.30;
        const nz = sa * 0.26 + ca * i * 0.30;
        push(x, yy, z, nx, 0.92, nz, 1, 1.0, t);
      }
    }
    for (let j = 0; j < rows; j++) {
      const a = start + j * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
  }

  // --- 花心：小圆盘，中间略隆起 ---
  {
    const cy = H + 0.010;
    const c0 = push(0, cy + 0.020, 0, 0, 1, 0, 2, 1.0, 0.0);
    const N = 9, r = 0.031;
    const first = pos.length / 3;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      push(Math.cos(a) * r, cy, Math.sin(a) * r, Math.cos(a) * 0.4, 0.9, Math.sin(a) * 0.4, 2, 1.0, 1.0);
    }
    for (let i = 0; i < N; i++) idx.push(c0, first + i, first + ((i + 1) % N));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('aUp', new THREE.Float32BufferAttribute(up, 1));
  g.setAttribute('aGrad', new THREE.Float32BufferAttribute(grad, 1));
  g.setIndex(idx);
  return g;
}

// 花色，按低频区域成片分布，像真实草甸那样有"族群"
const COLORS = [
  0xfffaf4, 0xffd3e0, 0xff9fb8, 0xffe9a8, 0xffd0a0,
  0xe0caff, 0xcfe4ff, 0xfff8d8, 0xffc0ac, 0xf7ecff,
  0xffffff, 0xffe3ec, 0xfdf3ff, 0xffcfd8,
];

export class Flowers {
  constructor(hf, { count = 30000, tile = 120, fadeStart = 40, fadeEnd = 58 } = {}) {
    const base = flowerGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('normal', base.getAttribute('normal'));
    geo.setAttribute('aPart', base.getAttribute('aPart'));
    geo.setAttribute('aUp', base.getAttribute('aUp'));
    geo.setAttribute('aGrad', base.getAttribute('aGrad'));
    geo.instanceCount = count;

    const off = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 4);
    const col = new Float32Array(count * 3);
    const cols = Math.ceil(Math.sqrt(count));
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const cx = i % cols, cy = Math.floor(i / cols);
      const x = ((cx + Math.random()) / cols - 0.5) * tile;
      const z = ((cy + Math.random()) / cols - 0.5) * tile;
      off[i * 2] = x; off[i * 2 + 1] = z;

      rnd[i * 4 + 0] = Math.random();
      rnd[i * 4 + 1] = Math.random();
      rnd[i * 4 + 2] = Math.random();
      rnd[i * 4 + 3] = Math.random();

      // 按低频噪声成片选色：同一片坡上的花是同族的
      const region = (Math.sin(x * 0.031) * Math.cos(z * 0.027) * 0.5 + 0.5);
      let ci = Math.floor(region * COLORS.length + Math.random() * 2.2) % COLORS.length;
      c.setHex(COLORS[ci]);   // setHex 已按 sRGB 解释并转到线性工作空间，不要再转一次
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }

    // 同草地：降档靠截断实例数，必须先打乱，否则会整片消失
    shuffleInstances(count, [[off, 2], [rnd, 4], [col, 3]]);

    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 2));
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rnd, 4));
    geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: withEnv(Object.assign(hf.uniforms(), {
        uPlayerXZ:  { value: new THREE.Vector2() },
        uTile:      { value: tile },
        uFadeStart: { value: fadeStart },
        uFadeEnd:   { value: fadeEnd },
      })),
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'flowers';
    this.mesh.frustumCulled = false;
  }

  update(x, z) { this.mat.uniforms.uPlayerXZ.value.set(x, z); }
}
