import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const npm = (args, stdio) => execFileSync('npm', args, { encoding: 'utf8', stdio });

if (process.env.LEG) {
  const { name, install } = JSON.parse(process.env.LEG);
  console.log(`${name}: installing ${Object.entries(install).map(([pkg, version]) => `${pkg}@${version}`).join(', ')}`);
  npm(['install', '--no-save', ...Object.entries(install).map(([pkg, version]) => `${pkg}@${version}`)], 'inherit');
  const missed = Object.entries(install).filter(([pkg, version]) => read(`node_modules/${pkg}/package.json`).version !== version);
  if (missed.length > 0) {
    throw new Error(`node_modules doesn't hold ${missed.map(([pkg, version]) => `${pkg}@${version}`).join(', ')}`);
  }
  process.exit(0);
}

const manifest = read('package.json');
const ranges = new Map();
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (ranges.has(name) && ranges.get(name) !== range) throw new Error(`${name} has two ranges, ${ranges.get(name)} and ${range}`);
    ranges.set(name, range);
  }
}

const order = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const floors = new Map([...ranges].map(([name, range]) => {
  const lines = range.split('||').map((member) => {
    const admitted = [JSON.parse(npm(['view', `${name}@${member.trim()}`, 'version', '--json']))].flat();
    const prerelease = admitted.find((version) => !/^\d+\.\d+\.\d+$/.test(version));
    if (prerelease) throw new Error(`${name}'s range ${range} admits ${prerelease}, which isn't a plain release`);
    return admitted.sort(order)[0];
  });
  const distinct = [...new Set(lines)].sort(order);
  console.error(`${name}: ${range} has its floor${distinct.length > 1 ? 's' : ''} at ${distinct.join(', ')}`);
  return [name, distinct];
}));

const lowest = Object.fromEntries([...floors].map(([name, distinct]) => [name, distinct[0]]));
const legs = [{ name: 'lowest', install: lowest }];
for (const [name, distinct] of floors) {
  for (const floor of distinct.slice(1)) legs.push({ name: `${name} ${floor}`, install: { ...lowest, [name]: floor } });
}
console.log(JSON.stringify(legs));
