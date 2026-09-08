// -----------------------------------------------------------------------------
// common.js — 全场共享的 GLSL 片段。
// 天空、体积云、云影、雾 全部来自同一套噪声函数，所以"天上那片云"和
// "地上那块阴影"永远是同一块云。
// -----------------------------------------------------------------------------

export const ENV_UNIFORMS = /* glsl */`
uniform float uTime;
uniform float uCloudTime;
uniform float uWindPhase;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunPower;
uniform vec3  uSkyTop;
uniform vec3  uSkyHorizon;
uniform vec3  uSkyGround;
uniform vec3  uAmbSky;
uniform vec3  uAmbGround;
uniform float uAmbPower;
uniform float uSunGlow;

uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFogGround;

uniform float uCloudCover;
uniform float uCloudShadow;
uniform float uCloudScale;
uniform float uCloudBottom;
uniform float uCloudTop;
uniform float uCloudDensity;
uniform vec3  uCloudTint;

uniform vec2  uWind;
uniform float uWindStrength;
uniform float uWetness;

uniform vec3  uGrassDeep;
uniform vec3  uGrassLit;
uniform vec3  uGrassDry;

uniform sampler2D uBloomMap;
uniform float uBloomWorld;

uniform float uMistStrength;
uniform float uMistBase;
uniform float uMistHeight;
uniform vec3  uMistColor;

uniform vec3  uCamPos;
uniform float uExposure;
uniform float uDebug;
`;

export const NOISE = /* glsl */`
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash31(vec3 p){
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1,0,0));
  float n010 = hash31(i + vec3(0,1,0));
  float n110 = hash31(i + vec3(1,1,0));
  float n001 = hash31(i + vec3(0,0,1));
  float n101 = hash31(i + vec3(1,0,1));
  float n011 = hash31(i + vec3(0,1,1));
  float n111 = hash31(i + vec3(1,1,1));
  return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
             mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
}
float fbm2n(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a * vnoise(p); n += a;
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}
float fbm3n(vec3 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 5; i++){
    if (i >= oct) break;
    s += a * vnoise3(p); n += a;
    p = p * 2.11 + vec3(11.3, 7.9, 5.1);
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}
`;

// 云的 2D 覆盖场：天空里的体积云与地面的云影都由它驱动
export const CLOUD = /* glsl */`
vec2 cloudDrift(){
  // 云随风飘，速度比地面风慢，尺度更大
  return uWind * uCloudTime * 3.4;
}
float cloudShape(vec2 xz){
  vec2 q = (xz + cloudDrift()) * uCloudScale;
  float f = fbm2n(q, 4);
  f = mix(f, fbm2n(q * 2.9 + 13.0, 3), 0.32);      // 打碎大团，形成"一片片"
  f += 0.10 * fbm2n(q * 7.3 - vec2(uCloudTime * 0.05), 2);
  return f;
}
float cloudCoverage(vec2 xz){
  float f = cloudShape(xz);
  // fbm 均值约 0.5：阈值必须落在这个区间里，云量才有意义
  float lo = mix(0.635, 0.285, clamp(uCloudCover, 0.0, 1.0));
  return smoothstep(lo, lo + 0.26, f);
}
// 地面收到的阳光遮蔽：把着色点沿太阳方向投影到云层高度再采样覆盖场
float cloudShadowAt(vec3 wp){
  float t = (uCloudBottom - wp.y) / max(uSunDir.y, 0.12);
  vec2 sp = wp.xz + uSunDir.xz * t;
  float c = cloudCoverage(sp);
  // 边缘柔化，避免硬边
  float soft = smoothstep(0.0, 0.78, c);
  return 1.0 - uCloudShadow * soft;
}
`;

// 天空 + 大气雾：地形/草/花/花瓣共用，保证远景与天空无缝相接
export const ATMOS = /* glsl */`
vec3 skyColor(vec3 dir){
  float up = clamp(dir.y, -1.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyTop, pow(clamp(up, 0.0, 1.0), 0.62));
  c = mix(uSkyGround, c, smoothstep(-0.22, 0.045, up));
  float sd = max(dot(dir, uSunDir), 0.0);
  // 太阳周围的辉光（不含日面本体，日面在天空 shader 里画）
  c += uSunColor * uSunGlow * (pow(sd, 5.0) * 0.22 + pow(sd, 42.0) * 0.55);
  return c;
}
// 指数高度雾的解析积分，带空气透视（雾色取自视线方向的天空色）
vec3 applyAtmosphere(vec3 col, vec3 wp, vec3 camPos){
  vec3 v = wp - camPos;
  float d = length(v);
  vec3 dir = v / max(d, 1e-4);
  float b = 1.0 / max(uFogHeight, 1.0);
  float dy = dir.y;
  float amount;
  if (abs(dy) < 1e-3) {
    amount = uFogDensity * exp(-camPos.y * b) * d;
  } else {
    amount = (uFogDensity / (b * dy)) * exp(-camPos.y * b) * (1.0 - exp(-d * dy * b));
  }
  amount = clamp(amount, 0.0, 1.0);
  float f = 1.0 - exp(-max(amount, 0.0));
  vec3 fogCol = mix(uFogColor, skyColor(dir), 0.78);
  // 逆光时雾更亮（前向散射）
  float fs = max(dot(dir, uSunDir), 0.0);
  fogCol += uSunColor * pow(fs, 8.0) * 0.35 * uSunGlow;
  return mix(col, fogCol, f);
}
`;

// 高度场采样（手写双线性，避免依赖浮点纹理线性过滤扩展）
export const HEIGHTFIELD = /* glsl */`
uniform sampler2D uHF;
uniform vec2  uHFRes;      // (res, res)
uniform float uHFSize;     // 世界边长

vec4 sampleHF(vec2 xz){
  vec2 g = (xz / uHFSize + 0.5) * (uHFRes - 1.0);   // 网格坐标 0..res-1
  g = clamp(g, vec2(0.0), uHFRes - 1.001);
  vec2 i = floor(g), f = g - i;
  vec2 texel = 1.0 / uHFRes;
  vec2 base = (i + 0.5) * texel;
  vec4 a = texture2D(uHF, base);
  vec4 b = texture2D(uHF, base + vec2(texel.x, 0.0));
  vec4 c = texture2D(uHF, base + vec2(0.0, texel.y));
  vec4 d = texture2D(uHF, base + texel);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float heightAt(vec2 xz){ return sampleHF(xz).r; }
vec3  normalAt(vec2 xz){
  vec4 s = sampleHF(xz);
  return normalize(vec3(s.g, sqrt(max(1.0 - s.g * s.g - s.b * s.b, 0.02)), s.b));
}
`;

// 世界空间"绽放度"贴图：花瓣走过的地方 → 逐渐长花
export const BLOOMMAP = /* glsl */`
float bloomAt(vec2 xz){
  vec2 uv = xz / uBloomWorld + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(uBloomMap, uv).r;
}
`;

// 风场：多频叠加 → 风吹麦浪
export const WIND = /* glsl */`
// 返回 (沿风向的弯曲量, 侧向抖动量, 波峰亮度 0..1)
vec3 windField(vec2 xz){
  vec2 w = normalize(uWind + 1e-5);
  float t = uWindPhase;
  float along = dot(xz, w);
  float side  = dot(xz, vec2(-w.y, w.x));

  // 大尺度阵风波：这是"麦浪"的主旋律
  float g1 = sin(along * 0.062 - t * 1.25);
  float g2 = sin(along * 0.031 + side * 0.017 - t * 0.72);
  float gust = (g1 * 0.55 + g2 * 0.45);
  gust = gust * 0.5 + 0.5;                       // 0..1
  gust = pow(gust, 1.6);                         // 波峰更锐利，波谷更平静

  // 中尺度扰动，打散规则感
  float m = fbm2n(xz * 0.055 + w * t * 0.55, 3);
  // 小尺度颤动
  float s = sin(along * 0.62 - t * 3.1 + m * 6.28) * 0.5 + 0.5;

  float bend = (gust * 0.78 + m * 0.30 + s * 0.10) * uWindStrength;
  float sway = (sin(side * 0.35 + t * 1.9 + m * 5.0)) * 0.34 * uWindStrength;
  return vec3(bend, sway, gust);
}
`;

// 线性 → sRGB（最终输出手动做，后期链全程线性 HDR）
export const COLORSPACE = /* glsl */`
vec3 linearToSRGB(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
// ACES filmic（Narkowicz 近似）——电影感的关键一环
vec3 acesTonemap(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
`;
