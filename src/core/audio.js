// -----------------------------------------------------------------------------
// audio.js — 全程序化生成的环境声与配乐（不引入任何音频文件）。
//
// 设计原则：声音必须跟着画面走，而不是循环播放一段无关的音乐。
//   · 风声的音量与亮度 = 场景里的风力 + 花瓣飞行速度
//   · 雨声与雷声 = 天气系统的降雨量与闪电
//   · 配乐的调式与根音 = 当前天气（晴用大调五声，雨用小调五声，暮金用混合利底亚）
//   · 花开到一定数量会落下一声很轻的铃音
//
// 所有音色都用正弦/三角波 + 低通 + 混响堆出来，不用锯齿波，
// 避免出现廉价合成器那种刺耳的电子味。
// -----------------------------------------------------------------------------

const SCALES = {
  major:      [0, 2, 4, 7, 9],       // 大调五声
  minor:      [0, 3, 5, 7, 10],      // 小调五声
  mixolydian: [0, 2, 5, 7, 9],       // 偏暖的属调色彩
};

// 每种天气一套音乐性格：根音(Hz)、调式、明亮度、配乐音量
const MOODS = [
  { root: 146.83, scale: 'major',      bright: 1.00, music: 1.00, note: [2.2, 5.0] }, // 晴  D
  { root: 130.81, scale: 'major',      bright: 0.86, music: 0.92, note: [2.6, 6.0] }, // 云涌 C
  { root: 110.00, scale: 'minor',      bright: 0.52, music: 0.72, note: [3.4, 8.0] }, // 骤雨 A
  { root: 174.61, scale: 'major',      bright: 1.10, music: 1.00, note: [2.0, 4.6] }, // 雨霁 F
  { root: 116.54, scale: 'mixolydian', bright: 0.78, music: 1.05, note: [2.8, 6.4] }, // 暮金 Bb
];

export class Ambience {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this._gust = 0.4;
    this._gustTarget = 0.4;
    this._nextNote = 0;
    this._nextChord = 0;
    this._lastDegree = 2;
    this._moodIndex = 0;
    this._bloomMark = 0;
    this._thunderArmed = true;
  }

  // 必须由用户手势触发（浏览器的自动播放策略）
  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.started = true;
    const ctx = this.ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();

    // ---- 主输出：限一点动态，避免叠加时爆音 ----
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.35;

    // 30Hz 以下人耳基本听不到，却会白白吃掉动态余量、在手机上变成浑浊的嗡声
    const rumbleCut = ctx.createBiquadFilter();
    rumbleCut.type = 'highpass';
    rumbleCut.frequency.value = 34;
    rumbleCut.Q.value = 0.5;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(rumbleCut);
    rumbleCut.connect(comp);
    comp.connect(ctx.destination);
    this.comp = comp;   // 供录音/检测挂载
    // 淡入，别一上来就砸出声音
    this.master.gain.setTargetAtTime(1.15, ctx.currentTime, 1.6);

    // 供外部做客观检测（RMS / 频谱）
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    comp.connect(this.analyser);

    // ---- 混响：程序生成的脉冲响应，让一切听起来有空间 ----
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.8, 2.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.9;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    this._buildWind();
    this._buildRain();
    this._buildMusic();

    this._nextNote = ctx.currentTime + 2.0;
    this._nextChord = ctx.currentTime + 0.1;
  }

  // ---- 噪声与脉冲响应 ----
  _noiseBuffer(seconds, brown) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let last = 0;
      for (let i = 0; i < n; i++) {
        const white = Math.random() * 2 - 1;
        if (brown) { last = (last + 0.02 * white) / 1.02; d[i] = last * 3.2; }
        else d[i] = white;
      }
      // 首尾交叉淡化，循环点不会"咔"一声
      const fade = Math.min(2000, (n / 8) | 0);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        d[i] = d[i] * k + d[n - fade + i] * (1 - k);
      }
    }
    return buf;
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  _loopSource(buffer, rate) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate || 1;
    s.start();
    return s;
  }

  // ---- 风：低频的呼啸 + 高频的草叶摩擦 ----
  _buildWind() {
    const ctx = this.ctx;
    const brown = this._noiseBuffer(5, true);
    const white = this._noiseBuffer(5, false);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 210; lp.Q.value = 0.6;
    this.windLowGain = ctx.createGain(); this.windLowGain.gain.value = 0.0;
    this._loopSource(brown, 1).connect(lp);
    lp.connect(this.windLowGain);
    this.windLowGain.connect(this.master);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.55;
    this.windBP = bp;
    this.windHissGain = ctx.createGain(); this.windHissGain.gain.value = 0.0;
    this._loopSource(white, 0.85).connect(bp);
    bp.connect(this.windHissGain);
    this.windHissGain.connect(this.master);
    this.windHissGain.connect(this.reverb);
  }

  // ---- 雨：高频的沙沙 + 中频的密度 + 远处的低鸣 ----
  _buildRain() {
    const ctx = this.ctx;
    const white = this._noiseBuffer(5, false);
    const src = this._loopSource(white, 1.0);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1100; hp.Q.value = 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.4;

    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    this.rainHissGain = ctx.createGain(); this.rainHissGain.gain.value = 0;
    this.rainLowGain = ctx.createGain(); this.rainLowGain.gain.value = 0;

    src.connect(hp); hp.connect(this.rainGain); this.rainGain.connect(this.master);
    src.connect(bp); bp.connect(this.rainHissGain);
    this.rainHissGain.connect(this.master); this.rainHissGain.connect(this.reverb);
    src.connect(lp); lp.connect(this.rainLowGain); this.rainLowGain.connect(this.master);

    this.thunderNoise = white;
  }

  thunder() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.35 + Math.random() * 1.4;   // 先见闪电，后闻雷声
    const src = ctx.createBufferSource();
    src.buffer = this.thunderNoise;
    src.playbackRate.value = 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(420, t0);
    lp.frequency.exponentialRampToValueAtTime(65, t0 + 2.4);
    lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.42, t0 + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.2);
    src.connect(lp); lp.connect(g); g.connect(this.master); g.connect(this.reverb);
    src.start(t0); src.stop(t0 + 3.4);
  }

  // ---- 配乐：一层缓慢的垫底和弦 + 稀疏的拨弦 ----
  _buildMusic() {
    const ctx = this.ctx;

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 620;
    this.padFilter.Q.value = 0.4;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.0;
    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.master);
    this.padGain.connect(this.reverb);

    // 每个声部两个略微失谐的振荡器，合起来才有厚度而不是一根干巴巴的正弦
    this.padVoices = [];
    for (let i = 0; i < 3; i++) {
      const a = ctx.createOscillator(); a.type = 'sine';
      const b = ctx.createOscillator(); b.type = 'triangle'; b.detune.value = 5.5;
      const g = ctx.createGain(); g.gain.value = i === 0 ? 0.30 : 0.20;
      a.connect(g); b.connect(g); g.connect(this.padFilter);
      a.start(); b.start();
      this.padVoices.push({ a, b, g });
    }

    // 拨弦的回声
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.44;
    this.delayFb = ctx.createGain(); this.delayFb.gain.value = 0.34;
    this.delayLP = ctx.createBiquadFilter();
    this.delayLP.type = 'lowpass'; this.delayLP.frequency.value = 2200;
    this.delay.connect(this.delayLP);
    this.delayLP.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayOut = ctx.createGain(); this.delayOut.gain.value = 0.34;
    this.delayLP.connect(this.delayOut);
    this.delayOut.connect(this.master);
    this.delayOut.connect(this.reverb);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.9;
    this.musicGain.connect(this.master);
    this.musicGain.connect(this.reverb);
    this.musicGain.connect(this.delay);
  }

  _pluck(freq, vel, dur) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2.004;
    const o3 = ctx.createOscillator(); o3.type = 'triangle'; o3.frequency.value = freq * 0.999;
    const g2 = ctx.createGain(); g2.gain.value = 0.16;
    const g3 = ctx.createGain(); g3.gain.value = 0.10;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(6000, freq * 9), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2.2), t + dur * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o1.connect(g); o2.connect(g2); g2.connect(g); o3.connect(g3); g3.connect(g);
    g.connect(lp); lp.connect(this.musicGain);
    o1.start(t); o2.start(t); o3.start(t);
    o1.stop(t + dur + 0.1); o2.stop(t + dur + 0.1); o3.stop(t + dur + 0.1);
  }

  /** 花开到一定程度时落下的一声轻铃 */
  chime(freq) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const parts = [[1, 0.10], [2.76, 0.05], [5.40, 0.022]];   // 近似钟体的非谐分音
    parts.forEach(([mul, amp]) => {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.value = freq * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6 / Math.sqrt(mul));
      o.connect(g); g.connect(this.musicGain);
      o.start(t); o.stop(t + 3.0);
    });
  }

  _setChord(mood) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const scale = SCALES[mood.scale];
    // 根音 / 五度 / 一个在调内游走的高音
    const degs = [0, 2, 3 + ((Math.random() * 2) | 0)];
    this.padVoices.forEach((v, i) => {
      const semi = scale[degs[i] % scale.length] + (degs[i] >= scale.length ? 12 : 0);
      const oct = i === 0 ? 1 : (i === 1 ? 2 : 4);
      const f = mood.root * Math.pow(2, semi / 12) * (oct / 2);
      v.a.frequency.setTargetAtTime(f, t, 2.5);
      v.b.frequency.setTargetAtTime(f * 1.0009, t, 2.5);
    });
  }

  /**
   * @param {number} dt
   * @param {object} s 场景状态
   *   windStrength, speed, rain, flash, weatherIndex, bloomArea, settle
   */
  update(dt, s) {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const mood = MOODS[Math.max(0, Math.min(MOODS.length - 1, s.weatherIndex | 0))];

    // 天气变了 → 换调式与和弦
    if ((s.weatherIndex | 0) !== this._moodIndex) {
      this._moodIndex = s.weatherIndex | 0;
      this._setChord(mood);
      this._nextChord = now + 16;
    }

    // ---- 阵风：随机游走，叠加场景风力与飞行速度 ----
    if (Math.random() < dt * 0.55) this._gustTarget = 0.25 + Math.random() * 0.75;
    this._gust += (this._gustTarget - this._gust) * Math.min(1, dt * 0.7);
    const w = Math.max(0, s.windStrength);
    const motion = Math.min(s.speed / 20, 1);
    const gust = this._gust * (0.45 + w * 0.45) + motion * 0.30;

    this.windLowGain.gain.setTargetAtTime(0.022 + gust * 0.062, now, 0.35);
    this.windHissGain.gain.setTargetAtTime(0.016 + gust * 0.062, now, 0.30);
    this.windBP.frequency.setTargetAtTime(620 + gust * 1150 + motion * 500, now, 0.4);

    // ---- 雨 ----
    const r = Math.max(0, Math.min(1, s.rain));
    this.rainGain.gain.setTargetAtTime(r * 0.085, now, 0.6);
    this.rainHissGain.gain.setTargetAtTime(r * 0.055, now, 0.6);
    this.rainLowGain.gain.setTargetAtTime(r * 0.034, now, 0.8);

    // ---- 雷 ----
    if (s.flash > 0.5 && this._thunderArmed) { this.thunder(); this._thunderArmed = false; }
    if (s.flash < 0.05) this._thunderArmed = true;

    // ---- 配乐 ----
    this.padGain.gain.setTargetAtTime(0.085 * mood.music, now, 3.0);
    this.padFilter.frequency.setTargetAtTime(
      480 + mood.bright * 520 + Math.sin(now * 0.07) * 130, now, 2.0);

    if (now > this._nextChord) {
      this._setChord(mood);
      this._nextChord = now + 15 + Math.random() * 10;
    }

    if (now > this._nextNote) {
      const scale = SCALES[mood.scale];
      // 以级进为主、偶尔跳进，听起来才像旋律而不是随机音
      let d = this._lastDegree + (Math.random() < 0.68
        ? (Math.random() < 0.5 ? -1 : 1)
        : (Math.random() < 0.5 ? -2 : 2));
      d = Math.max(0, Math.min(scale.length * 2 - 1, d));
      this._lastDegree = d;
      const semi = scale[d % scale.length] + (d >= scale.length ? 12 : 0);
      const f = mood.root * Math.pow(2, semi / 12) * 4;
      // 停下来的时候旋律更清晰一点，飞行时退到背景里
      const vel = (0.055 + Math.random() * 0.045) * (0.7 + (s.settle || 0) * 0.5) * mood.music;
      this._pluck(f, vel, 1.6 + Math.random() * 1.4);
      const [lo, hi] = mood.note;
      this._nextNote = now + lo + Math.random() * (hi - lo);
    }

    // ---- 花开的铃音 ----
    if (s.bloomArea > this._bloomMark) {
      this._bloomMark = s.bloomArea + 70 + Math.random() * 60;
      if (this._bloomMark > 130) {                    // 跳过开场那一下
        const scale = SCALES[mood.scale];
        const semi = scale[(Math.random() * scale.length) | 0];
        this.chime(mood.root * Math.pow(2, semi / 12) * 8);
      }
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(m ? 0.0 : 1.15, this.ctx.currentTime, 0.25);
    }
  }

  setSuspended(b) {
    if (!this.ctx) return;
    if (b && this.ctx.state === 'running') this.ctx.suspend();
    else if (!b && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** 客观检测用：当前输出的均方根电平 */
  rms() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /** 客观检测用：几个频段的能量分布 */
  bands() {
    if (!this.analyser) return null;
    const n = this.analyser.frequencyBinCount;
    const buf = new Uint8Array(n);
    this.analyser.getByteFrequencyData(buf);
    const nyq = this.ctx.sampleRate / 2;
    const edges = [0, 120, 400, 1200, 3500, nyq];
    const out = [];
    for (let b = 0; b < edges.length - 1; b++) {
      const i0 = Math.floor(edges[b] / nyq * n);
      const i1 = Math.max(i0 + 1, Math.floor(edges[b + 1] / nyq * n));
      let s = 0;
      for (let i = i0; i < i1; i++) s += buf[i];
      out.push(+(s / (i1 - i0) / 255).toFixed(3));
    }
    return out;
  }
}
