// -----------------------------------------------------------------------------
// audio.js — 全程序化生成的自然环境声（没有配乐，也不引入任何音频文件）。
//
// 一切声音都跟着画面走：
//   · 风声的音量与亮度 = 场景风力 + 花瓣飞行速度
//   · 雨声 = 天气系统的降雨量；雷声在闪电之后按距离延迟响起
//   · 鸟鸣的疏密随天气变化，下雨时鸟不叫
//   · 暮色里才有虫声
//
// 音色全部由噪声经滤波塑形而来，不用锯齿波、不做旋律，
// 目的是听起来像一片草原，而不是像合成器。
// -----------------------------------------------------------------------------

// 每种天气的环境性格
const AMBIENCE = [
  // 鸟鸣间隔(秒)   虫声  风的音色偏亮  高频风哨
  { bird: [4, 11],  cricket: 0.00, tone: 1.00, whistle: 0.5 },  // 晴
  { bird: [8, 20],  cricket: 0.00, tone: 1.12, whistle: 1.0 },  // 云涌
  { bird: null,     cricket: 0.00, tone: 1.20, whistle: 1.2 },  // 骤雨
  { bird: [4, 10],  cricket: 0.05, tone: 0.95, whistle: 0.4 },  // 雨霁
  { bird: [7, 17],  cricket: 0.26, tone: 0.88, whistle: 0.3 },  // 暮金
];

// 可选的真实录音。放进 audio/ 就自动接管对应的层，缺哪个就用哪个的合成版。
// 文件名固定，格式建议 .mp3（iOS 与安卓都支持）。
const SAMPLE_FILES = {
  wind:     'wind.mp3',
  rain:     'rain.mp3',
  birds:    'birds.mp3',
  crickets: 'crickets.mp3',
  thunder:  'thunder.mp3',
};

export class Ambience {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this._gust = 0.4;
    this._gustTarget = 0.4;
    this._nextBird = 0;
    this._thunderArmed = true;
    this.birdCount = 0;   // 便于客观检测
    this.samples = {};       // 已加载并接管的层
    this.sampleGain = {};
    this.sampleFilter = {};
  }

  // 必须由用户手势触发（浏览器的自动播放策略）
  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.started = true;
    const ctx = this.ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();

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
    this.comp = comp;
    this.master.gain.setTargetAtTime(1.05, ctx.currentTime, 1.6);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    comp.connect(this.analyser);

    // 空间感：程序生成的脉冲响应。鸟叫和雷声靠它才显得"在远处"
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.8, 2.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.85;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    this._buildWind();
    this._buildRain();
    this._buildCrickets();

    this._nextBird = ctx.currentTime + 3.0;

    // file:// 下没法 fetch 同目录文件，单文件版直接走合成
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      this.loadSamples();
    }
  }

  /**
   * 尝试加载真实录音。每一层独立：有文件就接管，没有就继续用合成。
   * 加载是后台进行的，不阻塞游戏。
   */
  async loadSamples(base) {
    const ctx = this.ctx;
    if (!ctx) return;
    base = base || './audio/';
    await Promise.all(Object.keys(SAMPLE_FILES).map(async (key) => {
      try {
        const res = await fetch(base + SAMPLE_FILES[key]);
        if (!res.ok) return;
        const raw = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(raw);
        if (key === 'thunder') { this.samples.thunder = buf; return; }
        this.samples[key] = this._makeSeamless(buf, 1.2);
        this._mountSample(key);
      } catch (e) {
        // 没有这个文件（或解码失败）就保持合成，不打扰用户
      }
    }));
  }

  /**
   * 把一段录音做成无缝循环：把结尾一段等功率交叉淡化到开头，然后裁掉尾巴。
   * 这样任何一段素材都能循环，不必事先做成 loop-ready。
   */
  _makeSeamless(buf, seconds) {
    const sr = buf.sampleRate;
    const xf = Math.max(1, Math.min(Math.floor(seconds * sr), Math.floor(buf.length / 3)));
    const n = buf.length - xf;
    if (n <= sr * 0.5) return buf;
    const out = this.ctx.createBuffer(buf.numberOfChannels, n, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const d = out.getChannelData(c);
      d.set(src.subarray(0, n));
      for (let i = 0; i < xf; i++) {
        const k = (i / xf) * Math.PI * 0.5;
        d[i] = d[i] * Math.sin(k) + src[n + i] * Math.cos(k);
      }
    }
    return out;
  }

  _mountSample(key) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.samples[key];
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    // 风和雨给一个可调的低通，让音色也能随阵风与雨势变化
    if (key === 'wind' || key === 'rain') {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 3000; f.Q.value = 0.6;
      src.connect(f); f.connect(g);
      this.sampleFilter[key] = f;
    } else {
      src.connect(g);
    }
    g.connect(this.master);
    if (key !== 'wind') g.connect(this.reverb);
    src.start();
    this.sampleGain[key] = g;
  }

  // ---- 素材 ----
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
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
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

  // ---- 风：低频呼啸 + 草叶摩擦 + 强风时的高频哨音 ----
  _buildWind() {
    const ctx = this.ctx;
    const brown = this._noiseBuffer(5, true);
    const white = this._noiseBuffer(5, false);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 210; lp.Q.value = 0.6;
    this.windLowGain = ctx.createGain(); this.windLowGain.gain.value = 0;
    this._loopSource(brown, 1).connect(lp);
    lp.connect(this.windLowGain);
    this.windLowGain.connect(this.master);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.55;
    this.windBP = bp;
    // 5kHz 以上的沙沙对耳朵是负担，滚掉
    const hissLP = ctx.createBiquadFilter();
    hissLP.type = 'lowpass'; hissLP.frequency.value = 4600; hissLP.Q.value = 0.6;
    this.windHissGain = ctx.createGain(); this.windHissGain.gain.value = 0;
    this._loopSource(white, 0.85).connect(bp);
    bp.connect(hissLP); hissLP.connect(this.windHissGain);
    this.windHissGain.connect(this.master);
    this.windHissGain.connect(this.reverb);

    // 掠过草尖的那一点高频
    const wh = ctx.createBiquadFilter();
    wh.type = 'bandpass'; wh.frequency.value = 2200; wh.Q.value = 1.3;
    this.windWhistleBP = wh;
    this.windWhistleGain = ctx.createGain(); this.windWhistleGain.gain.value = 0;
    this._loopSource(white, 1.13).connect(wh);
    wh.connect(this.windWhistleGain);
    this.windWhistleGain.connect(this.master);
    this.windWhistleGain.connect(this.reverb);
  }

  /**
   * 雨滴层：预先合成一段"雨点噼啪"的循环缓冲。
   * 一颗雨滴 = 一个快速衰减的正弦混一点噪声。真实的雨之所以像雨而不像嘶声，
   * 靠的就是这些密集的瞬态。
   */
  _dropletBuffer(seconds, perSecond) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const count = Math.floor(seconds * perSecond);
      for (let k = 0; k < count; k++) {
        const pos = (Math.random() * n) | 0;
        const f = 620 + Math.random() * 2400;
        const decay = 0.0030 + Math.random() * 0.016;
        const amp = 0.10 + Math.random() * 0.85;
        const len = Math.min(Math.floor(decay * 5 * sr), n);
        const w = (2 * Math.PI * f) / sr;
        const inv = 1 / (decay * sr);
        for (let i = 0; i < len; i++) {
          const j = pos + i;
          if (j >= n) break;
          const env = Math.exp(-i * inv);
          d[j] += amp * env * (Math.sin(w * i) * 0.5 + (Math.random() * 2 - 1) * 0.5);
        }
      }
      // 归一化 + 循环点交叉淡化
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
      const g = peak > 0 ? 0.85 / peak : 1;
      for (let i = 0; i < n; i++) d[i] *= g;
      const fade = Math.min(4000, (n / 8) | 0);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        d[i] = d[i] * k + d[n - fade + i] * (1 - k);
      }
    }
    return buf;
  }

  // ---- 雨：中低频的雨幕 + 一颗颗雨滴 + 远处的雨墙 ----
  // 关键是把 5kHz 以上滚降掉。刺耳感全来自那一段。
  _buildRain() {
    const ctx = this.ctx;
    const white = this._noiseBuffer(5, false);

    // 主体：掐掉超低和超高，只留有"重量"的中频
    const src = this._loopSource(white, 1.0);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 240; hp.Q.value = 0.6;
    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass'; lp1.frequency.value = 4200; lp1.Q.value = 0.7;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass'; lp2.frequency.value = 5200; lp2.Q.value = 0.5;
    const body = ctx.createBiquadFilter();
    body.type = 'peaking'; body.frequency.value = 1150; body.Q.value = 0.7; body.gain.value = 4.5;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    src.connect(hp); hp.connect(lp1); lp1.connect(lp2); lp2.connect(body);
    body.connect(this.rainGain);
    this.rainGain.connect(this.master);

    // 雨滴
    const drops = this._loopSource(this._dropletBuffer(7, 210), 1.0);
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass'; dlp.frequency.value = 5600; dlp.Q.value = 0.6;
    this.rainDropGain = ctx.createGain(); this.rainDropGain.gain.value = 0;
    drops.connect(dlp); dlp.connect(this.rainDropGain);
    this.rainDropGain.connect(this.master);
    this.rainDropGain.connect(this.reverb);

    // 远处的雨墙：只剩低频，靠混响推远
    const src2 = this._loopSource(white, 0.7);
    const flp = ctx.createBiquadFilter();
    flp.type = 'lowpass'; flp.frequency.value = 780; flp.Q.value = 0.5;
    this.rainFarGain = ctx.createGain(); this.rainFarGain.gain.value = 0;
    src2.connect(flp); flp.connect(this.rainFarGain);
    this.rainFarGain.connect(this.master);
    this.rainFarGain.connect(this.reverb);

    this.thunderNoise = white;
    this._rainSwell = 0.6;
    this._rainSwellTarget = 0.6;
  }

  thunder() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.35 + Math.random() * 1.4;   // 先见闪电，后闻雷声
    if (this.samples.thunder) {
      const s2 = ctx.createBufferSource();
      s2.buffer = this.samples.thunder;
      s2.playbackRate.value = 0.9 + Math.random() * 0.25;
      const g2 = ctx.createGain();
      g2.gain.value = 0.55 + Math.random() * 0.35;
      s2.connect(g2); g2.connect(this.master); g2.connect(this.reverb);
      s2.start(t0);
      return;
    }
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

  // ---- 虫声：窄带噪声被快慢两层脉冲切开，就是蟋蟀那种"唧—唧—"----
  _buildCrickets() {
    const ctx = this.ctx;
    const white = this._noiseBuffer(4, false);
    const src = this._loopSource(white, 1.0);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 4450; bp.Q.value = 22;

    // 窄带滤波 + 两级门控总共衰减约 40dB，必须补偿回来
    const makeup = ctx.createGain(); makeup.gain.value = 14;
    const fast = ctx.createGain(); fast.gain.value = 0.42;   // 单次振翅
    const slow = ctx.createGain(); slow.gain.value = 0.40;   // 一串鸣叫
    this.cricketGain = ctx.createGain(); this.cricketGain.gain.value = 0;

    const lfoF = ctx.createOscillator(); lfoF.type = 'sine'; lfoF.frequency.value = 38;
    const lfoFG = ctx.createGain(); lfoFG.gain.value = 0.58;
    lfoF.connect(lfoFG); lfoFG.connect(fast.gain); lfoF.start();

    const lfoS = ctx.createOscillator(); lfoS.type = 'sine'; lfoS.frequency.value = 1.7;
    const lfoSG = ctx.createGain(); lfoSG.gain.value = 0.60;
    lfoS.connect(lfoSG); lfoSG.connect(slow.gain); lfoS.start();

    src.connect(bp); bp.connect(makeup); makeup.connect(fast); fast.connect(slow);
    slow.connect(this.cricketGain);
    this.cricketGain.connect(this.master);
    this.cricketGain.connect(this.reverb);
  }

  /**
   * 一段鸟鸣。用带滑音的正弦加快速颤音来模拟啭鸣 ——
   * 鸟叫的关键是音高在几十毫秒内滑动，而不是一个固定的"哔"。
   */
  bird() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.birdCount++;
    const t0 = ctx.currentTime + 0.02;
    const f0 = 1900 + Math.random() * 1900;
    const notes = 1 + ((Math.random() * 4) | 0);
    const kind = Math.random();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = (Math.random() * 2 - 1) * 0.75;

    const bus = ctx.createGain();
    bus.gain.value = 0.115 + Math.random() * 0.075;
    if (pan) { bus.connect(pan); pan.connect(this.master); pan.connect(this.reverb); }
    else { bus.connect(this.master); bus.connect(this.reverb); }

    let t = t0;
    for (let i = 0; i < notes; i++) {
      const dur = 0.055 + Math.random() * 0.09;
      const f = f0 * (0.92 + Math.random() * 0.18);
      const o = ctx.createOscillator();
      o.type = 'sine';
      // 音高滑动：上扬 / 下坠 / 先扬后落
      o.frequency.setValueAtTime(f * (kind < 0.4 ? 0.78 : 1.18), t);
      o.frequency.exponentialRampToValueAtTime(f * (kind < 0.4 ? 1.22 : 0.82), t + dur * 0.55);
      o.frequency.exponentialRampToValueAtTime(f * (kind < 0.7 ? 1.02 : 0.9), t + dur);

      // 颤音：真实的鸟鸣几乎都带
      const vib = ctx.createOscillator();
      vib.type = 'sine';
      vib.frequency.value = 42 + Math.random() * 45;
      const vibG = ctx.createGain();
      vibG.gain.value = f * (0.02 + Math.random() * 0.05);
      vib.connect(vibG); vibG.connect(o.frequency);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1.0, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f * 1.05; bp.Q.value = 1.4;

      o.connect(g); g.connect(bp); bp.connect(bus);
      o.start(t); o.stop(t + dur + 0.02);
      vib.start(t); vib.stop(t + dur + 0.02);
      t += dur + 0.045 + Math.random() * 0.11;
    }
  }

  /**
   * @param {number} dt
   * @param {object} s windStrength, speed, rain, flash, weatherIndex
   */
  update(dt, s) {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const amb = AMBIENCE[Math.max(0, Math.min(AMBIENCE.length - 1, s.weatherIndex | 0))];

    const r = Math.max(0, Math.min(1, s.rain));

    // ---- 阵风：随机游走，叠加场景风力与飞行速度 ----
    if (Math.random() < dt * 0.55) this._gustTarget = 0.25 + Math.random() * 0.75;
    this._gust += (this._gustTarget - this._gust) * Math.min(1, dt * 0.7);
    const w = Math.max(0, s.windStrength);
    const motion = Math.min(s.speed / 20, 1);
    // 风力对音量的影响收窄：原来 0.45~1.42 的跨度太大，大风天会盖过一切
    const gust = this._gust * (0.50 + Math.min(w, 2.2) * 0.18) + motion * 0.22;

    // 下雨时风退到雨后面。两者都是宽带噪声，等量叠加只会糊成一片吵。
    const rainDuck = 1 - 0.66 * r;

    const hasWind = !!this.sampleGain.wind;
    this.windLowGain.gain.setTargetAtTime(hasWind ? 0 : (0.034 + gust * 0.046) * rainDuck, now, 0.35);
    this.windHissGain.gain.setTargetAtTime(hasWind ? 0 : (0.028 + gust * 0.048) * rainDuck, now, 0.30);
    this.windBP.frequency.setTargetAtTime(
      (600 + gust * 1150 + motion * 520) * amb.tone, now, 0.4);
    this.windWhistleGain.gain.setTargetAtTime(
      hasWind ? 0 : Math.max(0, gust - 0.55) * 0.016 * amb.whistle * rainDuck, now, 0.5);
    if (hasWind) {
      this.sampleGain.wind.gain.setTargetAtTime((0.16 + gust * 0.42) * rainDuck, now, 0.35);
      this.sampleFilter.wind.frequency.setTargetAtTime(
        (1100 + gust * 5200 + motion * 1500) * amb.tone, now, 0.4);
    }

    // ---- 雨：雨势本身也会一阵大一阵小 ----
    if (Math.random() < dt * 0.25) this._rainSwellTarget = 0.62 + Math.random() * 0.55;
    this._rainSwell += (this._rainSwellTarget - this._rainSwell) * Math.min(1, dt * 0.35);
    const rs = r * this._rainSwell;
    const hasRain = !!this.sampleGain.rain;
    this.rainGain.gain.setTargetAtTime(hasRain ? 0 : rs * 0.078, now, 0.7);
    this.rainDropGain.gain.setTargetAtTime(hasRain ? 0 : rs * 0.104, now, 0.7);
    this.rainFarGain.gain.setTargetAtTime(hasRain ? 0 : r * 0.045, now, 1.2);
    if (hasRain) {
      this.sampleGain.rain.gain.setTargetAtTime(rs * 0.85, now, 0.7);
      this.sampleFilter.rain.frequency.setTargetAtTime(2200 + rs * 5000, now, 0.9);
    }

    // ---- 雷 ----
    if (s.flash > 0.5 && this._thunderArmed) { this.thunder(); this._thunderArmed = false; }
    if (s.flash < 0.05) this._thunderArmed = true;

    // ---- 虫声：只在暮色与雨后 ----
    // 注意：Q=22 的窄带只放过约 1% 的噪声功率（约 -20dB），
    // 增益要把这部分补回来，否则虫声等于没有。
    const cricketLevel = amb.cricket * (1 - r);
    this.cricketGain.gain.setTargetAtTime(
      this.sampleGain.crickets ? 0 : cricketLevel * 0.20, now, 4.0);
    if (this.sampleGain.crickets) {
      this.sampleGain.crickets.gain.setTargetAtTime(cricketLevel * 1.1, now, 4.0);
    }

    // ---- 鸟鸣：下雨不叫；风越大越少（鸟会躲起来）----
    if (this.sampleGain.birds) {
      const lvl = (amb.bird && r < 0.25) ? 0.55 / (1 + Math.max(0, w - 1) * 0.6) : 0;
      this.sampleGain.birds.gain.setTargetAtTime(lvl, now, 2.5);
    } else if (amb.bird && r < 0.25) {
      if (now > this._nextBird) {
        this.bird();
        const [lo, hi] = amb.bird;
        const shy = 1 + Math.max(0, w - 1) * 0.5;
        this._nextBird = now + (lo + Math.random() * (hi - lo)) * shy;
      }
    } else {
      this._nextBird = Math.max(this._nextBird, now + 4);
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(m ? 0.0 : 1.05, this.ctx.currentTime, 0.25);
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
