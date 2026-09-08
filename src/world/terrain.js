// -----------------------------------------------------------------------------
// terrain.js — 起伏大地。风格化草色着色 + 云影 + 大气雾 + 绽放贴图染色。
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { env, withEnv } from '../core/env.js';
import { ENV_UNIFORMS, NOISE, CLOUD, ATMOS, BLOOMMAP } from '../shaders/common.js';

const VERT = /* glsl */`
varying vec3 vWorld;
varying vec3 vNormal;
varying float vWet;
attribute float wet;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(normalMatrix * normal);
  vWet = wet;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
${NOISE}
${CLOUD}
${ATMOS}
${BLOOMMAP}
varying vec3 vWorld;
varying vec3 vNormal;
varying float vWet;

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  float dist = length(uCamPos - vWorld);

  // ---- 地表基色：草色随湿润度/坡度/斑块变化 ----
  float blotch  = fbm2n(vWorld.xz * 0.043, 3);
  float mottle = fbm2n(vWorld.xz * 0.0075 + 31.0, 3);
  float wetness = clamp(vWet * 0.75 + mottle * 0.45, 0.0, 1.0);

  vec3 grass = mix(uGrassDeep, uGrassLit, smoothstep(0.18, 0.86, wetness * 0.55 + blotch * 0.55));
  grass = mix(grass, uGrassDry, smoothstep(0.62, 1.0, mottle) * 0.55);

  // 陡坡露出土壤
  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  vec3 soil = mix(vec3(0.300, 0.222, 0.140), vec3(0.455, 0.372, 0.252), blotch);
  grass = mix(grass, soil, smoothstep(0.42, 0.78, slope));

  // ---- 绽放：走过的地方地面更翠更亮，并透出花田的暖色 ----
  float bl = bloomAt(vWorld.xz);
  vec3 lush = mix(grass, vec3(0.34, 0.62, 0.20), 0.55);
  lush = mix(lush, vec3(0.52, 0.60, 0.26), blotch * 0.4);
  grass = mix(grass, lush, smoothstep(0.02, 0.55, bl));

  // 近处叠一层细密噪声，模拟"看不见的草"，让草坪边界自然消融进远景
  float det = fbm2n(vWorld.xz * 1.6, 2) * 0.6 + fbm2n(vWorld.xz * 0.42, 2) * 0.4;
  float detFade = 1.0 - smoothstep(26.0, 130.0, dist);
  grass *= mix(1.0, 0.80 + 0.44 * det, detFade * 0.9);

  // 洼地略深、丘顶略亮（廉价 AO / 曲率感）
  float lowland = smoothstep(14.0, -6.0, vWorld.y);
  grass *= mix(1.0, 0.86, lowland * 0.6);

  // ---- 光照 ----
  float sh = cloudShadowAt(vWorld);
  if (uDebug > 0.5) { gl_FragColor = vec4(vec3(sh), 1.0); return; }
  float ndl = max(dot(N, uSunDir), 0.0);
  // wrapped lambert：让草地在背光侧也保有通透感
  float wrap = clamp((dot(N, uSunDir) + 0.35) / 1.35, 0.0, 1.0);
  vec3 diffuse = uSunColor * uSunPower * mix(ndl, wrap, 0.65) * sh;

  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * uAmbPower;
  amb *= mix(0.72, 1.0, sh);   // 云影里天光也略降

  grass *= mix(1.0, 0.72, uWetness);        // 淋湿的地面更深
  vec3 col = grass * (diffuse + amb) * 0.42;

  // 湿地/雨后的柔和高光
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), mix(28.0, 90.0, uWetness));
  col += uSunColor * spec * (0.02 + uWetness * 0.16) * sh;

  // 逆光边缘的草绒毛感
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += uSunColor * rim * 0.05 * max(dot(uSunDir, -V), 0.0) * sh;

  col = applyAtmosphere(col, vWorld, uCamPos);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createTerrain(hf, { segments = 512 } = {}) {
  const size = hf.size;
  const half = size * 0.5;
  const n = segments + 1;
  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const wet = new Float32Array(n * n);
  const stride = size / segments;

  for (let j = 0; j < n; j++) {
    const z = -half + j * stride;
    for (let i = 0; i < n; i++) {
      const x = -half + i * stride;
      const o = (j * n + i) * 3;
      const h = hf.heightAt(x, z);
      pos[o] = x; pos[o + 1] = h; pos[o + 2] = z;
      const nv = hf.normalAt(x, z);
      nor[o] = nv.x; nor[o + 1] = nv.y; nor[o + 2] = nv.z;
      // 复用高度场里的湿润度通道
      const res = hf.res;
      const gi = Math.min(res - 1, Math.max(0, Math.round((x / size + 0.5) * (res - 1))));
      const gj = Math.min(res - 1, Math.max(0, Math.round((z / size + 0.5) * (res - 1))));
      wet[j * n + i] = hf.data[(gj * res + gi) * 4 + 3];
    }
  }

  const idx = new Uint32Array(segments * segments * 6);
  let k = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('wet', new THREE.BufferAttribute(wet, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    uniforms: withEnv(),
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.frustumCulled = false;
  return mesh;
}
