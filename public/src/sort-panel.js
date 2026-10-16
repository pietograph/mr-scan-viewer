/**
 * SortPanel — in-world panel with three sort buttons.
 * Opened with the squeeze (grip) button; press a button by touching it.
 */

import * as THREE from 'three';

const MODES = ['date', 'size', 'vertices'];
const LABELS = { date: 'By Date', size: 'By Size', vertices: 'By Vertices' };
const PANEL_W = 0.4, PANEL_H = 0.125;

export class SortPanel {
  constructor(scene, gallery) {
    this.gallery = gallery;
    this.current = gallery.sortMode;

    this._canvas = document.createElement('canvas');
    this._canvas.width = 512;
    this._canvas.height = 160;
    this._tex = new THREE.CanvasTexture(this._canvas);

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_W, PANEL_H),
      new THREE.MeshBasicMaterial({ map: this._tex, transparent: true, depthTest: false }),
    );
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._draw();
  }

  get visible() { return this.mesh.visible; }

  show(position, facing) {
    this.mesh.position.copy(position);
    this.mesh.lookAt(facing);
    this.mesh.updateMatrixWorld();
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }

  /** Sort mode whose button `point` is touching (within 2 cm of the panel), or null. */
  touch(point) {
    if (!this.visible) return null;
    const local = this.mesh.worldToLocal(point.clone());
    if (Math.abs(local.z) > 0.02) return null;
    const u = local.x / PANEL_W + 0.5;
    const v = local.y / PANEL_H + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return MODES[Math.min(MODES.length - 1, Math.floor(u * MODES.length))];
  }

  select(mode) {
    this.current = mode;
    this.gallery.setSort(mode);
    this._draw();
  }

  _draw() {
    const ctx = this._canvas.getContext('2d');
    const w = 512 / MODES.length;
    ctx.clearRect(0, 0, 512, 160);
    MODES.forEach((mode, i) => {
      const active = mode === this.current;
      ctx.fillStyle = active ? 'rgba(100,180,255,0.95)' : 'rgba(30,30,45,0.85)';
      ctx.beginPath();
      ctx.roundRect(i * w + 4, 4, w - 8, 152, 14);
      ctx.fill();
      ctx.fillStyle = active ? '#111' : '#eee';
      ctx.font = 'bold 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(LABELS[mode], i * w + w / 2, 92);
    });
    this._tex.needsUpdate = true;
  }
}
