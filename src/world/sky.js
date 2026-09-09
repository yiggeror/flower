// -----------------------------------------------------------------------------
// sky.js — 程序化天穹。日面、天光渐变、地平线雾带。体积云由后期通道叠加。
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { withEnv } from '../core/env.js';
import { ENV_UNIFORMS, NOISE, ATMOS } from '../shaders/common.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;   // 永远贴在远裁剪面
}
`;

const FRAG = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
${NOISE}
${ATMOS}
varying vec3 vDir;
void main(){
  vec3 dir = normalize(vDir);
  vec3 col = skyColor(dir);

  // 日面
  float sd = dot(dir, uSunDir);
  float disc = smoothstep(0.99955, 0.99985, sd);
  col += uSunColor * disc * 18.0 * uSunGlow;

  // 地平线的雾带，与地面的大气雾对接
  float horizon = 1.0 - smoothstep(0.0, 0.16, abs(dir.y));
  col = mix(col, mix(uFogColor, col, 0.35), horizon * 0.75 * clamp(uFogDensity * 70.0, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSky() {
  const geo = new THREE.SphereGeometry(1, 48, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: withEnv(),
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}
