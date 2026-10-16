/**
 * Gallery — every scan as a miniature in a walk-through 3D grid that fills the
 * room: aligned with the walls, centred, kept off walls and furniture.
 * Scans that have been picked up leave the grid and stay where they're put.
 * Sort modes: 'date' | 'size' | 'vertices'
 */

import * as THREE from 'three';
import { ScanObject } from './scan-object.js';

const WALL_MARGIN = 0.45;                   // metres kept free along the walls
const LAYERS = [0.8, 1.25, 1.7];            // cell heights above the floor — within reach
const EXTRA_LAYER = 2.1;                    // only used when the room is too small
const MAX_SPACING = 1.2;
const MIN_SPACING = 0.45;                   // still leaves room to walk between columns
const TIGHTEST_SPACING = 0.25;              // only for rooms too small for everything
const SURFACE_CLEARANCE = 0.15;             // skip cells this close to furniture
const LOAD_CONCURRENCY = 4;
const SPIN_SPEED = 0.25;                    // rad/s for miniatures resting in the grid
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

const diag2 = m => {
  const b = m.boundingBox ?? {};
  return (b.x ?? 0) ** 2 + (b.y ?? 0) ** 2 + (b.z ?? 0) ** 2;
};

export class Gallery {
  constructor(scene, manifest) {
    this.scene = scene;
    this.sortMode = 'date';
    this.frame = null;
    this.cells = [];
    this.focus = null;                // the scan shown at 1:1, if any — everything else is hidden

    this.anchor = new THREE.Group();  // origin on the floor at the room centre, axes along the walls
    scene.add(this.anchor);

    this.scans = manifest.map(m => new ScanObject(m));
    this.scans.forEach((s, i) => {
      s.spin = i * 0.7; // varied starting angles
      this.anchor.add(s.group);
    });

    // Desktop preview: a 3 × 3 m room in front of the default camera
    this.placeIn({ center: new THREE.Vector3(0, 0, -2), yaw: 0, width: 3, depth: 3, ceiling: 2.4 });
  }

  async loadAll(onProgress) {
    const queue = [...this.scans];
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const scan = queue.shift();
        try {
          await scan.load();
        } catch (err) {
          console.error(`Failed to load ${scan.meta.id}:`, err);
        }
        onProgress?.(++done, this.scans.length);
      }
    };
    await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
    this.placeIn(this.frame, this._roomMesh, true);
  }

  // ─── placement ───────────────────────────────────────────────────────────────

  /**
   * Fill `frame` ({ center, yaw, width, depth, ceiling }) with grid cells.
   * `roomMesh` (optional) is used to skip cells inside furniture.
   */
  placeIn(frame, roomMesh = null, snap = true) {
    this.frame = frame;
    this._roomMesh = roomMesh;
    this.anchor.position.copy(frame.center);
    this.anchor.rotation.set(0, frame.yaw, 0);
    this.anchor.updateMatrixWorld(true);
    this.cells = this._findCells(this._ordered().length);
    this._layout(snap);
  }

  _findCells(count) {
    const ceiling = Math.max(2.0, this.frame.ceiling);
    const layers = LAYERS.filter(y => y <= ceiling - 0.3);
    const tall = EXTRA_LAYER <= ceiling - 0.2 ? [...layers, EXTRA_LAYER] : layers;

    // Preference: roomy spacing on reachable layers → add the top layer → tighten below 45 cm
    const attempts = [];
    for (let s = MAX_SPACING; s >= MIN_SPACING - 1e-6; s -= 0.05) attempts.push([s, layers]);
    for (let s = MAX_SPACING; s >= MIN_SPACING - 1e-6; s -= 0.05) attempts.push([s, tall]);
    for (let s = MIN_SPACING - 0.05; s >= TIGHTEST_SPACING - 1e-6; s -= 0.05) attempts.push([s, tall]);

    let cells = [];
    for (const [spacing, ys] of attempts) {
      const found = this._grid(spacing, ys);
      if (found.length > cells.length) cells = found;
      if (cells.length >= count) break;
    }

    // Use the cells nearest the room centre, then order them row by row
    cells.sort((a, b) => (a.x ** 2 + a.z ** 2) - (b.x ** 2 + b.z ** 2));
    cells = cells.slice(0, count);
    cells.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);

    // Still too many scans: share cells side by side rather than stacking out of reach
    const fitted = cells.length;
    for (let i = 0; cells.length < count; i++) {
      const src = fitted ? cells[i % fitted] : new THREE.Vector3(0, 1.25, 0);
      const tier = 1 + Math.floor(i / Math.max(1, fitted));
      cells.push(src.clone().add(new THREE.Vector3(0.09 * tier, 0, 0.09 * tier)));
    }
    return cells;
  }

  _grid(spacing, layers) {
    const w = Math.max(0, this.frame.width - 2 * WALL_MARGIN);
    const d = Math.max(0, this.frame.depth - 2 * WALL_MARGIN);
    const nu = Math.floor(w / spacing) + 1;
    const nv = Math.floor(d / spacing) + 1;
    const cells = [];
    const world = new THREE.Vector3();
    for (let iv = 0; iv < nv; iv++) {
      for (let iu = 0; iu < nu; iu++) {
        for (const y of layers) {
          const local = new THREE.Vector3((iu - (nu - 1) / 2) * spacing, y, (iv - (nv - 1) / 2) * spacing);
          world.copy(local).applyMatrix4(this.anchor.matrixWorld);
          if (this._roomMesh?.isNearSurface(world, SURFACE_CLEARANCE)) continue;
          cells.push(local);
        }
      }
    }
    return cells;
  }

  // ─── layout / sorting ────────────────────────────────────────────────────────

  /** All loadable scans in sort order — each keeps a home cell even while placed elsewhere. */
  _ordered() {
    const list = this.scans.filter(s => !s.failed);
    switch (this.sortMode) {
      case 'size':     return list.sort((a, b) => diag2(b.meta) - diag2(a.meta));
      case 'vertices': return list.sort((a, b) => (b.meta.vertexCount ?? 0) - (a.meta.vertexCount ?? 0));
      default:         return list.sort((a, b) => (b.meta.date ?? '').localeCompare(a.meta.date ?? ''));
    }
  }

  _layout(snap) {
    this._ordered().forEach((scan, i) => {
      scan.slot = this.cells[i] ?? null;
      if (snap && scan.slot && scan.inGallery) scan.group.position.copy(scan.slot);
    });
  }

  setSort(mode) {
    this.sortMode = mode;
    this._layout(false);
  }

  /** Take a scan out of the grid; it keeps its world transform and stays where placed. */
  detach(scan) {
    if (!scan.inGallery) return;
    this.scene.attach(scan.group);
    scan.inGallery = false;
  }

  /** Send a scan back to its home cell (from anywhere, including 1:1). */
  returnToGrid(scan) {
    if (scan.fullScale) {
      scan.leaveFullScale();
      if (this.focus === scan) this.setFocus(null);
    }
    scan.cancelAnimation();
    if (!scan.inGallery) {
      this.anchor.attach(scan.group);
      scan.inGallery = true;
      scan.spin = new THREE.Euler().setFromQuaternion(scan.group.quaternion, 'YXZ').y;
    }
  }

  /** Show only `scan` (at 1:1), or everything again with null. */
  setFocus(scan) {
    this.focus = scan;
    for (const s of this.scans) s.group.visible = !s.failed && (!scan || s === scan);
  }

  // ─── queries ─────────────────────────────────────────────────────────────────

  /** Miniature within `maxDist` of `point`, for direct hand grabs. */
  nearest(point, maxDist) {
    let best = null;
    let bestDist = maxDist;
    for (const scan of this.scans) {
      if (scan.fullScale || !scan.group.visible) continue;
      const d = scan.distanceTo(point);
      if (d <= bestDist) { best = scan; bestDist = d; }
    }
    return best;
  }

  /** The 1:1 scan if `point` is inside its bounds (you're usually standing in it). */
  focusAt(point) {
    return this.focus && this.focus.distanceTo(point) === 0 ? this.focus : null;
  }

  // ─── per frame ───────────────────────────────────────────────────────────────

  update(dt, cameraPos) {
    const k = 1 - Math.exp(-6 * dt);
    for (const scan of this.scans) {
      if (scan.inGallery && scan.slot) {
        // Ease back to the home cell, upright, at miniature size, slowly spinning
        const g = scan.group;
        g.position.lerp(scan.slot, k);
        scan.spin += dt * SPIN_SPEED;
        g.quaternion.slerp(_q.setFromAxisAngle(_up, scan.spin), k);
        g.scale.setScalar(Math.exp(Math.log(g.scale.x) * (1 - k))); // geometric → 1
      }
      scan.update(dt, cameraPos);
    }
  }
}
