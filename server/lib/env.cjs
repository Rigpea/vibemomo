// Load local configuration before any entry point captures its paths or port.
// CommonJS keeps the same loader usable by both the server/CLI and Electron.
'use strict';
const path = require('node:path');

try {
  process.loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') console.error('[atelier] .env not loaded:', err.message);
}
