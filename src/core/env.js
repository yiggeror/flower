// -----------------------------------------------------------------------------
// env.js — 全局环境状态。
// 这里的 uniform 对象被所有材质"按引用"共享，天气系统只需改 .value，
// 地形 / 草 / 花 / 天空 / 体积云 / 后期 会同时响应，保证画面永远自洽。
// -----------------------------------------------------------------------------
import * as THREE from 'three';

const u = (value) => ({ value });

export const env = {
  // --- 世界尺度 ---
  worldSize: 512,          // 地形边长（米）
  hfRes: 513,              // 高度场分辨率（顶点数 = worldSize/1m + 1）
  playRadius: 205,         // 玩家活动半径

  // --- 时间 ---
  time: 0,                 // 场景总时间（秒）
  cloudTime: 0,            // 云的演化时间（可与 time 解耦，天气切换时加速）
  windPhase: 0,            // 风相位积分，保证风速变化时草不会跳变

  uniforms: {
    uTime:        u(0),
    uCloudTime:   u(0),
    uWindPhase:   u(0),

    // 太阳 / 天空
    uSunDir:      u(new THREE.Vector3(0.50, 0.42, 0.76).normalize()),
    uSunColor:    u(new THREE.Color(1.00, 0.895, 0.735)),
    uSunPower:    u(3.45),
    uSkyTop:      u(new THREE.Color(0.115, 0.315, 0.700)),
    uSkyHorizon:  u(new THREE.Color(0.72, 0.84, 0.95)),
    uSkyGround:   u(new THREE.Color(0.42, 0.46, 0.44)),
    uAmbSky:      u(new THREE.Color(0.335, 0.495, 0.800)),
    uAmbGround:   u(new THREE.Color(0.195, 0.255, 0.135)),
    uAmbPower:    u(0.74),
    uSunGlow:     u(1.0),

    // 雾 / 大气
    uFogColor:    u(new THREE.Color(0.700, 0.800, 0.900)),
    uFogDensity:  u(0.0016),
    uFogHeight:   u(38.0),
    uFogGround:   u(0.55),     // 贴地雾气强度（后期高度雾用）

    // 云
    uCloudCover:  u(0.40),
    uCloudShadow: u(0.62),     // 云影强度
    uCloudScale:  u(0.0034),
    uCloudBottom: u(380.0),
    uCloudTop:    u(605.0),
    uCloudDensity:u(1.55),
    uCloudTint:   u(new THREE.Color(1.0, 0.98, 0.95)),

    // 风 / 湿度
    uWind:        u(new THREE.Vector2(0.86, 0.51)),  // 风向（单位向量）
    uWindStrength:u(1.0),
    uWetness:     u(0.0),      // 0 干爽 → 1 雨后湿润（提升高光、压低饱和）

    // 草地色（风格化）
    uGrassDeep:   u(new THREE.Color(0.040, 0.118, 0.052)),
    uGrassLit:    u(new THREE.Color(0.335, 0.545, 0.152)),
    uGrassDry:    u(new THREE.Color(0.565, 0.545, 0.212)),

    // 绽放贴图（世界空间）
    uBloomMap:    u(null),
    uBloomWorld:  u(512.0),

    // 地面雾气
    uMistStrength:u(0.32),
    uMistBase:    u(0.0),
    uMistHeight:  u(6.0),
    uMistColor:   u(new THREE.Color(0.80, 0.87, 0.94)),

    // 相机
    uCamPos:      u(new THREE.Vector3()),
    uExposure:    u(1.0),
    uDebug:       u(0.0),
  },
};

// 把共享 uniform 合并进材质自己的 uniform 表（按引用，天气改一处全场生效）
export function withEnv(extra = {}) {
  return Object.assign({}, env.uniforms, extra);
}
