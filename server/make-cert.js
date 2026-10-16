/**
 * Creates server/certs/cert.pem + key.pem with mkcert for this machine's LAN
 * address, localhost and 127.0.0.1. Re-run if your LAN address changes.
 */

import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'certs');
const lan = Object.values(networkInterfaces()).flat()
  .filter(a => a.family === 'IPv4' && !a.internal)
  .map(a => a.address);

mkdirSync(dir, { recursive: true });
try {
  execFileSync('mkcert', [
    '-cert-file', join(dir, 'cert.pem'),
    '-key-file', join(dir, 'key.pem'),
    ...lan, 'localhost', '127.0.0.1',
  ], { stdio: 'inherit' });
} catch (err) {
  console.error(err.code === 'ENOENT'
    ? 'mkcert not found — install it first (macOS: brew install mkcert).'
    : `mkcert failed: ${err.message}`);
  process.exit(1);
}
