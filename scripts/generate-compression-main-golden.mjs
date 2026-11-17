// Offline producer. The explicit source root must be a clean Git worktree root,
// built with the synthetic harness. No upward-discovered archive provenance.
import { readFileSync, writeFileSync, realpathSync, mkdtempSync, mkdirSync, rmSync, lstatSync, readlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [sourceRoot, output] = process.argv.slice(2);
if (!sourceRoot || !output) throw new Error('usage: node scripts/generate-compression-main-golden.mjs <source-worktree-root> <output.json>');
const root = realpathSync(resolve(sourceRoot));
// Ignore caller Git overrides: all provenance commands must inspect this root.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
gitEnv.GIT_CONFIG_NOSYSTEM = '1';
gitEnv.GIT_CONFIG_GLOBAL = '/dev/null';
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv, timeout: 10000 }).replace(/\n$/, '');
if (realpathSync(git('rev-parse', '--show-toplevel')) !== root) {
  throw new Error('Source root must equal its Git top-level; archives/build subdirectories are not source worktrees');
}
const source = git('rev-parse', 'HEAD');
const sourceTree = git('rev-parse', 'HEAD^{tree}');
// Compare bytes to HEAD independently of index stat/assume-unchanged flags.
function sourceFilesChanged() {
  const paths = git('ls-tree', '-rz', '--name-only', 'HEAD').split('\0').filter(Boolean);
  return paths.filter(path => {
    try {
      const full = resolve(root, path);
      const bytes = lstatSync(full).isSymbolicLink() ? readlinkSync(full, { encoding: 'buffer' }) : readFileSync(full);
      const hash = execFileSync('git', ['-C', root, 'hash-object', '--stdin', '--no-filters'],
        { input: bytes, encoding: 'utf8', env: gitEnv, timeout: 10000 }).trim();
      return hash !== git('rev-parse', 'HEAD:' + path);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw new Error(`Unable to inspect source path ${JSON.stringify(path)}`);
    }
  });
}
function untrackedSource() {
  const paths = git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
  paths.push(...git('ls-files', '-z', '--others', '--', 'src', 'test', 'scripts').split('\0').filter(Boolean));
  return [...new Set(paths)].filter(path => path !== 'test/compression-instructions-harness.ts');
}
// Permit only the legacy harness port among non-ignored untracked files.
const statusPaths = [...git('diff', '--name-only', '-z', 'HEAD').split('\0'),
  ...git('diff', '--cached', '--name-only', '-z', 'HEAD').split('\0')].filter(Boolean);
const changedPaths = [...new Set([...sourceFilesChanged(), ...untrackedSource(), ...statusPaths])];
if (git('status', '--porcelain', '--untracked-files=no') || changedPaths.length) {
  throw new Error(`Refusing dirty source worktree; restore/remove unintended files, clear index flags, or commit intentional changes. Paths: ${JSON.stringify(changedPaths.slice(0, 10)).slice(0, 2000)}`);
}
const producerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
// Rebuild source product/harness output with the compiler we record.
// Rebuild the producer scenarios too: incremental producer dist is not evidence.
mkdirSync(`${root}/dist`, { recursive: true });
const build = mkdtempSync(`${root}/dist/golden-build-`);
mkdirSync(`${producerRoot}/dist`, { recursive: true });
const scenarioBuild = root === producerRoot ? build : mkdtempSync(`${producerRoot}/dist/golden-scenarios-`);
try {
  const compiler = realpathSync(`${root}/node_modules/typescript/bin/tsc`);
  execFileSync(process.execPath, [compiler, '--project', `${root}/tsconfig.json`,
    '--outDir', build, '--incremental', 'false', '--composite', 'false'],
    { cwd: root, timeout: 120000, stdio: ['ignore', 'inherit', 'inherit'] });
  if (scenarioBuild !== build) {
    execFileSync(process.execPath, [realpathSync(`${producerRoot}/node_modules/typescript/bin/tsc`),
      '--project', `${producerRoot}/tsconfig.json`, '--outDir', scenarioBuild,
      '--incremental', 'false', '--composite', 'false'],
      { cwd: producerRoot, timeout: 120000, stdio: ['ignore', 'inherit', 'inherit'] });
  }
  const scenarioModule = `${scenarioBuild}/test/compression-main-scenarios.js`;
  const { mainScenarios, scenarioKey, goldenReminders } = await import(pathToFileURL(scenarioModule).href);
  const { run, Probe, KnowledgeProbe } = await import(pathToFileURL(`${build}/test/compression-instructions-harness.js`).href);
  const requests = {};
  for (const s of mainScenarios) {
    requests[scenarioKey(s)] = await run(s.mode, s.pin, undefined,
      s.variant === 'reminders' ? goldenReminders : {}, s.variant === 'knowledge' ? KnowledgeProbe : Probe, s.level);
  }
  // Do not publish a clean-source label if source changed during the capture.
  if (git('rev-parse', 'HEAD') !== source || git('status', '--porcelain', '--untracked-files=no') ||
      untrackedSource().length || sourceFilesChanged().length) {
    throw new Error('Source worktree changed during capture');
  }
  writeFileSync(output, JSON.stringify({
    source,
    sourceTree,
    node: process.version,
    compiler: JSON.parse(readFileSync(`${root}/node_modules/typescript/package.json`, 'utf8')).version,
    sourceDependencyLockSha256: sha256(`${root}/package-lock.json`),
    installedDependencyLockSha256: sha256(`${root}/node_modules/.package-lock.json`),
    scenarioModuleSha256: sha256(scenarioModule),
    compiledHarnessSha256: sha256(`${build}/test/compression-instructions-harness.js`),
    mainHarnessSha256: sha256(`${root}/test/compression-instructions-harness.ts`),
    requests,
  }, (_key, value) => value === undefined ? { $cmGoldenUndefined: true } : value, 2) + '\n');
  console.log(`Wrote ${Object.keys(requests).length} request sets from ${source} (tree ${sourceTree}) to ${output}`);

} finally {
  rmSync(build, { recursive: true, force: true });
  if (scenarioBuild !== build) rmSync(scenarioBuild, { recursive: true, force: true });
}
