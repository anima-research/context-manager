#!/usr/bin/env bash
# Runs every compiled test file, dist/test/**/*.test.js, in a node process of
# its own, one after another; run it after npm run build, from the
# repository's root, as CI and the release workflow do. That is what node
# --test runs in each child, but here nothing between the file and the log
# reads its output. CI's Node 22 legs and the release workflow's test job run
# the suite this way. On Node 22, node --test's parent can misread the results
# a child sends it, and then loop forever, when a read of the child's output
# ends right after a frame's four-byte length and that length's last byte is
# 0xff (nodejs/node#62693). nodejs/node#62704 fixed that, first in 24.18.0 and
# 26.2.0, but no 22.x release has the fix, as of 22.23.4 (2026-10-21).
#
# Every compiled test file runs, so these jobs can run more files than npm
# test's globs reach, never fewer. A failing find or an empty list fails the
# run. A file that fails is named with node's exit status, and the files after
# it still run. test/test-each-file-script.test.ts checks each of these.
set -euo pipefail

# node --test gives its children this variable, which makes a test file write
# frames for a parent instead of the report it prints when run on its own.
# Each file here prints that report, whoever runs the script.
unset NODE_TEST_CONTEXT

if ! files=$(find dist/test -name '*.test.js' -type f | LC_ALL=C sort); then
  echo "::error::Listing the compiled test files under dist/test failed; its error is in this step's log"
  exit 1
fi
if [ -z "$files" ]; then
  echo "::error::No compiled test files under dist/test: this script runs after npm run build, from the repository root"
  exit 1
fi

failed=0
while IFS= read -r file; do
  # Each line printed here starts a line of its own, since a file can leave
  # its last line unfinished, as one killed mid-write does.
  printf '\n== %s\n' "$file"
  node "$file" </dev/null || { status=$?; failed=1; printf '\n::error::%s failed (exit %s)\n' "$file" "$status"; }
done <<< "$files"
exit "$failed"
