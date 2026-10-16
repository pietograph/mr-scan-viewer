/**
 * Entry point — renderer, scene, manifest + model preload, XR button.
 */

import * as THREE from 'three';
import { XRSession } from './xr-session.js';
import { Gallery } from './gallery.js';
import { initLoaders, texturesOf } from './scan-object.js';
import { setStatus } from './ui.js';

// Diagnostic switches: ?empty (no scans), ?aa (MSAA on), ?scale=0.6, ?nomesh, ?nohud
const params = new URLSearchParams(location.search);

// ─── renderer / scene ────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById('canvas'),
  // MSAA edges composite over passthrough with a dark 1px rim; supersampling (scale) smooths instead
  antialias: params.has('aa'),
  alpha: true, // transparent background → passthrough shows through
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
initLoaders(renderer);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0, 1.6, 0);
scene.add(camera); // so head-locked children (HUD) render

// Only affects untextured meshes; textured scans are rendered unlit
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(2, 4, 3);
scene.add(new THREE.AmbientLight(0xffffff, 0.8), sun);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ─── desktop preview loop (XR session has its own) ───────────────────────────

let gallery = null;
let rafId = 0;
function desktopLoop() {
  rafId = requestAnimationFrame(desktopLoop);
  gallery?.update(1 / 60, camera.position);
  renderer.render(scene, camera);
}
renderer.xr.addEventListener('sessionstart', () => cancelAnimationFrame(rafId));
renderer.xr.addEventListener('sessionend', () => desktopLoop());
desktopLoop();

// ─── boot ────────────────────────────────────────────────────────────────────

const loadingEl = document.getElementById('loading');

async function init() {
  let manifest;
  try {
    const res = await fetch('/scans/manifest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = params.has('empty') ? [] : await res.json();
  } catch (err) {
    console.error('Failed to load manifest:', err);
    setStatus('Could not load scan manifest — is the server running?');
    loadingEl.classList.add('hidden');
    return;
  }

  gallery = new Gallery(scene, manifest);
  await gallery.loadAll((done, total) => {
    loadingEl.textContent = `Loading scans… ${done} / ${total}`;
  });
  loadingEl.textContent = 'Preparing GPU…';
  await prewarm();

  const ok = gallery.scans.filter(s => s.loaded).length;
  document.getElementById('scan-count').textContent =
    ok === manifest.length ? `${ok} scans` : `${ok} of ${manifest.length} scans loaded`;

  loadingEl.classList.add('hidden');
  document.getElementById('overlay').classList.remove('hidden');
  setupXRButton();
}

/**
 * three.js uploads textures and compiles shaders the first time an object is
 * drawn — i.e. when it first comes into view, stalling that frame. Do it now.
 */
async function prewarm() {
  const hidden = gallery.scans.map(s => s.helper).filter(h => h && !h.visible);
  for (const h of hidden) h.visible = true;
  for (const tex of texturesOf(scene)) renderer.initTexture(tex);
  await renderer.compileAsync(scene, camera);
  for (const h of hidden) h.visible = false;
}

function setupXRButton() {
  const btn = document.getElementById('xr-button');
  if (!navigator.xr) {
    btn.textContent = 'WebXR not supported';
    return;
  }
  navigator.xr.isSessionSupported('immersive-ar').then(supported => {
    if (!supported) {
      btn.textContent = 'AR not supported on this device';
      setStatus('Open this page on a Meta Quest 3.');
      return;
    }
    btn.disabled = false;
    btn.addEventListener('click', startXR);
  });
}

const xr = { session: null };

async function startXR() {
  const btn = document.getElementById('xr-button');
  btn.disabled = true;
  try {
    xr.session ??= new XRSession(renderer, scene, camera, gallery);
    await xr.session.start();
    document.getElementById('overlay').classList.add('hidden');
  } catch (err) {
    console.error('Failed to start XR session:', err);
    setStatus(`XR error: ${err.message}`);
    btn.disabled = false;
  }
}

init();
