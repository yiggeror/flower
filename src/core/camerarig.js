// -----------------------------------------------------------------------------
// camerarig.js — 电影感跟随相机。
// 疾行时拉远、广角、深焦；停下时缓缓推近、收窄视角、大光圈 → 强景深。
// -----------------------------------------------------------------------------
import * as THREE from 'three';

export class CameraRig {
  constructor(camera, hf) {
    this.camera = camera;
    this.hf = hf;
    this.yaw = Math.PI;
    this.pitch = 0.145;
    this.distBias = 0;
    this.dist = 12;
    this.fov = 55;
    this.roll = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.settle = 0;          // 停驻时长 → 驱动推镜与景深
    this.idleOrbit = 0;
    this._lastYaw = this.yaw;

    // 给后期用
    this.focusDistance = 12;
    this.aperture = 0.0;

    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
  }

  update(dt, flock, ctrl) {
    const target = flock.centroid;
    const speed = flock.speed;

    // ---- 视角 ----
    this.yaw -= ctrl.orbit.dx * 0.0042;
    this.pitch += ctrl.orbit.dy * 0.0032;
    this.pitch = Math.max(-0.42, Math.min(1.02, this.pitch));
    this.distBias = Math.max(-4, Math.min(16, this.distBias + ctrl.zoom * 0.9));

    const manual = Math.abs(ctrl.orbit.dx) > 0.01;
    // 移动时相机慢慢绕到花瓣身后：电影里镜头总是懂事地跟到后面
    if (!manual && speed > 2.0) {
      const want = Math.atan2(-flock.heading.x, -flock.heading.z);
      let d = want - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, 0.55 * dt * Math.min(speed / 6, 1.6));
    }

    // ---- 停驻检测 ----
    const moving = speed > 1.4 && !ctrl.hold;
    this.settle += (moving ? -dt * 2.2 : dt * 1.15);
    this.settle = Math.max(0, Math.min(1, this.settle));
    const s = this.settle * this.settle * (3 - 2 * this.settle);   // smoothstep

    const speedT = Math.max(0, Math.min(1, speed / 13));
    const wantDist = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(10.0, 14.0, speedT), 7.2, s) + this.distBias;
    const wantFov = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(50, 62, speedT), 34, s);
    const wantPitchBias = THREE.MathUtils.lerp(0.0, 0.06, s);

    this.dist += (wantDist - this.dist) * Math.min(1, 1.6 * dt);
    this.fov += (wantFov - this.fov) * Math.min(1, 1.4 * dt);

    // ---- 位置 ----
    const pitch = this.pitch + wantPitchBias;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const off = this._v.set(
      Math.sin(this.yaw) * cp,
      sp + 0.12,
      Math.cos(this.yaw) * cp,
    ).multiplyScalar(this.dist);

    const wantPos = off.add(target);
    // 不要钻进山里
    const gh = this.hf.heightAt(wantPos.x, wantPos.z) + 1.8;
    if (wantPos.y < gh) wantPos.y = gh;

    const follow = 1 - Math.exp(-(moving ? 3.4 : 2.0) * dt);
    this.pos.lerp(wantPos, follow);

    // 看向花瓣，并带一点前瞻
    const lookTarget = new THREE.Vector3().copy(target)
      .addScaledVector(flock.heading, Math.min(speed * 0.22, 3.2) * (1 - s))
      .add(new THREE.Vector3(0, 0.6 - s * 0.2, 0));
    this.look.lerp(lookTarget, 1 - Math.exp(-4.5 * dt));

    // ---- 侧倾：转向时轻微压镜 ----
    let dyaw = this.yaw - this._lastYaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    this._lastYaw = this.yaw;
    const wantRoll = THREE.MathUtils.clamp(-dyaw / Math.max(dt, 1e-3) * 0.055, -0.14, 0.14) * speedT;
    this.roll += (wantRoll - this.roll) * Math.min(1, 2.4 * dt);

    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.up.set(Math.sin(this.roll), Math.cos(this.roll), 0)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    // ---- 景深参数 ----
    this.focusDistance = cam.position.distanceTo(target);
    this.aperture = THREE.MathUtils.lerp(0.34, 1.0, s);
  }
}
