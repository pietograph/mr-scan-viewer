/**
 * Manages the WebXR immersive-ar session: features, frame loop, teardown.
 */

import * as THREE from 'three';
import { RoomMesh } from './room-mesh.js';
import { Interaction } from './interaction.js';
import { SortPanel } from './sort-panel.js';
import { Hud } from './hud.js';
import { frameFromPlanes, frameAroundViewer } from './room-frame.js';
import { setStatus } from './ui.js';

export class XRSession {
  constructor(renderer, scene, camera, gallery) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.gallery = gallery;
    this.clock = new THREE.Clock();
    this._placed = false;
  }

  async start() {
    const params = new URLSearchParams(location.search);
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      // Planes give the room outline (floor, walls, ceiling); the mesh is for collision and
      // furniture. ?nomesh turns the mesh off — handy for A/B performance checks.
      optionalFeatures: params.has('nomesh')
        ? ['plane-detection', 'hand-tracking']
        : ['plane-detection', 'mesh-detection', 'hand-tracking'],
    });
    this.renderer.xr.setReferenceSpaceType('local-floor');
    const scale = parseFloat(params.get('scale')) || 1.3; // supersample instead of MSAA (see main.js)
    this.renderer.xr.setFramebufferScaleFactor(scale); // must precede setSession
    await this.renderer.xr.setSession(session);
    this.session = session;

    this.roomMesh ??= new RoomMesh(this.scene, { debug: params.has('debugRoom') });
    this.sortPanel ??= new SortPanel(this.scene, this.gallery);
    this.hud ??= new Hud(this.camera, this.renderer);
    this.interaction = new Interaction(this.renderer, this.scene, this.gallery, this.roomMesh, this.sortPanel);

    // Wait briefly for the room data so the grid can fill the room; hide it until then
    const enabled = session.enabledFeatures;
    this._meshEnabled = enabled ? enabled.includes('mesh-detection') : !params.has('nomesh');
    const planesEnabled = enabled ? enabled.includes('plane-detection') : true;
    this._placeDeadline = performance.now() + (this._meshEnabled || planesEnabled ? 4000 : 0);
    this._roomInfo = 'room: waiting…';
    this.gallery.anchor.visible = false;

    session.addEventListener('end', () => this._onSessionEnd());
    this.clock.getDelta();
    this.renderer.setAnimationLoop((t, frame) => this._onFrame(frame));
    setStatus('Mixed Reality active');
  }

  _onFrame(frame) {
    if (!frame) return;
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    const ref = this.renderer.xr.getReferenceSpace();
    const t0 = performance.now();

    try {
      this.roomMesh.update(frame, ref);
      if (!this._placed) this._place(frame, ref);
      this.interaction.update(frame, dt, this.camera.position);
      this.gallery.update(dt, this.camera.position);
    } catch (err) {
      console.error('[xr-frame]', err);
    }
    this.hud.addCpu(performance.now() - t0);
    this.hud.update(rawDt, { rebuilds: this.roomMesh.rebuilds, room: this._roomInfo });

    // Pull this frame's head pose into `camera` before render() updates world
    // matrices, so head-locked children (the HUD) don't lag a frame behind
    this.renderer.xr.updateCamera(this.camera);
    this.hud.beginRender();
    this.renderer.render(this.scene, this.camera);
    this.hud.endRender();
  }

  _place(frame, ref) {
    const late = performance.now() > this._placeDeadline;
    const meshReady = this.roomMesh.hasMesh || !this._meshEnabled;

    // Planes first, but wait for the mesh too (it's what keeps cells out of furniture)
    let room = meshReady || late ? frameFromPlanes(frame, ref) : null;
    if (!room && this.roomMesh.hasMesh && late) room = this.roomMesh.computeFrame();
    if (!room && late) {
      const viewer = frame.getViewerPose(ref);
      if (viewer) room = frameAroundViewer(viewer.transform);
    }
    if (!room) return;

    this.gallery.placeIn(room, this.roomMesh.hasMesh ? this.roomMesh : null);
    this._roomInfo = `room ${room.width.toFixed(1)}×${room.depth.toFixed(1)}×${room.ceiling.toFixed(1)} m · ${room.source}`;
    console.log('[gallery]', this._roomInfo, `yaw ${THREE.MathUtils.radToDeg(room.yaw).toFixed(0)}°`);
    this.gallery.anchor.visible = true;
    this._placed = true;
  }

  _onSessionEnd() {
    this.renderer.setAnimationLoop(null);
    this.interaction?.dispose();
    this.sortPanel?.hide();
    this.session = null;
    this._placed = false;
    this.gallery.anchor.visible = true;
    document.getElementById('overlay').classList.remove('hidden');
    document.getElementById('xr-button').disabled = false;
    setStatus('Session ended');
  }
}
