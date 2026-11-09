import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const npm = (args, stdio) => execFileSync('npm', args, { encoding: 'utf8', stdio });

const manifest = read('package.json');
const ranges = new Map();
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (ranges.has(name) && ranges.get(name) !== range) throw new Error(`${name} has two ranges, ${ranges.get(name)} and ${range}`);
    ranges.set(name, range);
  }
}

const floors = [...ranges].map(([name, range]) => {
  const admitted = [JSON.parse(npm(['view', `${name}@${range}`, 'version', '--json']))].flat();
  const prerelease = admitted.find((version) => !/^\d+\.\d+\.\d+$/.test(version));
  if (prerelease) throw new Error(`${name}'s range ${range} admits ${prerelease}, which isn't a plain release`);
  const floor = admitted.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0];
  console.log(`${name}: ${range} admits ${admitted.join(', ')}; installing ${floor}`);
  return { name, floor };
});

npm(['install', '--no-save', ...floors.map(({ name, floor }) => `${name}@${floor}`)], 'inherit');

const missed = floors.filter(({ name, floor }) => read(`node_modules/${name}/package.json`).version !== floor);
if (missed.length > 0) {
  throw new Error(`node_modules doesn't hold the floor of ${missed.map(({ name, floor }) => `${name} (${floor})`).join(', ')}`);
}
