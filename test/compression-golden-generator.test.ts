import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const generator = resolve('scripts/generate-compression-main-golden.mjs');
// Tiny synthetic module isolates provenance/serialization checks from strategy
// runtime. Real modern + legacy request parity is checked separately.
function fixture(check: (root: string, git: (...args: string[]) => string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'cm-golden-source-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', timeout: 10000, env }).trim();
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'dist/test'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'src/product.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', rootDir: '.', skipLibCheck: true,
    }, include: ['src/**/*.ts', 'test/**/*.ts'] }));
    writeFileSync(join(root, 'test/compression-instructions-harness.ts'),
      'export class Probe {}\nexport class KnowledgeProbe {}\nexport async function run() { return [{tools: undefined, system: "synthetic"}]; }\n');
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
    { encoding: 'utf8', timeout: 30000, env });
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
    const harness = readFileSync(join(root, 'test/compression-instructions-harness.ts'));
    git('rm', 'test/compression-instructions-harness.ts');
    git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'legacy source without harness');
    mkdirSync(join(root, 'test'), { recursive: true }); // git rm removed the now-empty directory.
    writeFileSync(join(root, 'test/compression-instructions-harness.ts'), harness);
    const result = capture(root);
    assert.equal(result.status, 0, result.stderr);
    const golden = JSON.parse(readFileSync(join(root, 'dist/capture.json'), 'utf8'));
    assert.equal(golden.source, git('rev-parse', 'HEAD'));
  });
});

it('fixture ignores inherited repository, index and global configuration overrides', () => {
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = '/nonexistent/cm-hostile';
    fixture((root, git) => assert.equal(git('rev-parse', '--show-toplevel'), root));
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

it('generator rebuilds rather than trusting stale dist and records installed dependency metadata', () => {
  fixture(root => {
    writeFileSync(join(root, 'dist/test/compression-instructions-harness.js'), 'throw new Error("STALE DIST");');
    const result = capture(root);
    assert.equal(result.status, 0, result.stderr);
    const golden = JSON.parse(readFileSync(join(root, 'dist/capture.json'), 'utf8'));
    assert.equal(golden.requests['base/chunk/own/L2'][0].system, 'synthetic');
    assert.notEqual(golden.sourceDependencyLockSha256, golden.installedDependencyLockSha256);
    assert.match(golden.compiledHarnessSha256, /^[a-f0-9]{64}$/);
    assert.equal(golden.harnessSha256, undefined, 'no unused producer harness claim');
  });
});

it('generator rejects ignored additions and tracked bytes hidden by index flags', () => {
  fixture((root, git) => {
    writeFileSync(join(root, '.git/info/exclude'), 'src/ignored.ts\n'.replace('\\n', '\n'));
    writeFileSync(join(root, 'src/ignored.ts'), 'export const extra = 1;');
    assert.match(capture(root).stderr, /Refusing dirty source worktree/);
    rmSync(join(root, 'src/ignored.ts'));
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      git('update-index', '--' + flag, 'src/product.ts');
      writeFileSync(join(root, 'src/product.ts'), 'export const value = 2;');
      assert.match(capture(root).stderr, /Refusing dirty source worktree/);
      writeFileSync(join(root, 'src/product.ts'), 'export const value = 1;\n');
      git('update-index', '--no-' + flag, 'src/product.ts');
    }
  });
});
