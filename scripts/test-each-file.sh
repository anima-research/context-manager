#!/usr/bin/env bash
# Runs every compiled test file, dist/test/**/*.test.js, in a node process of
# its own; run it after npm run build, from the repository's
# root, as CI and the release workflow do. That is what node --test runs in
# each child, but here nothing between the file and the log reads its output.
# CI's build-and-test job and the release workflow's test job run the suite
# this way. On Node 22, node --test's parent can misread the results a child
# sends it, and then loop forever, when a read of the child's output ends right
# after a frame's four-byte length and that length's last byte is 0xff
# (nodejs/node#62693). nodejs/node#62704 fixed that, first in 24.18.0 and
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

jobs=${TEST_EACH_FILE_JOBS:-$(node -p 'require("node:os").availableParallelism()')}
case "$jobs" in
  ''|*[!0-9]*|0*)
    echo "::error::TEST_EACH_FILE_JOBS must be a whole number above 0, with no leading zero, not '$jobs'"
    exit 1
    ;;
esac

if ! files=$(find dist/test -name '*.test.js' -type f | LC_ALL=C sort); then
  echo "::error::Listing the compiled test files under dist/test failed; its error is in this step's log"
  exit 1
fi
if [ -z "$files" ]; then
  echo "::error::No compiled test files under dist/test: this script runs after npm run build, from the repository root"
  exit 1
fi
count=0
while IFS= read -r file; do
  paths[count]=$file
  count=$((count + 1))
done <<< "$files"
echo "Running $count test files, $jobs at a time"

out=$(mktemp -d)
runner=
cleanup() {
  if [ -n "$runner" ]; then kill "$runner" 2>/dev/null || true; fi
  rm -rf "$out"
}
trap cleanup EXIT

for ((i = 0; i < count; i++)); do printf '%s\0%s\0' "$i" "${paths[i]}"; done \
  | OUT="$out" xargs -0 -n 2 -P "$jobs" bash -c '
      exec >"$OUT/$1.log" 2>&1
      node "$2" </dev/null && status=0 || status=$?
      printf "%s\n" "$status" >"$OUT/$1.part" && mv "$OUT/$1.part" "$OUT/$1.status"
    ' test-each-file &
runner=$!

failed=0
for ((next = 0; next < count; next++)); do
  file=${paths[next]}
  log=$out/$next.log
  # Each line printed here starts a line of its own, since a file can leave
  # its last line unfinished, as one killed mid-write does.
  printf '\n== %s\n' "$file"
  shown=0
  while :; do
    ended=0
    if [ -e "$out/$next.status" ] || ! kill -0 "$runner" 2>/dev/null; then ended=1; fi
    if [ -e "$log" ]; then
      size=$(($(wc -c <"$log")))
      if [ "$size" -gt "$shown" ]; then
        head -c "$size" "$log" | tail -c "$((size - shown))"
        shown=$size
      fi
    fi
    if [ "$ended" = 1 ]; then break; fi
    sleep 0.1
  done
  if [ -e "$out/$next.status" ]; then
    status=$(cat "$out/$next.status")
    if [ "$status" != 0 ]; then
      failed=1
      printf '\n::error::%s failed (exit %s)\n' "$file" "$status"
    fi
  else
    failed=1
    printf '\n::error::%s gave no exit status: the runner ended before it did\n' "$file"
  fi
done
wait "$runner" || true
runner=
exit "$failed"
