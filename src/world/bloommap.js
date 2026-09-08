// -----------------------------------------------------------------------------
// bloommap.js — 世界空间"绽放度"贴图。
// 花瓣飘过 → 往图里加性喷涂一笔 → 地面着色变翠、花朵实例逐渐长大。
// 一张 1024² 的 RT 覆盖整个世界，写入极廉价（每帧一个小四边形）。
// -----------------------------------------------------------------------------
import * as THREE from 'three';

const SPLAT_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SPLAT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec2  uCenter;    // 归一化 0..1
uniform float uRadius;    // 归一化半径
uniform float uStrength;
uniform float uAspect;
void main(){
  vec2 d = (vUv - uCenter);
  float r = length(d) / max(uRadius, 1e-5);
  if (r > 1.0) discard;
  // 柔和笔刷 + 边缘细碎，避免出现完美圆形
  float a = pow(1.0 - r, 2.2);
  gl_FragColor = vec4(vec3(a * uStrength), 1.0);
}
`;

export class BloomMap {
  constructor(renderer, { size = 1024, world = 512 } = {}) {
    this.renderer = renderer;
    this.world = world;
    this.size = size;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.ClampToEdgeWrapping;

    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uCenter:   { value: new THREE.Vector2(0.5, 0.5) },
        uRadius:   { value: 0.01 },
        uStrength: { value: 0.1 },
        uAspect:   { value: 1 },
      },
      vertexShader: SPLAT_VERT,
      fragmentShader: SPLAT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this._painted = 0;      // 累计喷涂量，用于估算"已绽放"数量
    this.clear();
  }

  clear() {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(prev);
    this._painted = 0;
  }

  /** 在世界坐标 (x,z) 处喷一笔。radius 单位为米。 */
  splat(x, z, radius, strength) {
    const u = x / this.world + 0.5;
    const v = z / this.world + 0.5;
    if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) return;
    this.mat.uniforms.uCenter.value.set(u, v);
    this.mat.uniforms.uRadius.value = radius / this.world;
    this.mat.uniforms.uStrength.value = strength;
    const prev = this.renderer.getRenderTarget();
    const prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
    this.renderer.autoClear = prevAuto;
    this._painted += radius * radius * strength;
  }

  get texture() { return this.rt.texture; }

  /** 粗略估算已绽放花朵数（用于 HUD） */
  get bloomedEstimate() { return Math.floor(this._painted * 2.4); }
}
