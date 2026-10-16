/**
 * Interaction — controllers and hands share one code path via WebXR select
 * events (trigger on controllers, pinch on hands). Selection is by contact only:
 * the pinch point (hands) or controller tip must touch a scan's bounds.
 *
 * Select once:     grab — the scan follows the hand rigidly while held
 * Select twice:    toggle 1:1 (only one scan at a time; the rest are hidden)
 * Select 3 times:  send the scan back to its grid spot
 * Both hands:      grab the same scan with both to scale / rotate it
 * Controller only: thumbstick X rotates, Y scales while held; B / Y toggles 1:1
 * Sort panel:      squeeze (grip) on a controller, then touch a button
 */

import * as THREE from 'three';
import { InfoLabel } from './info-label.js';

const CONTACT = 0.02;           // metres — touch point to scan bounds for contact
const MULTI_SELECT_MS = 400;    // max gap between selects of a double / triple
const STICK_DEADZONE = 0.15;

const _m = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();

export class Interaction {
  constructor(renderer, scene, gallery, roomMesh, sortPanel) {
    this.renderer = renderer;
    this.scene = scene;
    this.gallery = gallery;
    this.roomMesh = roomMesh;
    this.sortPanel = sortPanel;
    this.info = new InfoLabel(scene);

    this.session = renderer.xr.getSession();
    this.states = new Map();   // XRInputSource → state
    this.twoHand = null;

    this._handlers = {
      selectstart: e => this._guard(() => this._onSelectStart(e)),
      selectend: e => this._guard(() => this._onSelectEnd(e)),
      squeezestart: e => this._guard(() => this._onSqueezeStart(e)),
      inputsourceschange: e => this._guard(() => this._onSourcesChange(e)),
    };
    for (const [type, fn] of Object.entries(this._handlers)) {
      this.session.addEventListener(type, fn);
    }
  }

  dispose() {
    for (const [type, fn] of Object.entries(this._handlers)) {
      this.session.removeEventListener(type, fn);
    }
    for (const st of this.states.values()) this._removeState(st);
    this.scene.remove(this.info.mesh);
  }

  _guard(fn) {
    try { fn(); } catch (err) { console.error('[interaction]', err); }
  }

  // ─── per-source state ────────────────────────────────────────────────────────

  _state(source) {
    let st = this.states.get(source);
    if (!st) {
      st = {
        source,
        hasPose: false,
        ray: new THREE.Ray(),
        grip: new THREE.Matrix4(),
        point: new THREE.Vector3(),   // contact point: pinch point (hands) or controller tip
        grabbed: null,
        offset: new THREE.Matrix4(),  // grip → object
        hovered: null,
        clicks: 0,
        clickScan: null,
        clickTime: 0,
        pending: null,                // double select waiting to see if a third follows
        panelMode: null,
        bWasDown: false,
        cursor: this._makeCursor(),
      };
      this.scene.add(st.cursor);
      this.states.set(source, st);
    }
    return st;
  }

  _removeState(st) {
    if (st.grabbed) this._release(st);
    this.scene.remove(st.cursor);
    st.cursor.geometry.dispose();
    st.cursor.material.dispose();
    this.states.delete(st.source);
  }

  _readPose(st, frame) {
    const ref = this.renderer.xr.getReferenceSpace();
    const rayPose = frame.getPose(st.source.targetRaySpace, ref);
    if (!rayPose) { st.hasPose = false; return false; }

    _m.fromArray(rayPose.transform.matrix);
    st.ray.origin.setFromMatrixPosition(_m);
    st.ray.direction.set(0, 0, -1).transformDirection(_m);

    const gripPose = st.source.gripSpace ? frame.getPose(st.source.gripSpace, ref) : null;
    st.grip.fromArray((gripPose ?? rayPose).transform.matrix);
    // Controllers: the target-ray origin sits at the tip of the controller
    st.point.copy(st.ray.origin);

    const hand = st.source.hand;
    if (hand) {
      const index = hand.get('index-finger-tip');
      const thumb = hand.get('thumb-tip');
      const a = index && frame.getJointPose(index, ref);
      const b = thumb && frame.getJointPose(thumb, ref);
      if (a && b) {
        st.point.set(
          (a.transform.position.x + b.transform.position.x) / 2,
          (a.transform.position.y + b.transform.position.y) / 2,
          (a.transform.position.z + b.transform.position.z) / 2,
        );
      } else {
        st.point.setFromMatrixPosition(st.grip);
      }
    }

    st.hasPose = true;
    return true;
  }

  /** Scan touched by this input: a miniature, or the 1:1 scan you're standing in. */
  _contact(st) {
    return this.gallery.nearest(st.point, CONTACT) ?? this.gallery.focusAt(st.point);
  }

  // ─── events ──────────────────────────────────────────────────────────────────

  _onSelectStart(e) {
    const st = this._state(e.inputSource);
    if (!st.hasPose) this._readPose(st, e.frame);
    if (!st.hasPose) return;
    if (this.sortPanel.touch(st.point)) return; // pressing a sort button, not a scan

    const target = this._contact(st);
    if (!target) return;

    const now = performance.now();
    const repeat = target === st.clickScan && now - st.clickTime < MULTI_SELECT_MS;
    st.clicks = repeat ? st.clicks + 1 : 1;
    st.clickScan = target;
    st.clickTime = now;

    if (st.clicks === 1) {
      st.pending = null;
      this._grab(st, target);
    } else if (st.clicks === 2) {
      st.pending = { scan: target, at: now + MULTI_SELECT_MS };
    } else {
      st.pending = null;
      st.clicks = 0;
      this._returnToGrid(target);
    }
  }

  _onSelectEnd(e) {
    const st = this.states.get(e.inputSource);
    if (st?.grabbed) this._release(st);
  }

  _onSqueezeStart(e) {
    const st = this._state(e.inputSource);
    if (!st.hasPose || this.gallery.focus) return;
    if (this.sortPanel.visible) {
      this.sortPanel.hide();
    } else {
      const pos = st.ray.at(0.3, new THREE.Vector3());
      this.sortPanel.show(pos, st.ray.origin);
    }
  }

  _onSourcesChange(e) {
    for (const source of e.removed) {
      const st = this.states.get(source);
      if (st) this._removeState(st);
    }
  }

  // ─── grab / release / modes ──────────────────────────────────────────────────

  _grab(st, scan) {
    this.gallery.detach(scan);
    scan.cancelAnimation();
    st.grabbed = scan;

    const other = [...this.states.values()].find(o => o !== st && o.grabbed === scan);
    if (other) this._startTwoHand(other, st, scan);
    else this._captureOffset(st);
  }

  _release(st) {
    const scan = st.grabbed;
    st.grabbed = null;
    if (this.twoHand?.scan === scan) {
      const other = this.twoHand.a === st ? this.twoHand.b : this.twoHand.a;
      this.twoHand = null;
      if (other.grabbed === scan) this._captureOffset(other);
    }
  }

  _releaseAll(scan) {
    for (const st of this.states.values()) {
      if (st.grabbed === scan) st.grabbed = null;
    }
    if (this.twoHand?.scan === scan) this.twoHand = null;
  }

  _captureOffset(st) {
    st.grabbed.group.updateWorldMatrix(true, false);
    st.offset.copy(st.grip).invert().multiply(st.grabbed.group.matrixWorld);
  }

  _toggleFullScale(scan) {
    this._releaseAll(scan);
    const current = this.gallery.focus;
    if (!scan.fullScale && current && current !== scan) {
      this._releaseAll(current);
      current.toggleFullScale(); // only one scan at 1:1
    }
    this.gallery.detach(scan);
    scan.toggleFullScale();
    this.gallery.setFocus(scan.fullScale ? scan : null);
    if (scan.fullScale) this.sortPanel.hide();
  }

  _returnToGrid(scan) {
    this._releaseAll(scan);
    this.gallery.returnToGrid(scan);
  }

  // ─── two-hand scale / rotate ─────────────────────────────────────────────────

  _startTwoHand(a, b, scan) {
    const pa = new THREE.Vector3().setFromMatrixPosition(a.grip);
    const pb = new THREE.Vector3().setFromMatrixPosition(b.grip);
    this.twoHand = {
      a, b, scan,
      v0: pb.clone().sub(pa),
      mid0: pa.clone().add(pb).multiplyScalar(0.5),
      pos0: scan.group.position.clone(),
      quat0: scan.group.quaternion.clone(),
      scale0: scan.group.scale.x,
    };
  }

  _applyTwoHand() {
    const t = this.twoHand;
    if (!t.a.hasPose || !t.b.hasPose) return;

    const pa = new THREE.Vector3().setFromMatrixPosition(t.a.grip);
    const pb = new THREE.Vector3().setFromMatrixPosition(t.b.grip);
    const v = pb.clone().sub(pa);
    const d0 = t.v0.length();
    const d = v.length();
    if (d0 < 0.01 || d < 0.01) return;

    const scale = t.scan.clampScale(t.scale0 * d / d0);
    const factor = scale / t.scale0;
    const rot = new THREE.Quaternion().setFromUnitVectors(t.v0.clone().divideScalar(d0), v.divideScalar(d));
    const mid = pa.add(pb).multiplyScalar(0.5);
    const pos = t.pos0.clone().sub(t.mid0).applyQuaternion(rot).multiplyScalar(factor).add(mid);
    const quat = rot.multiply(t.quat0);

    this._applyTransform(t.scan, pos, quat, scale);
  }

  // ─── per frame ───────────────────────────────────────────────────────────────

  update(frame, dt, cameraPos) {
    for (const st of this.states.values()) st.hasPose = false;

    for (const source of this.session.inputSources) {
      const st = this._state(source);
      if (!this._readPose(st, frame)) continue;
      if (!source.hand && source.gamepad) this._handleGamepad(st, source.gamepad, dt);
    }

    const now = performance.now();
    for (const st of this.states.values()) {
      if (st.pending && now >= st.pending.at) {
        this._toggleFullScale(st.pending.scan);
        st.pending = null;
        st.clicks = 0;
      }
    }

    if (this.twoHand) this._applyTwoHand();

    for (const st of this.states.values()) {
      if (!st.grabbed || !st.hasPose || this.twoHand?.scan === st.grabbed) continue;
      _m.multiplyMatrices(st.grip, st.offset).decompose(_pos, _quat, _scl);
      this._applyTransform(st.grabbed, _pos, _quat, _scl.x);
    }

    this._updateContacts(cameraPos);
  }

  _handleGamepad(st, gp, dt) {
    // B (right) / Y (left) toggles 1:1 on the held or touched scan, or ends the current 1:1
    const bDown = !!gp.buttons[5]?.pressed;
    if (bDown && !st.bWasDown) {
      const scan = st.grabbed ?? st.hovered ?? this.gallery.focus;
      if (scan) this._toggleFullScale(scan);
    }
    st.bWasDown = bDown;

    if (!st.grabbed || this.twoHand?.scan === st.grabbed) return;

    const x = gp.axes[2] ?? 0;
    const y = gp.axes[3] ?? 0;
    if (Math.abs(x) > STICK_DEADZONE) {
      st.offset.multiply(_tmp.makeRotationY(-x * dt * 2.5));
    }
    if (Math.abs(y) > STICK_DEADZONE) {
      const current = st.grabbed.group.scale.x;
      const next = st.grabbed.clampScale(current * Math.exp(-y * dt * 1.5));
      const k = next / current;
      st.offset.multiply(_tmp.makeScale(k, k, k));
    }
  }

  _applyTransform(scan, pos, quat, scale) {
    scale = scan.clampScale(scale);
    if (scan.collisionEnabled) {
      pos = this.roomMesh.clampMove(scan.group.position, pos, scan.radiusAt(scale));
    }
    scan.group.position.copy(pos);
    scan.group.quaternion.copy(quat);
    scan.group.scale.setScalar(scale);
  }

  _updateContacts(cameraPos) {
    const hovered = new Set();
    const grabbed = new Set();
    let infoScan = null;

    for (const st of this.states.values()) {
      st.cursor.visible = st.hasPose;
      if (!st.hasPose) continue;
      st.cursor.position.copy(st.point);

      const panelMode = this.sortPanel.touch(st.point);
      if (panelMode && panelMode !== st.panelMode) this.sortPanel.select(panelMode);
      st.panelMode = panelMode;

      if (st.grabbed) {
        grabbed.add(st.grabbed);
        st.hovered = null;
        if (!st.grabbed.fullScale) infoScan = st.grabbed;
      } else {
        st.hovered = panelMode ? null : this._contact(st);
        if (st.hovered) hovered.add(st.hovered);
        if (st.hovered && !st.hovered.fullScale) infoScan ??= st.hovered;
      }
      st.cursor.material.color.setHex(st.grabbed || st.hovered || panelMode ? 0x66ccff : 0xffffff);
    }

    for (const scan of this.gallery.scans) {
      scan.setHighlight(grabbed.has(scan) ? 'grab' : hovered.has(scan) ? 'hover' : 'none');
    }
    this.info.update(infoScan, cameraPos);
  }

  _makeCursor() {
    const cursor = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }),
    );
    cursor.visible = false;
    return cursor;
  }
}
