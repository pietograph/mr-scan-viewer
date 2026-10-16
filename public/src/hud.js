/**
 * Hud — head-locked performance readout. Hidden with ?nohud.
 *
 *   line 1: fps, triangles per frame (both eyes)
 *   line 2: cpu = our per-frame logic, draw = CPU cost of renderer.render(),
 *           gpu = GPU time (if EXT_disjoint_timer_query_webgl2 exists),
 *           worst = longest frame in the last window (hitches)
 *   line 3: draw calls, GPU textures, room mesh rebuilds, render resolution
 *   line 4: room size the grid was fitted to, and where that came from
 *
 * Budget at 72 Hz is 13.9 ms per frame.
 */

import * as THREE from 'three';

const REFRESH = 0.5; // seconds between redraws — canvas uploads aren't free
const W = 512, H = 204;

export class Hud {
  constructor(camera, renderer) {
    this.renderer = renderer;
    this._reset();
    this._gpuMs = null;

    const gl = renderer.getContext();
    this._gl = gl;
    this._timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this._query = null;
    this._querying = false;

    this._canvas = document.createElement('canvas');
    this._canvas.width = W;
    this._canvas.height = H;
    this._tex = new THREE.CanvasTexture(this._canvas);
    this._tex.colorSpace = THREE.SRGBColorSpace;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.13, 0.13 * H / W),
      new THREE.MeshBasicMaterial({ map: this._tex, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.position.set(0, -0.11, -0.4);
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = !new URLSearchParams(location.search).has('nohud');
    camera.add(this.mesh);
  }

  _reset() {
    this._frames = 0;
    this._elapsed = 0;
    this._worst = 0;
    this._cpu = 0;
    this._draw = 0;
  }

  addCpu(ms) { this._cpu += ms; }

  beginRender() {
    this._t0 = performance.now();
    if (this._timer && !this._query) {
      this._query = this._gl.createQuery();
      this._gl.beginQuery(this._timer.TIME_ELAPSED_EXT, this._query);
      this._querying = true;
    }
  }

  endRender() {
    this._draw += performance.now() - this._t0;
    if (this._querying) {
      this._gl.endQuery(this._timer.TIME_ELAPSED_EXT);
      this._querying = false;
    }
  }

  _pollGpu() {
    const gl = this._gl;
    if (!this._query || this._querying) return;
    if (!gl.getQueryParameter(this._query, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(this._timer.GPU_DISJOINT_EXT)) {
      this._gpuMs = gl.getQueryParameter(this._query, gl.QUERY_RESULT) / 1e6;
    }
    gl.deleteQuery(this._query);
    this._query = null;
  }

  update(dt, { rebuilds = 0, room = '' } = {}) {
    this._frames++;
    this._elapsed += dt;
    this._worst = Math.max(this._worst, dt);
    if (this._timer) this._pollGpu();
    if (this._elapsed < REFRESH) return;

    const n = this._frames;
    const fps = n / this._elapsed;
    const cpu = this._cpu / n;
    const draw = this._draw / n;
    const worst = this._worst * 1000;
    this._reset();
    if (!this.mesh.visible) return;

    const { render, memory } = this.renderer.info; // previous frame
    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 18);
    ctx.fill();

    const color = ms => (ms < 8 ? '#7dffa0' : ms < 13 ? '#ffd166' : '#ff6b6b');

    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillStyle = fps >= 68 ? '#7dffa0' : fps >= 50 ? '#ffd166' : '#ff6b6b';
    ctx.fillText(`${fps.toFixed(0)} fps`, 20, 50);
    ctx.font = '30px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${(render.triangles / 1000).toFixed(0)}k tris`, 210, 48);

    ctx.font = '26px ui-monospace, monospace';
    let x = 20;
    for (const [label, ms] of [['cpu', cpu], ['draw', draw], ['gpu', this._gpuMs], ['worst', worst]]) {
      const text = `${label} ${ms === null ? 'n/a' : ms.toFixed(1)}`;
      ctx.fillStyle = ms === null ? '#888' : label === 'worst' ? (ms > 28 ? '#ff6b6b' : '#bbbbbb') : color(ms);
      ctx.fillText(text, x, 98);
      x += ctx.measureText(text).width + 22;
    }

    ctx.font = '24px system-ui, sans-serif';
    ctx.fillStyle = '#bbbbbb';
    const layer = this.renderer.xr.getBaseLayer?.();
    const res = layer ? `${layer.framebufferWidth}×${layer.framebufferHeight}` : '?';
    const aa = this._gl.getContextAttributes()?.antialias ? 'aa' : 'no-aa';
    ctx.fillText(`${render.calls} draws · ${memory.textures} tex · rebuilds ${rebuilds} · ${res} ${aa}`, 20, 144);
    ctx.fillText(room, 20, 184, W - 40);

    this._tex.needsUpdate = true;
  }
}
