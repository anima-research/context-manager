// Build first. Run the repository's offline suite without the real provider test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const directories = ['dist/test', 'dist/test/adaptive'];
const files = directories.flatMap(directory => fs.readdirSync(path.join(root, directory))
  .filter(name => name.endsWith('.test.js'))
  .map(name => `${directory}/${name}`))
  .filter(file => file !== 'dist/test/autobiographical.test.js')
  .sort();

console.log(`Running ${files.length} offline test files; real Anthropic integration excluded.`);
const result = spawnSync(process.execPath, [
  '--max-old-space-size=1024', '--test', '--test-concurrency=1',
  '--test-reporter=tap', ...files,
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.signal) throw new Error(`Offline test process ended with ${result.signal}`);
process.exitCode = result.status ?? 1;
