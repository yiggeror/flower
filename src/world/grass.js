// -----------------------------------------------------------------------------
// grass.js — 风格化草坪。
// 一次 draw call 的 GPU 实例化草叶，随玩家在世界里"环绕平铺"（取模跟随），
// 多频风场驱动弯曲 + 波峰高光 → 风吹麦浪。
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { env, withEnv } from '../core/env.js';
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
uniform vec2  uFadeIn;   // 远景层用：随距离淡入
uniform float uBladeH;
uniform float uWidth;

attribute vec2 aOffset;
attribute vec4 aRand;     // x:朝向 y:高度 z:宽度 w:色彩变化

varying vec3  vWorld;
varying vec3  vNormal;
varying float vT;
varying float vGust;
varying float vColorVar;
varying float vBloom;
varying float vWet;
varying vec3  vGN;

void main(){
  // ---- 跟随玩家的无限平铺 ----
  vec2 rel = uPlayerXZ - aOffset;
  vec2 w = aOffset + uTile * floor(rel / uTile + 0.5);

  float d = length(w - uPlayerXZ);
  float fade = (1.0 - smoothstep(uFadeStart, uFadeEnd, d)) * smoothstep(uFadeIn.x, uFadeIn.y, d);

  vec4 hs = sampleHF(w);
  float ground = hs.r;
  vec3  gnorm = normalize(vec3(hs.g, sqrt(max(1.0 - hs.g*hs.g - hs.b*hs.b, 0.02)), hs.b));
  float wet = hs.a;

  // 陡坡少长草；噪声形成疏密斑块 —— 但要给个下限。
  // 原来是从 0 起跳，噪声低谷处整片变秃，看起来像"有的地方完全没草"。
  float slopeOk = mix(0.30, 1.0, smoothstep(0.42, 0.80, gnorm.y));
  float dens = fbm2n(w * 0.021 + 5.0, 3);
  float densOk = mix(0.58, 1.0, smoothstep(0.24, 0.52, dens + aRand.w * 0.24));

  float bloom = bloomAt(w);
  float t = position.y;

  float height = uBladeH * (0.62 + aRand.y * 0.75) * (0.82 + wet * 0.42);
  height *= fade * slopeOk * densOk;
  // 花开之处草略矮一点，让花冒出来
  height *= mix(1.0, 0.84, smoothstep(0.10, 0.75, bloom));

  float width = uWidth * (0.72 + aRand.z * 0.75) * (0.85 + height * 0.15);

  // ---- 风 ----
  vec3 wf = windField(w + aRand.x * 3.0);
  vec2 wdir = normalize(uWind + 1e-5);
  vec2 sideDir = vec2(-wdir.y, wdir.x);

  float ang = aRand.x * 6.2831853;
  vec3 widthDir = vec3(cos(ang), 0.0, sin(ang));

  // 自身自然的倾倒 + 风的弯曲
  float lean = 0.16 + aRand.z * 0.20;
  float bendAmt = (wf.x * (0.74 + aRand.y * 0.46) + lean);
  vec2 dir2 = normalize(wdir * (0.80 + aRand.y * 0.30)
                      + sideDir * (wf.y * 0.55 + (aRand.x - 0.5) * 0.5)
                      + 1e-5);

  float curve = bendAmt * t * t;
  vec3 local;
  local.y  = t * height * (1.0 - 0.30 * curve * curve);
  local.xz = dir2 * curve * height * 0.80;
  local   += widthDir * position.x * width * height / max(uBladeH, 0.001);

  vec3 wp = vec3(w.x, ground - 0.06, w.y) + local;
  // 顺应地形法线略微倾斜
  wp.xz += gnorm.xz * t * height * 0.35;

  // ---- 法线：弯曲切线 × 宽度方向，再沿宽度做圆柱化 ----
  vec3 tangent = normalize(vec3(dir2.x * 2.0 * bendAmt * t * 0.80,
                                max(height, 1e-3) * (1.0 - 0.9 * curve * curve) / max(height, 1e-3),
                                dir2.y * 2.0 * bendAmt * t * 0.80));
  vec3 nrm = normalize(cross(tangent, widthDir));
  nrm = normalize(nrm + widthDir * position.x * 3.0);
  nrm = normalize(mix(nrm, gnorm, 0.12));

  vWorld = wp;
  vNormal = nrm;
  vGN = gnorm;
  vT = t;
  vGust = wf.z;
  vColorVar = aRand.w;
  vBloom = bloom;
  vWet = wet;

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
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
varying float vT;
varying float vGust;
varying float vColorVar;
varying float vBloom;
varying float vWet;
varying vec3  vGN;

void main(){
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vNormal);
  if (dot(N, V) < 0.0) N = -N;

  // ---- 草色 ----
  float mixv = clamp(vT * 0.78 + vColorVar * 0.55 + vWet * 0.25 - 0.15, 0.0, 1.0);
  vec3 col = mix(uGrassDeep, uGrassLit, mixv);
  col = mix(col, uGrassDry, smoothstep(0.72, 1.0, vColorVar * 0.7 + vT * 0.45) * 0.45);
  // 花开之处草更翠
  col = mix(col, mix(col, vec3(0.34, 0.62, 0.19), 0.5), smoothstep(0.05, 0.6, vBloom));

  // 根部压暗 —— 廉价但极有效的自遮蔽
  float ao = mix(0.52, 1.06, smoothstep(0.0, 0.68, vT));

  float sh = cloudShadowAt(vWorld);

  // ---- 光照 ----
  // 关键：主光方向用"地形法线 × 叶片法线"的混合，草地整体读作一个受光平面，
  // 叶片法线只负责细节，否则近处草会变成一丛黑色尖刺。
  vec3 Nl = normalize(mix(N, normalize(vGN), 0.62));
  float ndl = dot(Nl, uSunDir);
  float wrap = clamp((ndl + 0.40) / 1.40, 0.0, 1.0);
  vec3 diffuse = uSunColor * uSunPower * mix(max(ndl, 0.0), wrap, 0.55) * sh;

  float back = pow(clamp(dot(-V, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.5);
  float trans = back * (0.55 + 0.45 * (1.0 - abs(ndl))) * smoothstep(0.1, 1.0, vT);
  vec3 sss = uSunColor * trans * 1.55 * sh * vec3(0.75, 1.0, 0.42);

  vec3 amb = mix(uAmbGround, uAmbSky, Nl.y * 0.5 + 0.5) * uAmbPower * mix(0.74, 1.0, sh);

  col *= mix(1.0, 0.70, uWetness);          // 淋湿的草更深
  vec3 outc = col * (diffuse + amb) * ao * 0.50 + col * sss * 0.34;

  // 远处的草叶只有一两个像素宽，降低对比避免闪烁的噪点感
  float far = smoothstep(45.0, 115.0, length(uCamPos - vWorld));
  ao = mix(ao, 0.90, far * 0.75);

  // ---- 麦浪：波峰处叶片被压向同一角度，成片地反光 ----
  float crest = smoothstep(0.55, 1.0, vGust) * smoothstep(0.25, 1.0, vT) * (1.0 - far * 0.6);
  outc *= mix(0.90, 1.30, crest);
  outc += uSunColor * crest * 0.060 * sh;

  // 湿润高光
  vec3 H = normalize(uSunDir + V);
  outc += uSunColor * pow(max(dot(N, H), 0.0), 42.0) * (0.03 + uWetness * 0.22) * sh * smoothstep(0.2, 1.0, vT);

  outc = applyAtmosphere(outc, vWorld, uCamPos);
  gl_FragColor = vec4(outc, 1.0);
}
`;

// Fisher-Yates：把若干条"每实例 N 个分量"的数组按同一个排列打乱
export function shuffleInstances(count, arrays) {
  for (let i = count - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    for (let a = 0; a < arrays.length; a++) {
      const [buf, n] = arrays[a];
      for (let k = 0; k < n; k++) {
        const x = buf[i * n + k];
        buf[i * n + k] = buf[j * n + k];
        buf[j * n + k] = x;
      }
    }
  }
}

function bladeGeometry(segments = 5) {
  const pos = [];
  const idx = [];
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const taper = Math.pow(1.0 - t, 0.62);
    pos.push(-0.5 * taper, t, 0);
    pos.push(0.5 * taper, t, 0);
  }
  pos.push(0, 1, 0); // 叶尖
  for (let i = 0; i < segments - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const last = (segments - 1) * 2;
  idx.push(last, segments * 2, last + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export class Grass {
  constructor(hf, { count = 190000, tile = 122, fadeStart = 40, fadeEnd = 60, bladeH = 1.0,
                    fadeIn = [-2, -1], width = 0.082 } = {}) {
    const base = bladeGeometry(5);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.instanceCount = count;

    const off = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 4);
    // 分层抖动网格 → 比纯随机更均匀，不会出现空洞与结块
    const cols = Math.ceil(Math.sqrt(count));
    let k = 0;
    for (let i = 0; i < count; i++) {
      const cx = i % cols, cy = Math.floor(i / cols);
      const u = (cx + Math.random()) / cols, v = (cy + Math.random()) / cols;
      off[i * 2] = (u - 0.5) * tile;
      off[i * 2 + 1] = (v - 0.5) * tile;
      rnd[k++] = Math.random();
      rnd[k++] = Math.random();
      rnd[k++] = Math.random();
      rnd[k++] = Math.random();
    }
    // 打乱实例顺序：降档时是靠截断 instanceCount 来减量的，
    // 若保持网格生成顺序，截断会整块地砍掉世界的一侧。
    shuffleInstances(count, [[off, 2], [rnd, 4]]);

    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 2));
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rnd, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: withEnv(Object.assign(hf.uniforms(), {
        uPlayerXZ:  { value: new THREE.Vector2() },
        uTile:      { value: tile },
        uFadeStart: { value: fadeStart },
        uFadeEnd:   { value: fadeEnd },
        uBladeH:    { value: bladeH },
        uFadeIn:    { value: new THREE.Vector2(fadeIn[0], fadeIn[1]) },
        uWidth:     { value: width },
      })),
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'grass';
    this.mesh.frustumCulled = false;
    this.count = count;
    this.baseWidth = width;
    this.baseBladeH = bladeH;
  }

  /**
   * 降档时按比例减少实例数。同时把草叶加宽、略加高来补偿覆盖率 ——
   * 否则低画质下草地会明显发秃、露出大片地面。
   */
  setDensityScale(f) {
    f = Math.max(0.05, Math.min(1, f));
    const k = Math.pow(1 / f, 0.38);
    this.mat.uniforms.uWidth.value = this.baseWidth * Math.min(k, 2.1);
    this.mat.uniforms.uBladeH.value = this.baseBladeH * Math.min(1 + (k - 1) * 0.34, 1.32);
    this.mesh.geometry.instanceCount = Math.round(this.count * f);
  }

  update(playerX, playerZ) {
    this.mat.uniforms.uPlayerXZ.value.set(playerX, playerZ);
  }
}
