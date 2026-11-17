// Offline producer. The explicit source root must be a clean Git worktree root,
// built with the synthetic harness. No upward-discovered archive provenance.
import { readFileSync, writeFileSync, realpathSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mainScenarios, scenarioKey, goldenReminders } from '../dist/test/compression-main-scenarios.js';

const [sourceRoot, output] = process.argv.slice(2);
if (!sourceRoot || !output) throw new Error('usage: node scripts/generate-compression-main-golden.mjs <source-worktree-root> <output.json>');
const root = realpathSync(resolve(sourceRoot));
// Ignore caller Git overrides: all provenance commands must inspect this root.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
gitEnv.GIT_CONFIG_NOSYSTEM = '1';
gitEnv.GIT_CONFIG_GLOBAL = '/dev/null';
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv, timeout: 10000 }).trim();
if (realpathSync(git('rev-parse', '--show-toplevel')) !== root) {
  throw new Error('Source root must equal its Git top-level; archives/build subdirectories are not source worktrees');
}
const source = git('rev-parse', 'HEAD');
const sourceTree = git('rev-parse', 'HEAD^{tree}');
// Compare bytes to HEAD independently of index stat/assume-unchanged flags.
function sourceFilesChanged() {
  return git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'src', 'test', 'scripts', 'tsconfig.json', 'package.json', 'package-lock.json')
    .split('\n').filter(Boolean).some(path => {
      try { return git('hash-object', '--', path) !== git('rev-parse', 'HEAD:' + path); }
      catch { return true; }
    });
}

// Untracked test-only harness ports are allowed on legacy trees. Tracked edits
// anywhere, or untracked product source, cannot claim clean-commit provenance.
if (git('status', '--porcelain', '--untracked-files=no') ||
    git('ls-files', '--others', '--', 'src') || sourceFilesChanged()) {
  throw new Error('Refusing dirty source worktree; commit intentional changes before capture');
}
const producerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
// Never execute pre-existing dist output. Build with the compiler we record.
mkdirSync(`${root}/dist`, { recursive: true });
const build = mkdtempSync(`${root}/dist/golden-build-`);
try {
  const compiler = realpathSync(`${root}/node_modules/typescript/bin/tsc`);
  execFileSync(process.execPath, [compiler, '--project', `${root}/tsconfig.json`,
    '--outDir', build, '--incremental', 'false', '--composite', 'false'],
    { cwd: root, timeout: 120000, stdio: 'pipe' });
  const { run, Probe, KnowledgeProbe } = await import(pathToFileURL(`${build}/test/compression-instructions-harness.js`).href);
  const requests = {};
  for (const s of mainScenarios) {
    requests[scenarioKey(s)] = await run(s.mode, s.pin, undefined,
      s.variant === 'reminders' ? goldenReminders : {}, s.variant === 'knowledge' ? KnowledgeProbe : Probe, s.level);
  }
  // Do not publish a clean-source label if source changed during the capture.
  if (git('rev-parse', 'HEAD') !== source || git('status', '--porcelain', '--untracked-files=no') ||
      git('ls-files', '--others', '--', 'src') || sourceFilesChanged()) {
    throw new Error('Source worktree changed during capture');
  }
  writeFileSync(output, JSON.stringify({
    source,
    sourceTree,
    node: process.version,
    compiler: JSON.parse(readFileSync(`${root}/node_modules/typescript/package.json`, 'utf8')).version,
    sourceDependencyLockSha256: sha256(`${root}/package-lock.json`),
    installedDependencyLockSha256: sha256(`${root}/node_modules/.package-lock.json`),
    scenarioModuleSha256: sha256(`${producerRoot}/dist/test/compression-main-scenarios.js`),
    compiledHarnessSha256: sha256(`${build}/test/compression-instructions-harness.js`),
    mainHarnessSha256: sha256(`${root}/test/compression-instructions-harness.ts`),
    requests,
  }, (_key, value) => value === undefined ? { $cmGoldenUndefined: true } : value, 2) + '\n');
  console.log(`Wrote ${Object.keys(requests).length} request sets from ${source} (tree ${sourceTree}) to ${output}`);

} finally { rmSync(build, { recursive: true, force: true }); }
