// -----------------------------------------------------------------------------
// weather.js — 天气系统。
// 每种天气是一整套环境参数；切换时所有参数一起平滑过渡，
// 于是阳光、云量、云影、雾、风、湿度、曝光会同时改变，画面始终自洽。
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { env, withEnv } from '../core/env.js';
import { ENV_UNIFORMS, NOISE } from '../shaders/common.js';

const C = (r, g, b) => new THREE.Color(r, g, b);
const V = (x, y, z) => new THREE.Vector3(x, y, z).normalize();

export const PRESETS = [
  {
    name: '晴', desc: '微风', rain: 0,
    sunDir: V(0.50, 0.42, 0.76), sunColor: C(1.00, 0.895, 0.735), sunPower: 3.45, sunGlow: 1.0,
    skyTop: C(0.115, 0.315, 0.700), skyHorizon: C(0.720, 0.840, 0.950), skyGround: C(0.42, 0.46, 0.44),
    ambSky: C(0.335, 0.495, 0.800), ambGround: C(0.195, 0.255, 0.135), ambPower: 0.66,
    fogColor: C(0.700, 0.800, 0.900), fogDensity: 0.0016, fogHeight: 38,
    mist: 0.32, mistColor: C(0.80, 0.87, 0.94),
    cloudCover: 0.34, cloudDensity: 1.55, cloudShadow: 0.62, cloudTint: C(1.00, 0.98, 0.95),
    windDir: new THREE.Vector2(0.86, 0.51).normalize(), windStrength: 0.85,
    wetness: 0.0, exposure: 0.94,
  },
  {
    name: '云涌', desc: '阵风掠过草浪', rain: 0,
    sunDir: V(0.44, 0.46, 0.77), sunColor: C(1.00, 0.92, 0.79), sunPower: 3.30, sunGlow: 1.1,
    skyTop: C(0.100, 0.280, 0.640), skyHorizon: C(0.700, 0.800, 0.900), skyGround: C(0.38, 0.42, 0.42),
    ambSky: C(0.330, 0.470, 0.780), ambGround: C(0.180, 0.240, 0.130), ambPower: 0.80,
    fogColor: C(0.690, 0.770, 0.870), fogDensity: 0.0021, fogHeight: 40,
    mist: 0.48, mistColor: C(0.78, 0.85, 0.92),
    cloudCover: 0.62, cloudDensity: 1.95, cloudShadow: 0.80, cloudTint: C(0.98, 0.97, 0.96),
    windDir: new THREE.Vector2(0.62, -0.78).normalize(), windStrength: 1.75,
    wetness: 0.05, exposure: 0.97,
  },
  {
    name: '骤雨', desc: '雨点打在花瓣上', rain: 1,
    sunDir: V(0.40, 0.52, 0.75), sunColor: C(0.72, 0.76, 0.82), sunPower: 1.05, sunGlow: 0.20,
    skyTop: C(0.290, 0.330, 0.390), skyHorizon: C(0.560, 0.590, 0.630), skyGround: C(0.30, 0.32, 0.33),
    ambSky: C(0.440, 0.480, 0.560), ambGround: C(0.170, 0.190, 0.160), ambPower: 1.05,
    fogColor: C(0.590, 0.620, 0.670), fogDensity: 0.0056, fogHeight: 30,
    mist: 1.35, mistColor: C(0.66, 0.70, 0.75),
    cloudCover: 0.96, cloudDensity: 2.40, cloudShadow: 0.28, cloudTint: C(0.60, 0.63, 0.68),
    windDir: new THREE.Vector2(0.30, -0.95).normalize(), windStrength: 2.15,
    wetness: 1.0, exposure: 1.06,
  },
  {
    name: '雨霁', desc: '雾气从谷底升起', rain: 0.12,
    sunDir: V(0.66, 0.245, 0.71), sunColor: C(1.00, 0.86, 0.68), sunPower: 3.10, sunGlow: 1.55,
    skyTop: C(0.135, 0.310, 0.660), skyHorizon: C(0.820, 0.870, 0.925), skyGround: C(0.40, 0.44, 0.44),
    ambSky: C(0.360, 0.500, 0.790), ambGround: C(0.190, 0.245, 0.145), ambPower: 0.82,
    fogColor: C(0.780, 0.840, 0.900), fogDensity: 0.0032, fogHeight: 34,
    mist: 1.15, mistColor: C(0.86, 0.90, 0.95),
    cloudCover: 0.46, cloudDensity: 1.70, cloudShadow: 0.55, cloudTint: C(1.00, 0.97, 0.94),
    windDir: new THREE.Vector2(0.94, 0.34).normalize(), windStrength: 0.75,
    wetness: 0.60, exposure: 0.98,
  },
  {
    name: '暮金', desc: '夕照把草尖点亮', rain: 0,
    sunDir: V(0.82, 0.130, 0.56), sunColor: C(1.00, 0.635, 0.355), sunPower: 3.50, sunGlow: 2.1,
    skyTop: C(0.090, 0.195, 0.480), skyHorizon: C(0.980, 0.665, 0.425), skyGround: C(0.30, 0.24, 0.22),
    ambSky: C(0.330, 0.375, 0.610), ambGround: C(0.215, 0.155, 0.105), ambPower: 0.62,
    fogColor: C(0.930, 0.700, 0.520), fogDensity: 0.0031, fogHeight: 36,
    mist: 0.80, mistColor: C(0.95, 0.78, 0.62),
    cloudCover: 0.44, cloudDensity: 1.65, cloudShadow: 0.52, cloudTint: C(1.00, 0.855, 0.715),
    windDir: new THREE.Vector2(-0.72, 0.69).normalize(), windStrength: 0.62,
    wetness: 0.12, exposure: 1.00,
  },
];

// ---------------------------------------------------------------------------
// 雨：绕相机循环的实例化雨丝
// ---------------------------------------------------------------------------
const RAIN_VERT = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
attribute vec3 aPos;
attribute vec2 aRnd;   // x:速度 y:长度
uniform float uBox;
uniform float uAmount;
varying float vFade;

void main(){
  vec3 base = aPos;
  float fall = uTime * (14.0 + aRnd.x * 12.0);
  base.y = mod(base.y - fall, uBox);

  vec3 w = uCamPos + vec3(base.x, base.y - uBox * 0.42, base.z);

  // 雨丝方向：竖直 + 被风吹斜
  vec3 dir = normalize(vec3(-uWind.x * 0.30 * uWindStrength, -1.0, -uWind.y * 0.30 * uWindStrength));
  vec3 toCam = normalize(uCamPos - w);
  vec3 right = normalize(cross(dir, toCam) + 1e-5);

  float len = (0.9 + aRnd.y * 1.3) * (0.6 + uWindStrength * 0.25);
  vec3 p = w + right * position.x * 0.018 + dir * (position.y - 0.5) * len;

  float d = length(w - uCamPos);
  vFade = uAmount * smoothstep(uBox * 0.55, uBox * 0.22, d) * smoothstep(1.2, 4.0, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, uAmount > 0.01 ? 1.0 : 0.0);
}
`;

const RAIN_FRAG = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
varying float vFade;
void main(){
  if (vFade <= 0.005) discard;
  vec3 c = mix(uFogColor, vec3(1.0), 0.45) * 1.25;
  gl_FragColor = vec4(c, vFade * 0.30);
}
`;

function makeRain(count = 3200, box = 46) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.instanceCount = count;
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * box;
    pos[i * 3 + 1] = Math.random() * box;
    pos[i * 3 + 2] = (Math.random() - 0.5) * box;
    rnd[i * 2] = Math.random();
    rnd[i * 2 + 1] = Math.random();
  }
  geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
  geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.ShaderMaterial({
    uniforms: withEnv({ uBox: { value: box }, uAmount: { value: 0 } }),
    vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'rain';
  return mesh;
}

// ---------------------------------------------------------------------------
export class Weather {
  constructor(scene, { autoSeconds = 82 } = {}) {
    this.index = 0;
    this.targetIndex = 0;
    this.blend = 1;           // 0 → 1：向目标天气过渡的进度
    this.speed = 1 / 9.0;     // 约 9 秒完成一次天气转变
    this.timer = 0;
    this.autoSeconds = autoSeconds;
    this.flash = 0;

    this.rain = makeRain();
    scene.add(this.rain);
    this.rainAmount = 0;

    this.from = PRESETS[0];
    this.to = PRESETS[0];
    this.apply(1);
  }

  get preset() { return this.blend < 0.5 ? this.from : this.to; }
  get name() { return this.preset.name; }
  get desc() { return this.preset.desc; }

  next(i) {
    this.from = this._snapshot();
    this.targetIndex = (i === undefined) ? (this.targetIndex + 1) % PRESETS.length : i % PRESETS.length;
    this.to = PRESETS[this.targetIndex];
    this.blend = 0;
    this.timer = 0;
    return this.to;
  }

  // 当前实际生效的值（过渡中途切换时不会跳变）
  _snapshot() {
    const u = env.uniforms;
    return {
      name: this.to.name, desc: this.to.desc, rain: this.rainAmount,
      sunDir: u.uSunDir.value.clone(), sunColor: u.uSunColor.value.clone(),
      sunPower: u.uSunPower.value, sunGlow: u.uSunGlow.value,
      skyTop: u.uSkyTop.value.clone(), skyHorizon: u.uSkyHorizon.value.clone(),
      skyGround: u.uSkyGround.value.clone(),
      ambSky: u.uAmbSky.value.clone(), ambGround: u.uAmbGround.value.clone(), ambPower: u.uAmbPower.value,
      fogColor: u.uFogColor.value.clone(), fogDensity: u.uFogDensity.value, fogHeight: u.uFogHeight.value,
      mist: u.uMistStrength.value, mistColor: u.uMistColor.value.clone(),
      cloudCover: u.uCloudCover.value, cloudDensity: u.uCloudDensity.value,
      cloudShadow: u.uCloudShadow.value, cloudTint: u.uCloudTint.value.clone(),
      windDir: u.uWind.value.clone(), windStrength: u.uWindStrength.value,
      wetness: u.uWetness.value, exposure: u.uExposure.value,
    };
  }

  apply(t) {
    const u = env.uniforms, a = this.from, b = this.to;
    const k = t * t * (3 - 2 * t);
    const L = (x, y) => x + (y - x) * k;
    const LC = (dst, x, y) => dst.copy(x).lerp(y, k);

    u.uSunDir.value.copy(a.sunDir).lerp(b.sunDir, k).normalize();
    LC(u.uSunColor.value, a.sunColor, b.sunColor);
    u.uSunPower.value = L(a.sunPower, b.sunPower);
    u.uSunGlow.value = L(a.sunGlow, b.sunGlow);
    LC(u.uSkyTop.value, a.skyTop, b.skyTop);
    LC(u.uSkyHorizon.value, a.skyHorizon, b.skyHorizon);
    LC(u.uSkyGround.value, a.skyGround, b.skyGround);
    LC(u.uAmbSky.value, a.ambSky, b.ambSky);
    LC(u.uAmbGround.value, a.ambGround, b.ambGround);
    u.uAmbPower.value = L(a.ambPower, b.ambPower);
    LC(u.uFogColor.value, a.fogColor, b.fogColor);
    u.uFogDensity.value = L(a.fogDensity, b.fogDensity);
    u.uFogHeight.value = L(a.fogHeight, b.fogHeight);
    u.uMistStrength.value = L(a.mist, b.mist);
    LC(u.uMistColor.value, a.mistColor, b.mistColor);
    u.uCloudCover.value = L(a.cloudCover, b.cloudCover);
    u.uCloudDensity.value = L(a.cloudDensity, b.cloudDensity);
    u.uCloudShadow.value = L(a.cloudShadow, b.cloudShadow);
    LC(u.uCloudTint.value, a.cloudTint, b.cloudTint);
    u.uWind.value.copy(a.windDir).lerp(b.windDir, k).normalize();
    u.uWindStrength.value = L(a.windStrength, b.windStrength);
    u.uWetness.value = L(a.wetness, b.wetness);
    u.uExposure.value = L(a.exposure, b.exposure) * (1.0 + this.flash * 1.9);

    this.rainAmount = L(a.rain, b.rain);
    this.rain.material.uniforms.uAmount.value = this.rainAmount;
    this.rain.visible = this.rainAmount > 0.01;
  }

  update(dt) {
    this.timer += dt;
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt * this.speed);
    } else if (this.autoSeconds > 0 && this.timer > this.autoSeconds) {
      this.next();
    }
    // 雨中偶尔的闪电
    if (this.rainAmount > 0.6) {
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3.6);
      else if (Math.random() < dt * 0.055) this.flash = 0.55 + Math.random() * 0.45;
    } else {
      this.flash = Math.max(0, this.flash - dt * 3.0);
    }
    this.apply(this.blend);
  }
}
