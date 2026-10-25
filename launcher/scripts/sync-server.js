// Copies the lobby server into the launcher so "Run server on this PC" uses the exact same code.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'server', 'server.js');
const dest = path.join(__dirname, '..', 'lib', 'server-embedded.js');

if (fs.existsSync(src)) {
  const banner = '// AUTO-GENERATED from server/server.js by scripts/sync-server.js. Do not edit here.\n';
  fs.writeFileSync(dest, banner + fs.readFileSync(src, 'utf8'));
  console.log('synced server-embedded.js');
} else if (!fs.existsSync(dest)) {
  console.error('server/server.js not found and no embedded copy exists');
  process.exit(1);
}
