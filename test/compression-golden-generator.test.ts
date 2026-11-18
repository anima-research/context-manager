import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createHash } from 'node:crypto';
import { readCompressionGolden } from './compression-golden-reader.js';

const generator = resolve('scripts/generate-compression-main-golden.mjs');
// Tiny synthetic module isolates provenance/serialization checks from strategy
// runtime. Real modern + legacy request parity is checked separately.
function fixture(check: (root: string, git: (...args: string[]) => string) => void, objectFormat?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-golden-source-')));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', timeout: 10000, env }).trim();
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'dist/test'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(root, '.gitignore'), 'node_modules\ndist/\n');
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
    git('init', '-q', ...(objectFormat ? ['--object-format=' + objectFormat] : []));
    git('add', '.');
    git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic source');
    assert.equal(git('ls-files', '--', 'node_modules'), '');
    assert.equal(git('check-ignore', 'node_modules'), 'node_modules');
    check(root, git);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function capture(root: string, env = process.env) {
  return spawnSync(process.execPath, [generator, root, join(root, 'dist/capture.json')],
    { encoding: 'utf8', timeout: 900000, env });
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
    const restored = readCompressionGolden(join(root, 'dist/capture.json'));
    assert.ok(Object.hasOwn(restored.requests['base/chunk/own/L2']![0]!, 'tools'));
    assert.equal(restored.requests['base/chunk/own/L2']![0]!.tools, undefined);
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
    fixture((root, git) => {
      assert.equal(git('rev-parse', '--show-toplevel'), root);
      const hostileConfig = join(root, 'dist/hostile.gitconfig');
      writeFileSync(hostileConfig, '[invalid config');
      const result = capture(root, { ...process.env, GIT_CONFIG_GLOBAL: hostileConfig });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readCompressionGolden(join(root, 'dist/capture.json')).source, git('rev-parse', 'HEAD'));
    });
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
    for (const [key, path] of [['sourceDependencyLockSha256', 'package-lock.json'],
      ['installedDependencyLockSha256', 'node_modules/.package-lock.json']] as const) {
      assert.equal(golden[key], createHash('sha256').update(readFileSync(join(root, path))).digest('hex'));
    }
    assert.match(golden.compiledHarnessSha256, /^[a-f0-9]{64}$/);
    assert.equal(golden.harnessSha256, undefined, 'no unused producer harness claim');
  });
});

it('generator rejects ignored additions and tracked bytes hidden by index flags', () => {
  fixture((root, git) => {
    writeFileSync(join(root, '.git/info/exclude'), 'src/ignored.ts\n'.replace('\\n', '\n'));
    writeFileSync(join(root, 'src/ignored.ts'), 'export const extra = 1;');
    assert.match(capture(root).stderr, /src\/ignored\.ts/);
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

it('generator rejects untracked helpers and hidden root-level changes', () => {
  fixture((root, git) => {
    writeFileSync(join(root, 'test/helper.ts'), 'export const helper = 1;');
    assert.match(capture(root).stderr, /Refusing dirty source worktree/);
    writeFileSync(join(root, '.git/info/exclude'), 'test/helper.ts\n');
    assert.match(capture(root).stderr, /Refusing dirty source worktree/);
    rmSync(join(root, 'test/helper.ts'));
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      git('update-index', '--' + flag, '.gitignore');
      writeFileSync(join(root, '.gitignore'), 'node_modules\ndist/\nextra\n');
      assert.match(capture(root).stderr, /Refusing dirty source worktree/);
      writeFileSync(join(root, '.gitignore'), 'node_modules\ndist/\n');
      git('update-index', '--no-' + flag, '.gitignore');
    }
  });
});

it('generator hashes raw bytes, symlink text and NUL-delimited filenames', { skip: process.platform === 'win32' }, () => {
  fixture((root, git) => {
    const odd = 'src/café\tline\n.txt';
    writeFileSync(join(root, odd), 'original\n');
    symlinkSync('product.ts', join(root, 'src/link.txt'));
    writeFileSync(join(root, '.gitattributes'), 'src/product.ts filter=restore\n');
    git('add', '.');
    git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'paths and filter');
    const clean = capture(root);
    assert.equal(clean.status, 0, clean.stderr);
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      for (const path of [odd, 'src/link.txt']) {
        git('update-index', '--' + flag, path);
        if (path === odd) writeFileSync(join(root, path), 'changed odd filename\n');
        else {
          rmSync(join(root, path));
          symlinkSync('elsewhere.ts', join(root, path));
        }
        assert.match(capture(root).stderr, /Refusing dirty source worktree/);
        if (path === odd) writeFileSync(join(root, path), 'original\n');
        else {
          rmSync(join(root, path));
          symlinkSync('product.ts', join(root, path));
        }
        git('update-index', '--no-' + flag, path);
      }
    }
    git('config', 'filter.restore.clean', "printf 'export const value = 1;\\n'");
    git('update-index', '--assume-unchanged', 'src/product.ts');
    writeFileSync(join(root, 'src/product.ts'), 'export const value = 2;\n');
    assert.match(capture(root).stderr, /Refusing dirty source worktree/);
  });
});

it('generator reports compiler diagnostics and source inspection errors distinctly', () => {
  fixture((root, git) => {
    writeFileSync(join(root, 'src/product.ts'), 'export const value: number = "invalid";');
    git('add', 'src/product.ts');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'invalid compile');
    const result = capture(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /src\/product\.ts.*error TS2322/);
    git('update-index', '--assume-unchanged', 'src/product.ts');
    rmSync(join(root, 'src/product.ts'));
    assert.match(capture(root).stderr, /Refusing dirty source worktree.*src\/product\.ts/);
    mkdirSync(join(root, 'src/product.ts'));
    const inspection = capture(root);
    assert.notEqual(inspection.status, 0);
    assert.match(inspection.stderr, /Unable to inspect source path.*src\/product\.ts.*EISDIR/);
    assert.match(inspection.stderr, /Check source-path type, permissions and readability/);
  });
});

it('generator rebuilds producer scenarios rather than importing stale producer dist', () => {
  fixture((root, git) => {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/generate-compression-main-golden.mjs'), readFileSync(generator));
    writeFileSync(join(root, 'test/compression-main-scenarios.ts'), readFileSync('test/compression-main-scenarios.ts'));
    const harness = join(root, 'test/compression-instructions-harness.ts');
    writeFileSync(harness, 'export type Mode = string;\n' + readFileSync(harness, 'utf8'));
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic producer');
    writeFileSync(join(root, 'dist/test/compression-main-scenarios.js'), 'throw new Error("STALE SCENARIOS");');
    const result = spawnSync(process.execPath, [join(root, 'scripts/generate-compression-main-golden.mjs'),
      root, join(root, 'dist/capture.json')], { encoding: 'utf8', timeout: 900000 });
    assert.equal(result.status, 0, result.stderr);
    const golden = JSON.parse(readFileSync(join(root, 'dist/capture.json'), 'utf8'));
    assert.equal(Object.keys(golden.requests).length, 93);
    assert.notEqual(golden.scenarioModuleSha256, createHash('sha256')
      .update(readFileSync(join(root, 'dist/test/compression-main-scenarios.js'))).digest('hex'));
  });
});

it('generator names staged-only changes and executable-bit changes in dirty refusals', () => {
  fixture((root, git) => {
    writeFileSync(join(root, 'src/product.ts'), 'staged change');
    git('add', 'src/product.ts');
    writeFileSync(join(root, 'src/product.ts'), 'export const value = 1;\n');
    assert.match(capture(root).stderr, /Refusing dirty source worktree.*src\/product\.ts/);
    git('reset', '--hard', 'HEAD');
    git('update-index', '--chmod=+x', 'src/product.ts');
    assert.match(capture(root).stderr, /Refusing dirty source worktree.*src\/product\.ts/);
  });
});

it('generator and reader support SHA-256 source IDs from a different caller repository', t => {
  const probe = mkdtempSync(join(tmpdir(), 'cm-sha256-'));
  try {
    const supported = spawnSync('git', ['init', '-q', '--object-format=sha256', probe], { encoding: 'utf8' });
    if (supported.status !== 0) { t.skip('Git does not support SHA-256 repositories: ' + supported.stderr); return; }
  } finally { rmSync(probe, { recursive: true, force: true }); }
  fixture((root) => {
    const result = capture(root);
    assert.equal(result.status, 0, result.stderr);
    const golden = readCompressionGolden(join(root, 'dist/capture.json'));
    assert.equal(golden.source.length, 64);
    assert.equal(golden.sourceTree!.length, 64);
  }, 'sha256');
});

it('generator rebuilds separate producer scenarios, ignoring stale producer dist', () => {
  fixture((producer, git) => {
    mkdirSync(join(producer, 'scripts'));
    writeFileSync(join(producer, 'scripts/generate-compression-main-golden.mjs'), readFileSync(generator));
    writeFileSync(join(producer, 'test/compression-main-scenarios.ts'), readFileSync('test/compression-main-scenarios.ts'));
    const harness = join(producer, 'test/compression-instructions-harness.ts');
    writeFileSync(harness, 'export type Mode = string;\n' + readFileSync(harness, 'utf8'));
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'separate producer');
    writeFileSync(join(producer, 'dist/test/compression-main-scenarios.js'), 'throw new Error("STALE SEPARATE PRODUCER");');
    fixture(source => {
      const result = spawnSync(process.execPath, [join(producer, 'scripts/generate-compression-main-golden.mjs'),
        source, join(source, 'dist/capture.json')], { encoding: 'utf8', timeout: 900000 });
      assert.equal(result.status, 0, result.stderr);
      const golden = readCompressionGolden(join(source, 'dist/capture.json'));
      assert.equal(Object.keys(golden.requests).length, 93);
    });
  });
});

it('generator refuses a symlink blob materialized as an ordinary file', () => {
  fixture((root, git) => {
    // Simulate core.symlinks=false without requiring OS symlink privileges.
    writeFileSync(join(root, 'src/link.ts'), 'product.ts');
    git('add', 'src/link.ts');
    const blob = git('rev-parse', ':src/link.ts');
    git('update-index', '--cacheinfo', '120000,' + blob + ',src/link.ts');
    git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'tracked symlink');
    git('config', 'core.symlinks', 'false');
    assert.equal(git('status', '--porcelain'), '', 'Git treats the emulated symlink as clean');
    const result = capture(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing dirty source worktree/);
    assert.match(result.stderr, /src\/link.ts/);
  });
});
