// -----------------------------------------------------------------------------
// petals.js — 主角：一群飘浮的花瓣。
// 领队沿玩家意志前进并记录路径；每片花瓣按各自的延迟采样这条路径，
// 再叠加螺旋偏移与颤动 → 一条会呼吸的花瓣飘带。
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { env, withEnv } from '../core/env.js';
import { ENV_UNIFORMS, NOISE, CLOUD, ATMOS } from '../shaders/common.js';

const VERT = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
attribute vec3 aPos;
attribute vec4 aQuat;
attribute vec2 aScale;    // x:大小 y:透明/新生程度
attribute vec3 aColor;
attribute float aSeed;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying vec3  vTint;
varying float vSeed;
varying float vAlpha;

vec3 rotQ(vec4 q, vec3 v){
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main(){
  vec3 p = position * aScale.x;
  p = rotQ(aQuat, p);
  vec3 wp = aPos + p;

  vec3 n = rotQ(aQuat, normal);

  vWorld = wp;
  vNormal = n;
  vUv = uv;
  vTint = aColor;
  vSeed = aSeed;
  vAlpha = aScale.y;
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
varying vec2  vUv;
varying vec3  vTint;
varying float vSeed;
varying float vAlpha;

void main(){
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vNormal);
  if (dot(N, V) < 0.0) N = -N;

  // 花瓣本体：根深尖浅，带一点脉络
  float u = clamp(vUv.y, 0.0, 1.0);
  vec3 base = vTint;
  vec3 tip  = mix(vTint, vec3(1.0, 0.965, 0.93), 0.72);
  vec3 col = mix(base, tip, smoothstep(0.10, 0.95, u));
  float vein = smoothstep(0.55, 0.0, abs(vUv.x - 0.5) * 2.0);
  col *= mix(1.0, 0.90, vein * 0.5 * (1.0 - u));

  float sh = cloudShadowAt(vWorld);

  // 花瓣极薄 —— 透光才是它的灵魂
  float ndl = dot(N, uSunDir);
  float front = max(ndl, 0.0);
  float backlit = max(-ndl, 0.0);
  float viewBack = pow(clamp(dot(-V, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 2.0);

  vec3 diffuse = uSunColor * uSunPower * (front * 0.62 + 0.58) * sh;
  vec3 trans   = uSunColor * uSunPower * backlit * viewBack * 1.5 * sh * vec3(1.0, 0.72, 0.62);
  vec3 amb     = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * uAmbPower * 1.55;

  vec3 outc = col * (diffuse + amb + trans) * 0.42;

  // 边缘透亮 + 一点自发光，让它在泛光里发出柔和的光晕
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.2);
  outc += col * rim * 0.35 * (0.4 + viewBack);
  outc += col * 0.10;

  outc = applyAtmosphere(outc, vWorld, uCamPos);
  gl_FragColor = vec4(outc, vAlpha);
}
`;

// 一片有弧度的水滴形花瓣
function petalGeometry(nu = 10, nv = 5) {
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= nu; j++) {
    const u = j / nu;
    const w = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.82)), 0.72) * 0.46;
    for (let i = 0; i <= nv; i++) {
      const v = i / nv;
      const x = (v - 0.5) * 2.0 * w;
      const y = (u - 0.34) * 1.25;
      // 杯状弯曲 + 沿长度的微卷
      const z = 0.30 * (x * x) * (0.4 + u) + 0.12 * u * u - 0.03;
      pos.push(x, y, z);
      uvs.push(v, u);
    }
  }
  const row = nv + 1;
  for (let j = 0; j < nu; j++) {
    for (let i = 0; i < nv; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const PALETTE = [
  0xff8fa8, 0xff6f8e, 0xffb3c1, 0xff9d76, 0xffd08a,
  0xfff0e0, 0xff7f6b, 0xf7a1c4, 0xffc4a3, 0xff5f7a,
];

export class PetalFlock {
  constructor(hf, { count = 240 } = {}) {
    this.hf = hf;
    this.count = count;

    // --- 领队状态 ---
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.pos.y = hf.heightAt(0, 0) + 2.6;
    this.altitude = 2.6;
    this.speed = 0;
    this.heading = new THREE.Vector3(0, 0, -1);

    // --- 路径历史（环形缓冲）---
    this.histN = 420;
    this.hist = new Float32Array(this.histN * 3);
    this.histT = new Float32Array(this.histN);
    this.histHead = 0;
    this.histCount = 0;
    this.time = 0;
    for (let i = 0; i < this.histN; i++) {
      this.hist[i * 3] = this.pos.x; this.hist[i * 3 + 1] = this.pos.y; this.hist[i * 3 + 2] = this.pos.z;
    }

    // --- 实例数据 ---
    const geo = new THREE.InstancedBufferGeometry();
    const base = petalGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('normal', base.getAttribute('normal'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    geo.instanceCount = count;

    this.aPos = new Float32Array(count * 3);
    this.aQuat = new Float32Array(count * 4);
    this.aScale = new Float32Array(count * 2);
    this.aColor = new Float32Array(count * 3);
    this.aSeed = new Float32Array(count);

    this.petals = [];
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const p = {
        p: new THREE.Vector3(),
        v: new THREE.Vector3(),
        q: new THREE.Quaternion().random(),
        w: new THREE.Vector3((Math.random() - .5) * 2, (Math.random() - .5) * 2, (Math.random() - .5) * 2),
        lag: 0.05 + Math.pow(t, 0.85) * 2.10 + Math.random() * 0.20,
        radius: 0.30 + Math.random() * 1.45 + t * 1.05,
        spin: (Math.random() * 2 - 1) * 1.5,
        phase: Math.random() * Math.PI * 2,
        bob: 0.5 + Math.random() * 1.4,
        size: 0.155 + Math.random() * 0.135,
      };
      p.p.copy(this.pos);
      this.petals.push(p);

      c.setHex(PALETTE[(Math.random() * PALETTE.length) | 0]);
      this.aColor[i * 3] = c.r; this.aColor[i * 3 + 1] = c.g; this.aColor[i * 3 + 2] = c.b;
      this.aScale[i * 2] = p.size;
      this.aScale[i * 2 + 1] = 1.0;
      this.aSeed[i] = Math.random();
    }

    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.aPos, 3));
    geo.setAttribute('aQuat', new THREE.InstancedBufferAttribute(this.aQuat, 4));
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(this.aScale, 2));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.aColor, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.aSeed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: withEnv(),
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'petals';
    this.mesh.frustumCulled = false;

    this.centroid = new THREE.Vector3().copy(this.pos);
    this._tmp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
  }

  _pushHistory() {
    this.histHead = (this.histHead + 1) % this.histN;
    const o = this.histHead * 3;
    this.hist[o] = this.pos.x; this.hist[o + 1] = this.pos.y; this.hist[o + 2] = this.pos.z;
    this.histT[this.histHead] = this.time;
    this.histCount = Math.min(this.histCount + 1, this.histN);
  }

  /** 按"多少秒之前"取路径点（线性插值） */
  _pathAt(age, out) {
    const target = this.time - age;
    let idx = this.histHead;
    let prev = idx;
    for (let n = 0; n < this.histCount - 1; n++) {
      const i = (this.histHead - n + this.histN) % this.histN;
      if (this.histT[i] <= target) {
        const j = (i + 1) % this.histN;
        const t0 = this.histT[i], t1 = this.histT[j];
        const f = t1 > t0 ? (target - t0) / (t1 - t0) : 0;
        const a = i * 3, b = j * 3;
        out.set(
          this.hist[a] + (this.hist[b] - this.hist[a]) * f,
          this.hist[a + 1] + (this.hist[b + 1] - this.hist[a + 1]) * f,
          this.hist[a + 2] + (this.hist[b + 2] - this.hist[a + 2]) * f,
        );
        return out;
      }
      prev = i;
    }
    const o = ((this.histHead - this.histCount + 1 + this.histN) % this.histN) * 3;
    return out.set(this.hist[o], this.hist[o + 1], this.hist[o + 2]);
  }

  update(dt, ctrl, camYaw) {
    this.time += dt;
    const wind = env.uniforms.uWind.value;
    const windS = env.uniforms.uWindStrength.value;

    // ---- 领队 ----
    const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const desired = new THREE.Vector3()
      .addScaledVector(fwd, ctrl.move.y)
      .addScaledVector(right, ctrl.move.x);

    const inputLen = desired.length();
    if (inputLen > 1e-3) desired.normalize();

    const maxSpeed = (ctrl.boost ? 19.0 : 10.5) * (ctrl.hold ? 0.0 : 1.0);
    const target = desired.multiplyScalar(maxSpeed * inputLen);

    // 无输入时随风缓缓漂流，永远不会真正静止
    if (inputLen < 1e-3 && !ctrl.hold) {
      target.set(wind.x, 0, wind.y).multiplyScalar(1.35 * windS);
    }

    const accel = ctrl.hold ? 4.5 : (inputLen > 0 ? 5.2 : 1.6);
    this.vel.x += (target.x - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (target.z - this.vel.z) * Math.min(1, accel * dt);

    // 高度：贴着地形起伏飞行
    this.altitude += ctrl.rise * 9.0 * dt;
    this.altitude = Math.max(1.1, Math.min(26.0, this.altitude));
    const ground = this.hf.heightAt(this.pos.x, this.pos.z);
    const wantY = ground + this.altitude;
    this.vel.y += ((wantY - this.pos.y) * 2.6 - this.vel.y) * Math.min(1, 5.0 * dt);

    this.pos.addScaledVector(this.vel, dt);

    // 世界边界：柔和地推回来
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > env.playRadius) {
      const k = (r - env.playRadius) * 0.06;
      this.pos.x -= (this.pos.x / r) * k;
      this.pos.z -= (this.pos.z / r) * k;
      this.vel.x *= 0.94; this.vel.z *= 0.94;
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.speed > 0.15) {
      this._tmp.set(this.vel.x, 0, this.vel.z).normalize();
      this.heading.lerp(this._tmp, Math.min(1, 3.0 * dt)).normalize();
    }
    this._pushHistory();

    // ---- 每片花瓣 ----
    const t = this.time;
    const pathP = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const rightV = new THREE.Vector3();
    const upV = new THREE.Vector3(0, 1, 0);
    const desiredPos = new THREE.Vector3();
    const cen = this._tmp.set(0, 0, 0);

    for (let i = 0; i < this.count; i++) {
      const p = this.petals[i];
      this._pathAt(p.lag, pathP);

      // 路径切向（用领队朝向近似，静止时也稳定）
      tangent.copy(this.heading);
      rightV.crossVectors(tangent, upV).normalize();

      const ang = t * p.spin + p.phase;
      const swirl = p.radius * (0.55 + 0.45 * Math.sin(t * 0.6 + p.phase));
      desiredPos.copy(pathP)
        .addScaledVector(rightV, Math.cos(ang) * swirl)
        .addScaledVector(upV, Math.sin(ang) * swirl * 0.62 + Math.sin(t * p.bob + p.phase) * 0.42)
        .addScaledVector(tangent, Math.sin(ang * 0.7) * swirl * 0.35);

      // 弹簧跟随 + 阻尼，速度越快跟得越紧
      const k = 3.2 + this.speed * 0.22;
      p.v.x += (desiredPos.x - p.p.x) * k * dt;
      p.v.y += (desiredPos.y - p.p.y) * k * dt;
      p.v.z += (desiredPos.z - p.p.z) * k * dt;
      // 风的横向推力
      p.v.x += wind.x * windS * 0.55 * dt;
      p.v.z += wind.y * windS * 0.55 * dt;
      const damp = Math.exp(-2.6 * dt);
      p.v.multiplyScalar(damp);
      p.p.addScaledVector(p.v, dt);

      // 不要穿进地里
      const gh = this.hf.heightAt(p.p.x, p.p.z) + 0.28;
      if (p.p.y < gh) { p.p.y += (gh - p.p.y) * Math.min(1, 9 * dt); p.v.y += 2.0 * dt; }

      // 翻飞姿态：角速度随自身速度与风变化
      const sp = p.v.length();
      const spin = 0.55 + sp * 0.30;
      this._e.set(p.w.x * spin * dt, p.w.y * spin * dt, p.w.z * spin * dt);
      this._q.setFromEuler(this._e);
      p.q.multiply(this._q).normalize();

      const o3 = i * 3, o4 = i * 4;
      this.aPos[o3] = p.p.x; this.aPos[o3 + 1] = p.p.y; this.aPos[o3 + 2] = p.p.z;
      this.aQuat[o4] = p.q.x; this.aQuat[o4 + 1] = p.q.y; this.aQuat[o4 + 2] = p.q.z; this.aQuat[o4 + 3] = p.q.w;
      cen.add(p.p);
    }
    cen.multiplyScalar(1 / this.count);
    this.centroid.lerp(cen, Math.min(1, 6 * dt));

    const g = this.mesh.geometry;
    g.getAttribute('aPos').needsUpdate = true;
    g.getAttribute('aQuat').needsUpdate = true;
  }
}
