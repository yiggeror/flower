// 确定性随机 + 值噪声（CPU 侧，用于生成高度场与实例散布）
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2i(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smoother(x - ix), fy = smoother(y - iy);
  const a = hash2i(ix, iy, seed);
  const b = hash2i(ix + 1, iy, seed);
  const c = hash2i(ix, iy + 1, seed);
  const d = hash2i(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

export function fbm2(x, y, octaves = 5, seed = 0, lac = 2.02, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0, px = x, py = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(px, py, seed + i * 131);
    norm += amp;
    px = px * lac + 17.3; py = py * lac - 9.1;
    amp *= gain;
  }
  return sum / norm;
}

// 山脊噪声：产生更有骨架感的坡地
export function ridge2(x, y, octaves = 4, seed = 0) {
  let sum = 0, amp = 0.5, norm = 0, px = x, py = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1.0 - Math.abs(valueNoise2(px, py, seed + i * 71) * 2.0 - 1.0);
    sum += amp * n * n;
    norm += amp;
    px = px * 2.07 + 5.7; py = py * 2.07 - 3.3;
    amp *= 0.5;
  }
  return sum / norm;
}
