/**
 * Local HTTPS server for MR Scan Viewer.
 * Serves public/ (the app) and scans/ (converted scans) over HTTPS — WebXR needs it.
 *
 * Usage: npm run cert   (once, creates server/certs/ for this machine's LAN address)
 *        npm start      then open https://<LAN_IP>:3443 in the Quest browser
 * Ports: $PORT (HTTPS, default 3443) and $HTTP_PORT (redirect, default 3080).
 */

import https from 'https';
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';

import express from 'express';
import cors from 'cors';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PORT_HTTPS = Number(process.env.PORT ?? 3443);
const PORT_HTTP  = Number(process.env.HTTP_PORT ?? 3080); // redirects to HTTPS
const CERT_DIR = join(__dirname, 'certs');

// ─── cert ───────────────────────────────────────────────────────────────────

function findCert() {
  const cert = join(CERT_DIR, 'cert.pem');
  const key = join(CERT_DIR, 'key.pem');
  return existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : null;
}

// ─── app ────────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({ origin: '*' }));

// Large file support — scans can be 15+ MB
app.use((req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// Static: serve public/ (app) and scans/ (3D data)
app.use(express.static(join(ROOT, 'public')));
app.use('/scans', express.static(join(ROOT, 'scans')));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── servers ─────────────────────────────────────────────────────────────────

const tlsCreds = findCert();

if (tlsCreds) {
  const httpsServer = https.createServer(tlsCreds, app);
  httpsServer.listen(PORT_HTTPS, '0.0.0.0', () => {
    printBanner(PORT_HTTPS);
  });

  // HTTP → HTTPS redirect
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host?.replace(/:\d+$/, '')}:${PORT_HTTPS}${req.url}` });
    res.end();
  }).listen(PORT_HTTP, '0.0.0.0');

} else {
  console.warn('\n⚠  No TLS certificate in server/certs/ — falling back to HTTP.');
  console.warn('   WebXR needs HTTPS: run `npm run cert` (requires mkcert), then restart.\n');
  app.listen(PORT_HTTP, '0.0.0.0', () => printBanner(PORT_HTTP, false));
}

function printBanner(port, https = true) {
  const proto = https ? 'https' : 'http';
  const lan = getLanIP();
  const url = `${proto}://${lan}:${port}`;

  console.log('\n┌────────────────────────────────────────────────────┐');
  console.log('│  MR Scan Viewer                                    │');
  console.log('├────────────────────────────────────────────────────┤');
  console.log(`│  Local:    ${proto}://localhost:${port}`.padEnd(53) + '│');
  console.log(`│  Network:  ${url}`.padEnd(53) + '│');
  console.log('├────────────────────────────────────────────────────┤');
  console.log('│  Open the Network URL in the Quest browser and     │');
  console.log('│  accept the certificate warning once.              │');
  console.log('└────────────────────────────────────────────────────┘\n');
}

function getLanIP() {
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}
