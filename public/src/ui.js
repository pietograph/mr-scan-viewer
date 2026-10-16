/** Tiny UI helpers shared across modules. */

const statusEl = document.getElementById('status');

export function setStatus(msg) {
  statusEl.textContent = msg;
  console.log('[status]', msg);
}

export function clearStatus() {
  statusEl.textContent = '';
}
