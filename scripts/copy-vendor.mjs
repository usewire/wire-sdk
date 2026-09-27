// tsc compiles src/ but never copies plain .js or .d.ts files, so the vendored
// engine build (src/vendor/manifest) is copied into dist/ after it. ref.ts is
// ordinary TypeScript and tsc has already emitted it.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src/vendor/manifest');
const to = join(root, 'dist/vendor/manifest');

if (!existsSync(join(from, 'manifest.js'))) {
  console.error('src/vendor/manifest/manifest.js is missing: run scripts/vendor-manifest.sh');
  process.exit(1);
}
cpSync(from, to, {
  recursive: true,
  filter: (src) => !src.endsWith('.ts') || src.endsWith('.d.ts'),
});
