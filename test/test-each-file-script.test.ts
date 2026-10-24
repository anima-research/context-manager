// Black-box coverage of scripts/test-each-file.sh, which CI's Node 22 legs and
// the release workflow's test job run in place of npm test. Each case runs the
// real script in a throwaway directory whose dist/test holds fixture files, is
// empty, or is missing, and checks its exit status, the verdict those jobs act
// on: the release publishes only if it is 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/test-each-file.sh", import.meta.url),
);

const PASSES = [
  "import { test } from 'node:test';",
  "test('passes', () => {});",
].join("\n");
const FAILS = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('fails', () => { assert.equal(1, 2); });",
].join("\n");
const THROWS_AFTER_PASSING = [
  "import { test } from 'node:test';",
  "test('passes', () => {});",
  "setTimeout(() => { throw new Error('thrown after the test passed'); }, 50);",
].join("\n");
// Killed mid-line, as the OOM killer can leave a process's output.
const KILLED_MID_LINE = [
  "import { writeSync } from 'node:fs';",
  "writeSync(1, 'output cut off mid-line');",
  "process.kill(process.pid, 'SIGKILL');",
].join("\n");
// Ends with its last line unfinished, and passes.
const ENDS_MID_LINE = [
  "import { writeSync } from 'node:fs';",
  "writeSync(1, 'output with no newline at its end');",
].join("\n");
const READS_STDIN = [
  "import { test } from 'node:test';",
  "test('reads stdin to its end', async () => {",
  "  let bytes = 0;",
  "  for await (const chunk of process.stdin) bytes += chunk.length;",
  "  console.log(`read ${bytes} bytes of stdin`);",
  "});",
].join("\n");
/** Not a test file: run, as JavaScript or as stripped TypeScript, it would
 *  end the run red. */
const NOT_A_TEST = "process.exit(3);";

interface Run {
  status: number | null;
  /** stdout, then stderr and how the script ended, for assertion messages. */
  log: string;
  stdout: string;
  /** The files the script said it started, from its `== <file>` lines. */
  started: string[];
  /** The test files that ran, from the line each prints first. */
  ran: string[];
  errors: string[];
}

/**
 * Runs the script in a fresh directory holding `files` (path to text), with
 * an empty dist/test when `files` is empty, and none when it is undefined.
 * Each `*.test.js` fixture first prints `ran <path>`, synchronously, so the
 * one that kills itself has said so before it dies. If NODE_TEST_CONTEXT
 * reaches a fixture, it prints `context <value>` too.
 */
function runScript(files: Record<string, string> | undefined): Run {
  const dir = mkdtempSync(join(tmpdir(), "test-each-file-"));
  try {
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
    if (files) {
      mkdirSync(join(dir, "dist", "test"), { recursive: true });
      // For three files or more, written neither in the order the script
      // must run them nor in its reverse, so a filesystem that lists files
      // as they were written, or in reverse, can't hide a missing sort.
      const entries = Object.entries(files);
      const order = [...entries.filter((_, i) => i % 2 === 1), ...entries.filter((_, i) => i % 2 === 0)];
      for (const [path, text] of order) {
        const marker = path.endsWith(".test.js")
          ? [
            "import { writeSync as __mark } from 'node:fs';",
            `__mark(1, ${JSON.stringify(`ran ${path}\n`)});`,
            "if (process.env.NODE_TEST_CONTEXT !== undefined) __mark(1, `context ${process.env.NODE_TEST_CONTEXT}\\n`);",
            "",
          ].join("\n")
          : "";
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), `${marker}${text}\n`);
      }
    }
    const result = spawnSync("bash", [SCRIPT], {
      cwd: dir,
      env: {
        ...process.env,
        // The fixtures run on the node this test runs on.
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
        // node --test gives its children this, and the script must clear it:
        // set here, every run with fixtures checks that, on every leg.
        NODE_TEST_CONTEXT: "child-v8",
      },
      encoding: "utf8",
      // If bash itself hangs, its case fails here rather than at the job's
      // limit. A fixture can't hang: each ends on its own.
      timeout: 120_000,
    });
    const stdout = result.stdout ?? "";
    const lines = stdout.split("\n");
    return {
      status: result.status,
      log: [
        stdout,
        `--- stderr ---\n${result.stderr ?? ""}`,
        `--- status ${result.status}, signal ${result.signal}${result.error ? `, ${result.error.message}` : ""}`,
      ].join("\n"),
      stdout,
      started: lines.filter((line) => line.startsWith("== ")).map((line) => line.slice(3)),
      ran: lines.filter((line) => line.startsWith("ran ")).map((line) => line.slice(4)),
      errors: lines.filter((line) => line.startsWith("::error::")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Each of `files` ran, in order, as a plain node process: one node --test
 *  would have given NODE_TEST_CONTEXT, and the script must clear it. */
function assertRanPlain(run: Run, files: string[]): void {
  assert.deepEqual(run.started, files, run.log);
  assert.deepEqual(run.ran, files, run.log);
  assert.doesNotMatch(run.stdout, /context /, run.log);
}

const notOnWindows = { skip: process.platform === "win32" };

test("failing files end the run red, each named with its exit status, and the files after them still run", notOnWindows, () => {
  const run = runScript({
    "dist/test/a-passes.test.js": PASSES,
    "dist/test/b-fails.test.js": FAILS,
    "dist/test/c-throws-after-passing.test.js": THROWS_AFTER_PASSING,
    "dist/test/d-killed-mid-line.test.js": KILLED_MID_LINE,
    "dist/test/e-passes.test.js": PASSES,
  });
  assert.equal(run.status, 1, run.log);
  assertRanPlain(run, [
    "dist/test/a-passes.test.js",
    "dist/test/b-fails.test.js",
    "dist/test/c-throws-after-passing.test.js",
    "dist/test/d-killed-mid-line.test.js",
    "dist/test/e-passes.test.js",
  ]);
  assert.deepEqual(run.errors, [
    "::error::dist/test/b-fails.test.js failed (exit 1)",
    "::error::dist/test/c-throws-after-passing.test.js failed (exit 1)",
    // 128 + SIGKILL's 9, as bash reports a process the OOM killer ends.
    "::error::dist/test/d-killed-mid-line.test.js failed (exit 137)",
  ], run.log);
});

test("a file a signal ends is enough on its own to end the run red", notOnWindows, () => {
  const run = runScript({
    "dist/test/a-passes.test.js": PASSES,
    "dist/test/b-killed-mid-line.test.js": KILLED_MID_LINE,
    "dist/test/c-passes.test.js": PASSES,
  });
  assert.equal(run.status, 1, run.log);
  assertRanPlain(run, [
    "dist/test/a-passes.test.js",
    "dist/test/b-killed-mid-line.test.js",
    "dist/test/c-passes.test.js",
  ]);
  assert.deepEqual(run.errors, ["::error::dist/test/b-killed-mid-line.test.js failed (exit 137)"], run.log);
});

test("only regular *.test.js files under dist/test run, nested ones included, and passing ones end the run green", notOnWindows, () => {
  const run = runScript({
    "dist/outside.test.js": NOT_A_TEST,
    "dist/test/a-passes.test.js": PASSES,
    "dist/test/adaptive/b-passes.test.js": PASSES,
    "dist/test/c-ends-mid-line.test.js": ENDS_MID_LINE,
    "dist/test/dir.test.js/d-passes.test.js": PASSES,
    "dist/test/helpers/not-a-test.js": NOT_A_TEST,
    "dist/test/helpers/types.test.d.ts": NOT_A_TEST,
    "dist/test/nested/deeper/e-passes.test.js": PASSES,
  });
  assert.equal(run.status, 0, run.log);
  assertRanPlain(run, [
    "dist/test/a-passes.test.js",
    "dist/test/adaptive/b-passes.test.js",
    "dist/test/c-ends-mid-line.test.js",
    "dist/test/dir.test.js/d-passes.test.js",
    "dist/test/nested/deeper/e-passes.test.js",
  ]);
  assert.deepEqual(run.errors, [], run.log);
});

test("a path with a space runs as it is, and a file that reads stdin leaves the list alone", notOnWindows, () => {
  const run = runScript({
    "dist/test/a-reads-stdin.test.js": READS_STDIN,
    "dist/test/b has spaces.test.js": PASSES,
    "dist/test/c-passes.test.js": PASSES,
  });
  assert.equal(run.status, 0, run.log);
  assertRanPlain(run, [
    "dist/test/a-reads-stdin.test.js",
    "dist/test/b has spaces.test.js",
    "dist/test/c-passes.test.js",
  ]);
  assert.match(run.stdout, /read 0 bytes of stdin/, run.log);
});

test("an empty dist/test ends the run red", notOnWindows, () => {
  const run = runScript({});
  assert.equal(run.status, 1, run.log);
  assert.deepEqual(run.started, [], run.log);
  assert.deepEqual(run.errors, [
    "::error::No compiled test files under dist/test: this script runs after npm run build, from the repository root",
  ], run.log);
});

test("a listing that fails, here for want of dist/test, ends the run red", notOnWindows, () => {
  const run = runScript(undefined);
  assert.equal(run.status, 1, run.log);
  assert.deepEqual(run.started, [], run.log);
  assert.deepEqual(run.errors, [
    "::error::Listing the compiled test files under dist/test failed; its error is in this step's log",
  ], run.log);
  // find's own error reaches the log the annotation points to.
  assert.match(run.log, /find: .*dist\/test/, run.log);
});
