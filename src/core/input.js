// -----------------------------------------------------------------------------
// input.js — 键盘 / 鼠标 / 触摸。桌面：WASD 移动、拖拽转视角、滚轮推拉。
//            触摸：单指拖拽 = 引导花瓣，双指 = 转视角。
// -----------------------------------------------------------------------------
export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.move = { x: 0, y: 0 };      // -1..1，相机空间
    this.orbit = { dx: 0, dy: 0 };   // 本帧的视角增量
    this.zoom = 0;
    this.boost = false;
    this.hold = false;               // 停驻（拉近镜头 + 景深）
    this.rise = 0;
    this.pointerActive = false;
    this.anyInput = false;

    const isTouch = () => matchMedia('(pointer: coarse)').matches;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
      this.anyInput = true;
      if (this.onKey) this.onKey(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    let dragging = false, lastX = 0, lastY = 0, steerMode = false;
    let startX = 0, startY = 0;
    dom.addEventListener('pointerdown', (e) => {
      dragging = true; this.pointerActive = true;
      lastX = startX = e.clientX; lastY = startY = e.clientY;
      steerMode = isTouch() && e.isPrimary;
      try { dom.setPointerCapture(e.pointerId); } catch (err) { /* 某些浏览器/合成事件会抛，不影响操作 */ }
      this.anyInput = true;
    });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (steerMode) {
        const r = Math.min(innerWidth, innerHeight) * 0.22;
        this.move.x = Math.max(-1, Math.min(1, (e.clientX - startX) / r));
        this.move.y = Math.max(-1, Math.min(1, -(e.clientY - startY) / r));
      } else {
        this.orbit.dx += dx; this.orbit.dy += dy;
      }
    });
    const up = (e) => {
      dragging = false; this.pointerActive = false;
      if (steerMode) { this.move.x = 0; this.move.y = 0; }
      steerMode = false;
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => { this.zoom += e.deltaY * 0.01; e.preventDefault(); }, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  sample() {
    const k = this.keys;
    let x = 0, y = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (x || y) { this.move.x = x; this.move.y = y; this.anyInput = true; }
    const len = Math.hypot(this.move.x, this.move.y);
    const mv = len > 1 ? { x: this.move.x / len, y: this.move.y / len } : { x: this.move.x, y: this.move.y };

    this.boost = k.has('ShiftLeft') || k.has('ShiftRight');
    this.hold = k.has('Space');
    this.rise = (k.has('KeyR') ? 1 : 0) - (k.has('KeyF') ? 1 : 0);

    const orbit = { dx: this.orbit.dx, dy: this.orbit.dy };
    this.orbit.dx = 0; this.orbit.dy = 0;
    const zoom = this.zoom; this.zoom = 0;
    return { move: mv, orbit, zoom, boost: this.boost, hold: this.hold, rise: this.rise };
  }
}
