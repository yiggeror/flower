// -----------------------------------------------------------------------------
// composer.js — 自建后期链（不用 EffectComposer，因为需要精确掌控深度与半分辨率）
//   场景 → 体积云/雾气(半分辨率) → 合成 → 景深 → 泛光 → 调色 → FXAA → 屏幕
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { env, withEnv } from '../core/env.js';
import {
  QUAD_VERT, ATMOS_FRAG, COMPOSITE_FRAG, DOF_FRAG,
  BRIGHT_FRAG, BLUR_FRAG, DOWN_FRAG, GRADE_FRAG, FXAA_FRAG,
} from './passes.js';

const rtOpts = {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
};

function makeRT(w, h, extra) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), Object.assign({}, rtOpts, extra));
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

export class PostFX {
  constructor(renderer, scene, camera, quality = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.q = Object.assign({
      atmosScale: 0.5,
      cloudSteps: 34,
      lightSteps: 5,
      mistSteps: 14,
      bloomLevels: 5,
    }, quality);

    this.frame = 0;
    this.invViewProj = new THREE.Matrix4();

    // --- 材质 ---
    this.mAtmos = new THREE.ShaderMaterial({
      uniforms: withEnv({
        tDepth:      { value: null },
        uInvViewProj:{ value: new THREE.Matrix4() },
        uNear:       { value: 0.1 },
        uFar:        { value: 1000 },
        uCloudSteps: { value: this.q.cloudSteps },
        uLightSteps: { value: this.q.lightSteps },
        uMistSteps:  { value: this.q.mistSteps },
        uFrame:      { value: 0 },
      }),
      vertexShader: QUAD_VERT, fragmentShader: ATMOS_FRAG, depthTest: false, depthWrite: false,
    });

    this.mComposite = new THREE.ShaderMaterial({
      uniforms: withEnv({
        tDiffuse: { value: null }, tAtmos: { value: null },
        tDepth: { value: null }, uInvViewProj: { value: new THREE.Matrix4() },
        uNear: { value: 0.1 }, uFar: { value: 1000 },
        uTexel: { value: new THREE.Vector2() },
      }),
      vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
    });

    this.mDof = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uNear: { value: 0.1 }, uFar: { value: 1000 },
        uTexel: { value: new THREE.Vector2() },
        uFocus: { value: 12 }, uAperture: { value: 0.3 }, uMaxCoc: { value: 14 },
      },
      vertexShader: QUAD_VERT, fragmentShader: DOF_FRAG, depthTest: false, depthWrite: false,
    });

    this.mBright = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 1.05 }, uSoft: { value: 0.65 } },
      vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
    });
    this.mDown = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT, fragmentShader: DOWN_FRAG, depthTest: false, depthWrite: false,
    });
    this.mBlur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
    });
    this.mAdd = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: QUAD_VERT,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tDiffuse;
                       void main(){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); }`,
      depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });

    this.mGrade = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tBloom: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uExposureG: { value: 0.94 },
        uBloomStrength: { value: 0.17 },
        uVignette: { value: 1.25 },
        uGrain: { value: 0.022 },
        uTimeG: { value: 0 },
        uSaturation: { value: 1.26 },
        uContrast: { value: 1.25 },
        uLift: { value: new THREE.Vector3(0.005, 0.010, 0.020) },
        uGain: { value: new THREE.Vector3(1.035, 1.008, 0.968) },
        uCA: { value: 0.0055 },
      },
      vertexShader: QUAD_VERT, fragmentShader: GRADE_FRAG, depthTest: false, depthWrite: false,
    });

    this.mFxaa = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT, fragmentShader: FXAA_FRAG, depthTest: false, depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.mComposite);
    this.setSize(renderer.domElement.width, renderer.domElement.height);
  }

  setSize(w, h) {
    w = Math.max(2, Math.floor(w));
    h = Math.max(2, Math.floor(h));
    this.width = w; this.height = h;
    const dispose = (rt) => rt && rt.dispose();

    dispose(this.rtScene); dispose(this.rtA); dispose(this.rtB); dispose(this.rtAtmos);
    (this.mips || []).forEach(dispose);
    (this.mipTmp || []).forEach(dispose);

    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    this.rtScene = makeRT(w, h, { depthBuffer: true, depthTexture: depth });
    this.rtA = makeRT(w, h);
    this.rtB = makeRT(w, h);

    const as = this.q.atmosScale;
    this.rtAtmos = makeRT(Math.ceil(w * as), Math.ceil(h * as));

    this.mips = []; this.mipTmp = [];
    let mw = Math.ceil(w / 2), mh = Math.ceil(h / 2);
    for (let i = 0; i < this.q.bloomLevels; i++) {
      this.mips.push(makeRT(mw, mh));
      this.mipTmp.push(makeRT(mw, mh));
      mw = Math.max(2, Math.ceil(mw / 2));
      mh = Math.max(2, Math.ceil(mh / 2));
    }
  }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target || null);
    this.quad.render(this.renderer);
  }

  render(dt, rig) {
    const r = this.renderer, cam = this.camera;
    this.frame++;

    // 1) 场景
    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(this.scene, cam);

    // 通用相机矩阵
    this.invViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();

    // 2) 体积云 + 地面雾气（半分辨率）
    const ua = this.mAtmos.uniforms;
    ua.tDepth.value = this.rtScene.depthTexture;
    ua.uInvViewProj.value.copy(this.invViewProj);
    ua.uNear.value = cam.near; ua.uFar.value = cam.far;
    ua.uFrame.value = this.frame % 64;
    this._blit(this.mAtmos, this.rtAtmos);

    // 3) 合成
    const uc = this.mComposite.uniforms;
    uc.tDiffuse.value = this.rtScene.texture;
    uc.tAtmos.value = this.rtAtmos.texture;
    uc.tDepth.value = this.rtScene.depthTexture;
    uc.uInvViewProj.value.copy(this.invViewProj);
    uc.uNear.value = cam.near; uc.uFar.value = cam.far;
    uc.uTexel.value.set(1 / this.width, 1 / this.height);
    this._blit(this.mComposite, this.rtA);

    // 4) 景深
    const ud = this.mDof.uniforms;
    ud.tDiffuse.value = this.rtA.texture;
    ud.tDepth.value = this.rtScene.depthTexture;
    ud.uNear.value = cam.near; ud.uFar.value = cam.far;
    ud.uTexel.value.set(1 / this.width, 1 / this.height);
    ud.uFocus.value = rig ? rig.focusDistance : 12;
    ud.uAperture.value = rig ? rig.aperture : 0.2;
    // 按短边算并封顶：竖屏手机的高度是宽度的两倍多，
    // 若按高度算，背景会被糊成一片。
    ud.uMaxCoc.value = Math.min(22, Math.max(6, Math.min(this.width, this.height) * 0.026));
    this._blit(this.mDof, this.rtB);

    // 5) 泛光
    this.mBright.uniforms.tDiffuse.value = this.rtB.texture;
    this._blit(this.mBright, this.mips[0]);
    for (let i = 1; i < this.mips.length; i++) {
      this.mDown.uniforms.tDiffuse.value = this.mips[i - 1].texture;
      this.mDown.uniforms.uTexel.value.set(1 / this.mips[i - 1].width, 1 / this.mips[i - 1].height);
      this._blit(this.mDown, this.mips[i]);
    }
    for (let i = 0; i < this.mips.length; i++) {
      const m = this.mips[i], t = this.mipTmp[i];
      this.mBlur.uniforms.tDiffuse.value = m.texture;
      this.mBlur.uniforms.uDir.value.set(1 / m.width, 0);
      this._blit(this.mBlur, t);
      this.mBlur.uniforms.tDiffuse.value = t.texture;
      this.mBlur.uniforms.uDir.value.set(0, 1 / m.height);
      this._blit(this.mBlur, m);
    }
    // 由小到大逐级相加，得到柔和的多尺度光晕
    const prevAuto = r.autoClear;
    r.autoClear = false;
    for (let i = this.mips.length - 1; i > 0; i--) {
      this.mAdd.uniforms.tDiffuse.value = this.mips[i].texture;
      this._blit(this.mAdd, this.mips[i - 1]);
    }
    r.autoClear = prevAuto;

    // 6) 调色
    const ug = this.mGrade.uniforms;
    ug.tDiffuse.value = this.rtB.texture;
    ug.tBloom.value = this.mips[0].texture;
    ug.uTexel.value.set(1 / this.width, 1 / this.height);
    ug.uTimeG.value = (env.time * 37.0) % 1000.0;
    ug.uExposureG.value = env.uniforms.uExposure.value;
    this._blit(this.mGrade, this.rtA);

    // 7) FXAA → 屏幕
    this.mFxaa.uniforms.tDiffuse.value = this.rtA.texture;
    this.mFxaa.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this._blit(this.mFxaa, null);
  }
}
