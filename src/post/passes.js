// -----------------------------------------------------------------------------
// passes.js — 后期通道的着色器。
// 体积云与地面雾气在半分辨率里光线步进；随后是景深、泛光、电影调色。
// -----------------------------------------------------------------------------
import { ENV_UNIFORMS, NOISE, CLOUD, ATMOS, COLORSPACE } from '../shaders/common.js';

export const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DEPTH_UTIL = /* glsl */`
uniform sampler2D tDepth;
uniform mat4  uInvViewProj;
uniform float uNear;
uniform float uFar;

float rawDepth(vec2 uv){ return texture2D(tDepth, uv).x; }
bool isSky(float d){ return d >= 0.999995; }
float viewDistance(float d){
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
vec3 worldFromDepth(vec2 uv, float d){
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 w = uInvViewProj * clip;
  return w.xyz / w.w;
}
`;

// ---------------------------------------------------------------------------
// 体积云 + 地面雾气（半分辨率）
// 输出 rgb = 内散射光, a = 透过率
// ---------------------------------------------------------------------------
export const ATMOS_FRAG = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
${NOISE}
${CLOUD}
${ATMOS}
${DEPTH_UTIL}
varying vec2 vUv;

uniform float uCloudSteps;
uniform float uLightSteps;
uniform float uMistSteps;
uniform float uFrame;

// 云的体密度：2D 覆盖场（与地面云影同源）× 高度剖面 － 3D 侵蚀噪声
float cloudDensity(vec3 p){
  float hN = (p.y - uCloudBottom) / max(uCloudTop - uCloudBottom, 1.0);
  if (hN < 0.0 || hN > 1.0) return 0.0;
  float prof = smoothstep(0.0, 0.16, hN) * smoothstep(1.0, 0.46, hN);

  // 风切变：云顶比云底顺风偏移，云才不会是一根根竖直的柱子
  vec2 shear = normalize(uWind + 1e-5) * (hN - 0.5) * 130.0;
  float f = cloudShape(p.xz + shear);
  float lo = mix(0.635, 0.285, clamp(uCloudCover, 0.0, 1.0));
  float base = smoothstep(lo, lo + 0.26, f);

  float d = base * prof;
  // 3D 侵蚀：把边缘啃出蓬松的絮状
  vec3 q = p * 0.0075 + vec3(uCloudTime * 0.06, uCloudTime * 0.02, uCloudTime * 0.04);
  float ero = fbm3n(q, 3);
  d -= (1.0 - base * 0.55) * ero * 0.44;
  d -= smoothstep(0.62, 1.0, ero) * 0.12;
  d = max(d, 0.0);
  return d * uCloudDensity;
}

float henyey(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

const float SIGMA = 0.020;   // 每单位密度每米的消光系数

// 朝太阳方向做短程步进，得到自阴影；再加一点多次散射的近似，
// 否则云的背面会黑得像石头。
float lightMarch(vec3 p){
  float t = 0.0, tau = 0.0;
  float step = 30.0;
  for (int i = 0; i < 6; i++){
    if (float(i) >= uLightSteps) break;
    t += step;
    tau += cloudDensity(p + uSunDir * t) * step * SIGMA;
    step *= 1.35;
  }
  return exp(-tau) + 0.42 * exp(-tau * 0.22) + 0.14 * exp(-tau * 0.06);
}

float mistDensity(vec3 p){
  float h = exp(-max(p.y - uMistBase, 0.0) / max(uMistHeight, 0.5));
  vec2 dr = uWind * uTime * 0.9;
  float n = fbm2n(p.xz * 0.013 + dr * 0.02, 3);
  n = 0.35 + 1.05 * n;
  // 高处的薄雾丝
  float wisp = fbm2n(p.xz * 0.055 - dr * 0.05, 2);
  n *= 0.7 + 0.6 * wisp;
  return h * n * uMistStrength;
}

void main(){
  float d = rawDepth(vUv);
  vec3 wp = worldFromDepth(vUv, d);
  vec3 ro = uCamPos;
  vec3 rd = normalize(wp - ro);
  bool sky = isSky(d);
  float sceneDist = sky ? 1e9 : length(wp - ro);

  vec3 scatter = vec3(0.0);
  float T = 1.0;

  // 抖动，消除步进条带
  float jitter = hash21(vUv * 1024.0 + uFrame);

  // ---------------- 地面雾气 ----------------
  {
    float maxD = min(sceneDist, 260.0);
    int N = int(uMistSteps);
    float dt = maxD / float(N);
    vec3 mcol = mix(uMistColor, skyColor(rd), 0.35);
    // 朝向太阳时雾更亮（前向散射）
    mcol += uSunColor * pow(max(dot(rd, uSunDir), 0.0), 6.0) * 0.55 * uSunGlow;
    float t = dt * jitter;
    for (int i = 0; i < 24; i++){
      if (i >= N) break;
      vec3 p = ro + rd * t;
      float dens = mistDensity(p) * 0.00085;
      if (dens > 0.0001){
        float sh = cloudShadowAt(p);
        float ext = dens * dt;
        float Ti = exp(-ext);
        vec3 S = mcol * mix(0.55, 1.0, sh);
        scatter += T * S * (1.0 - Ti);
        T *= Ti;
      }
      t += dt;
    }
  }

  // ---------------- 体积云（只在天空像素上步进）----------------
  if (sky && rd.y > -0.02) {
    float t0 = (uCloudBottom - ro.y) / max(rd.y, 0.0025);
    float t1 = (uCloudTop - ro.y) / max(rd.y, 0.0025);
    t0 = max(t0, 0.0);
    // 近地平线时穿过云层的路径极长：限制行进距离并给步长封顶，
    // 否则欠采样会在天空里拉出放射状的条纹。
    t1 = min(t1, t0 + 5400.0);
    if (t1 > t0) {
      int N = int(uCloudSteps);
      float dt = clamp((t1 - t0) / float(N), 9.0, 150.0);
      float t = t0 + dt * jitter;
      float cosA = dot(rd, uSunDir);
      // 4π 归一化：各向同性时 phase = 1
      float phase = clamp(mix(henyey(cosA, 0.76), henyey(cosA, -0.28), 0.40) * 12.566, 0.35, 2.8);
      vec3 ambTop = mix(uSkyHorizon, uSkyTop, 0.4) * 0.85;
      vec3 ambBot = mix(uSkyGround, uSkyHorizon, 0.5) * 0.42;
      for (int i = 0; i < 96; i++){
        if (i >= N || T < 0.012 || t > t1) break;
        vec3 p = ro + rd * t;
        float dens = cloudDensity(p);
        if (dens > 0.001){
          float hN = clamp((p.y - uCloudBottom) / max(uCloudTop - uCloudBottom, 1.0), 0.0, 1.0);
          float lt = lightMarch(p);
          vec3 sunLit = uSunColor * uSunPower * lt * phase;
          vec3 amb = mix(ambBot, ambTop, hN) * uAmbPower;
          vec3 L = (sunLit + amb) * uCloudTint * 0.42;   // 与地面着色同一档曝光
          float ext = dens * SIGMA * dt;
          float Ti = exp(-ext);
          scatter += T * L * (1.0 - Ti);
          T *= Ti;
        }
        t += dt;
      }
    }
  }

  // 远处的云要融进地平线的霾里，否则天边会出现一堵硬墙
  if (sky) {
    float horizonFade = exp(-max(0.0, -rd.y) * 26.0);
    float distFade = 1.0 - exp(-max(rd.y, 0.0) * 3.2);
    float f = clamp(horizonFade * (0.18 + 0.82 * distFade), 0.0, 1.0);
    scatter *= f;
    T = mix(1.0, T, f);
  }

  gl_FragColor = vec4(scatter, T);
}
`;

// ---------------------------------------------------------------------------
// 合成：把半分辨率的云雾贴回主画面
// ---------------------------------------------------------------------------
export const COMPOSITE_FRAG = /* glsl */`
precision highp float;
${ENV_UNIFORMS}
${NOISE}
${ATMOS}
${DEPTH_UTIL}
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tAtmos;
uniform vec2 uTexel;

void main(){
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  // 深度引导的上采样：沿深度不连续处退回最近的相似样本，避免云雾"漏"到前景边缘上
  vec4 a = texture2D(tAtmos, vUv);
  col = col * a.a + a.rgb;
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 景深：以弥散圆为半径的螺旋采样
// ---------------------------------------------------------------------------
export const DOF_FRAG = /* glsl */`
precision highp float;
${DEPTH_UTIL}
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uFocus;
uniform float uAperture;
uniform float uMaxCoc;

float coc(float dist){
  float f = max(uFocus, 1.0);
  // 焦点前后各留一段"安全区"，主体和它脚下的地面都保持清晰，
  // 越远才越虚 —— 这样既有电影味，又不会糊掉整张画面。
  float far  = smoothstep(f * 2.6, f * 16.0, dist);
  float near = smoothstep(f * 0.80, f * 0.28, dist);
  return clamp(max(far, near * 0.8) * uAperture, 0.0, 1.0);
}

void main(){
  float dc = rawDepth(vUv);
  float centerDist = isSky(dc) ? 1e6 : viewDistance(dc);
  float c0 = coc(centerDist);

  vec3 sum = texture2D(tDiffuse, vUv).rgb;
  float wsum = 1.0;

  float radius = c0 * uMaxCoc;
  if (radius > 0.55) {
    const float GA = 2.39996323;
    for (int i = 0; i < 22; i++){
      float fi = float(i) + 0.5;
      float r = sqrt(fi / 22.0) * radius;
      float a = fi * GA;
      vec2 off = vec2(cos(a), sin(a)) * r * uTexel;
      vec2 uv = vUv + off;
      float ds = rawDepth(uv);
      float dist = isSky(ds) ? 1e6 : viewDistance(ds);
      float cs = coc(dist);
      // 只让"同样虚"或"更远"的样本参与，避免前景清晰主体被背景糊掉
      float w = smoothstep(0.0, 0.35, cs) * step(centerDist - 0.5, dist) + smoothstep(0.0, 0.35, cs) * 0.35;
      w = clamp(w, 0.0, 1.0);
      sum += texture2D(tDiffuse, uv).rgb * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}
`;

export const BRIGHT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uSoft;
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(uThreshold, uThreshold + uSoft, l);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

export const BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDir;      // 像素步长
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  c += texture2D(tDiffuse, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tDiffuse, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tDiffuse, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tDiffuse, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

export const DOWN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb * 4.0;
  c += texture2D(tDiffuse, vUv + vec2( uTexel.x,  uTexel.y)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(-uTexel.x,  uTexel.y)).rgb;
  c += texture2D(tDiffuse, vUv + vec2( uTexel.x, -uTexel.y)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
  c += texture2D(tDiffuse, vUv + vec2( uTexel.x * 2.0, 0.0)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(-uTexel.x * 2.0, 0.0)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(0.0,  uTexel.y * 2.0)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(0.0, -uTexel.y * 2.0)).rgb;
  gl_FragColor = vec4(c / 12.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 最终调色：ACES + 分离色调 + 暗角 + 颗粒 + 轻微色散 + FXAA
// ---------------------------------------------------------------------------
export const GRADE_FRAG = /* glsl */`
precision highp float;
${COLORSPACE}
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform vec2  uTexel;
uniform float uExposureG;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uGrain;
uniform float uTimeG;
uniform float uSaturation;
uniform float uContrast;
uniform vec3  uLift;
uniform vec3  uGain;
uniform float uCA;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main(){
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);

  // 轻微色散：只在画面边缘
  float ca = uCA * r2;
  vec3 col;
  col.r = texture2D(tDiffuse, uv - d * ca).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv + d * ca).b;

  col += texture2D(tBloom, uv).rgb * uBloomStrength;

  col *= uExposureG;
  col = acesTonemap(col);

  // 对比 + 饱和
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
  float l = luma(col);
  col = clamp(mix(vec3(l), col, uSaturation), 0.0, 1.0);

  // 分离色调：暗部偏青、亮部偏暖 —— 电影调色的老配方
  col = clamp(col * uGain + uLift * (1.0 - col), 0.0, 1.0);

  // 暗角
  float vig = smoothstep(0.86, 0.16, r2 * uVignette);
  col *= mix(1.0, vig, 0.85);

  // 胶片颗粒
  float g = fract(sin(dot(uv * vec2(1231.0, 719.0) + uTimeG, vec2(12.9898, 78.233))) * 43758.5453);
  col += (g - 0.5) * uGrain * (1.0 - l * 0.7);

  gl_FragColor = vec4(linearToSRGB(clamp(col, 0.0, 1.0)), 1.0);
}
`;

// FXAA（在 sRGB 空间做，最后一步）
export const FXAA_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
  vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv - dir * 0.5).rgb +
                                   texture2D(tDiffuse, vUv + dir * 0.5).rgb);
  float lB = luma(rgbB);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;
