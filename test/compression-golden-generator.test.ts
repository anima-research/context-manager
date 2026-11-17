import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const generator = resolve('scripts/generate-compression-main-golden.mjs');
// Tiny synthetic module isolates provenance/serialization checks from strategy
// runtime. Real modern + legacy request parity is checked separately.
function fixture(check: (root: string, git: (...args: string[]) => string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'cm-golden-source-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000 }).trim();
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'dist/test'), { recursive: true });
    mkdirSync(join(root, 'node_modules/typescript'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'src/product.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'test/compression-instructions-harness.ts'), '// synthetic harness\n');
    writeFileSync(join(root, 'node_modules/typescript/package.json'), '{"version":"7.0.2"}');
    writeFileSync(join(root, 'dist/test/compression-instructions-harness.js'),
      'export class Probe {}\nexport class KnowledgeProbe {}\nexport async function run() { return [{tools: undefined, system: "synthetic"}]; }\n');
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic source');
    check(root, git);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function capture(root: string, env = process.env) {
  return spawnSync(process.execPath, [generator, root, join(root, 'dist/capture.json')],
    { encoding: 'utf8', timeout: 10000, env });
}

it('generator records actual source HEAD/tree, ignores Git overrides and preserves own undefined', () => {
  fixture((root, git) => {
    const result = capture(root, { ...process.env, GIT_WORK_TREE: process.cwd(), GIT_DIR: resolve('.git') });
    assert.equal(result.status, 0, result.stderr);
    const golden = JSON.parse(readFileSync(join(root, 'dist/capture.json'), 'utf8'));
    assert.equal(golden.source, git('rev-parse', 'HEAD'));
    assert.equal(golden.sourceTree, git('rev-parse', 'HEAD^{tree}'));
    assert.equal(Object.keys(golden.requests).length, 93);
    assert.deepEqual(golden.requests['base/chunk/own/L2'][0].tools, { $cmGoldenUndefined: true });
  });
});

it('generator refuses archived/build folders with an enclosing Git parent', () => {
  fixture(root => {
    const archive = join(root, 'dist/archive');
    mkdirSync(archive);
    const result = capture(archive);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Source root must equal its Git top-level/);
  });
});

it('generator refuses tracked dirty product source and untracked product additions', () => {
  fixture(root => {
    writeFileSync(join(root, 'src/product.ts'), 'export const value = 2;\n');
    let result = capture(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing dirty source worktree/);
    writeFileSync(join(root, 'src/product.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'src/new.ts'), 'export const added = true;\n');
    result = capture(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing dirty source worktree/);
  });
});

it('generator permits an untracked legacy test harness, not tracked source edits', () => {
  fixture((root, git) => {
    git('rm', 'test/compression-instructions-harness.ts');
    git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'legacy source without harness');
    mkdirSync(join(root, 'test'), { recursive: true }); // git rm removed the now-empty directory.
    writeFileSync(join(root, 'test/compression-instructions-harness.ts'), '// untracked legacy port\n');
    const result = capture(root);
    assert.equal(result.status, 0, result.stderr);
    const golden = JSON.parse(readFileSync(join(root, 'dist/capture.json'), 'utf8'));
    assert.equal(golden.source, git('rev-parse', 'HEAD'));
  });
});
