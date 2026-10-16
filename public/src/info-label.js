/**
 * InfoLabel — a card above the scan you're touching: title, date, type,
 * source file, size and detail. One shared instance, redrawn only on change.
 */

import * as THREE from 'three';

const W = 640, H = 220;
const TYPE_LABEL = { 'textured-mesh': 'Textured mesh', mesh: 'Mesh', pointcloud: 'Point cloud' };

const fmt = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

export class InfoLabel {
  constructor(scene) {
    this._canvas = document.createElement('canvas');
    this._canvas.width = W;
    this._canvas.height = H;
    this._tex = new THREE.CanvasTexture(this._canvas);
    this._tex.colorSpace = THREE.SRGBColorSpace;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 0.16 * H / W),
      new THREE.MeshBasicMaterial({ map: this._tex, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 998;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._key = '';
  }

  /** Show the card for `scan` above it, facing `cameraPos`; null hides it. */
  update(scan, cameraPos) {
    if (!scan) { this.mesh.visible = false; return; }

    const key = `${scan.meta.id}/${scan.shownLod}`;
    if (key !== this._key) { this._draw(scan); this._key = key; }

    const pos = scan.group.getWorldPosition(new THREE.Vector3());
    pos.y += scan.radiusAt(scan.group.getWorldScale(new THREE.Vector3()).x) + 0.06;
    this.mesh.position.copy(pos);
    this.mesh.lookAt(cameraPos);
    this.mesh.visible = true;
  }

  _draw(scan) {
    const m = scan.meta;
    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(12,14,20,0.82)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 22);
    ctx.fill();

    const file = (m.source ?? m.id).split('/');
    const name = file.pop();
    const folder = file.join(' / ');
    const bb = m.boundingBox ?? { x: 0, y: 0, z: 0 };
    const size = `${bb.x.toFixed(1)} × ${bb.y.toFixed(1)} × ${bb.z.toFixed(1)} m`;
    const count = m.type === 'pointcloud' ? `${fmt(m.vertexCount)} points` : `${fmt(m.triangleCount)} triangles`;
    const shown = scan.lods[scan.shownLod];
    const level = shown ? `showing L${shown.level}${shown.texture ? ` · ${shown.texture}² tex` : ''}` : '';

    const line = (text, y, font, color) => {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.fillText(text, 26, y, W - 52);
    };
    line(m.title, 50, 'bold 36px system-ui, sans-serif', '#ffffff');
    line(`${m.date ?? 'no date'} · ${TYPE_LABEL[m.type] ?? m.type}`, 92, '28px system-ui, sans-serif', '#cfd6e4');
    line(name, 132, '26px ui-monospace, monospace', '#9fd0ff');
    if (folder) line(folder, 164, '22px system-ui, sans-serif', '#8a93a6');
    line(`${size} · ${count} · ${level}`, 200, '22px system-ui, sans-serif', '#8a93a6');

    this._tex.needsUpdate = true;
  }
}
