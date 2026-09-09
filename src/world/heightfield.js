// -----------------------------------------------------------------------------
// heightfield.js — 起伏地形的高度场。
// CPU 生成一次，同时提供：
//   · 给地形网格的逐顶点高度（与着色器采样完全对齐，草不会浮空或陷地）
//   · 给 GPU 的数据纹理 R=高度 G/B=法线xz A=湿润度(决定草色与花的密度)
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { fbm2, ridge2, valueNoise2 } from '../core/rng.js';

export class Heightfield {
  constructor({ size = 512, res = 513, seed = 20240918 } = {}) {
    this.size = size;
    this.res = res;
    this.step = size / (res - 1);
    this.seed = seed;
    this.heights = new Float32Array(res * res);
    this.data = new Float32Array(res * res * 4);
    this._build();
  }

  // 地形造型函数：大丘陵 + 山脊骨架 + 缓谷 + 细节
  _shape(x, z) {
    const s = this.seed;
    // 大尺度起伏
    let h = (fbm2(x * 0.0042, z * 0.0042, 5, s) - 0.5) * 2.0 * 26.0;
    // 山脊：给远景一点轮廓层次
    h += (ridge2(x * 0.0085, z * 0.0085, 4, s + 77) - 0.35) * 22.0;
    // 中尺度坡面
    h += (fbm2(x * 0.017, z * 0.017, 4, s + 191) - 0.5) * 2.0 * 5.2;
    // 细节
    h += (fbm2(x * 0.075, z * 0.075, 3, s + 313) - 0.5) * 2.0 * 0.85;

    // 谷地压平：让低处形成可以积雾的盆地
    const basin = fbm2(x * 0.0031 + 40.0, z * 0.0031 - 25.0, 3, s + 555);
    const valley = Math.pow(1.0 - Math.min(1.0, Math.abs(basin - 0.42) * 3.4), 2.0);
    h -= valley * 11.0;

    // 出生地附近做一片开阔缓坡草原
    const d = Math.hypot(x, z);
    const home = Math.exp(-(d * d) / (2 * 62 * 62));
    h = h * (1.0 - home * 0.72) + (2.0 + valueNoise2(x * 0.02, z * 0.02, s) * 1.2) * home * 0.72;

    // 世界边缘缓缓抬起并被雾吞掉，避免看到"世界的尽头"
    const edge = Math.max(0, (d - this.size * 0.34) / (this.size * 0.16));
    h += Math.pow(Math.min(edge, 1.6), 2.0) * 26.0;
    return h;
  }

  _build() {
    const { res, step, size, heights, data } = this;
    const half = size * 0.5;
    for (let j = 0; j < res; j++) {
      const z = -half + j * step;
      for (let i = 0; i < res; i++) {
        const x = -half + i * step;
        heights[j * res + i] = this._shape(x, z);
      }
    }
    // 法线（中心差分）+ 湿润度
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(res - 1, i + 1);
        const j0 = Math.max(0, j - 1), j1 = Math.min(res - 1, j + 1);
        const hx = (heights[j * res + i1] - heights[j * res + i0]) / ((i1 - i0) * step);
        const hz = (heights[j1 * res + i] - heights[j0 * res + i]) / ((j1 - j0) * step);
        // 法线 = normalize(-dh/dx, 1, -dh/dz)
        const inv = 1.0 / Math.sqrt(hx * hx + 1.0 + hz * hz);
        const x = -half + i * step, z = -half + j * step;
        const wet = fbm2(x * 0.011 + 300.0, z * 0.011 - 120.0, 4, this.seed + 909);
        const o = (j * res + i) * 4;
        data[o + 0] = heights[j * res + i];
        data[o + 1] = -hx * inv;
        data[o + 2] = -hz * inv;
        data[o + 3] = wet;
      }
    }
    const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter;   // 着色器里手写双线性
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
  }

  // 与 GLSL sampleHF 完全一致的双线性取值
  heightAt(x, z) {
    const { res, size, heights } = this;
    let g0 = (x / size + 0.5) * (res - 1);
    let g1 = (z / size + 0.5) * (res - 1);
    g0 = Math.min(Math.max(g0, 0), res - 1.001);
    g1 = Math.min(Math.max(g1, 0), res - 1.001);
    const i = Math.floor(g0), j = Math.floor(g1);
    const fx = g0 - i, fz = g1 - j;
    const a = heights[j * res + i];
    const b = heights[j * res + i + 1];
    const c = heights[(j + 1) * res + i];
    const d = heights[(j + 1) * res + i + 1];
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
  }

  normalAt(x, z) {
    const e = 1.2;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return new THREE.Vector3(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }

  // 供草/花/雾等采样的 uniform
  uniforms() {
    return {
      uHF:     { value: this.texture },
      uHFRes:  { value: new THREE.Vector2(this.res, this.res) },
      uHFSize: { value: this.size },
    };
  }
}
