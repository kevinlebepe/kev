// Recent versions of npm do not run install scripts unless they are approved,
// and Electron downloads its program in one. This does that step if it was
// skipped, so `npm run dev` works straight after `npm install`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronDir = dirname(require.resolve('electron/package.json'));

if (!existsSync(join(electronDir, 'path.txt'))) {
  console.log('Downloading the Electron program (one time, about 100 MB)…');
  execFileSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' });
}
