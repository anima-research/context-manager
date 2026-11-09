// Runs as the `version` lifecycle hook (see package.json) of a version
// command such as `npm version`: at that point package.json already carries
// the new version, and files staged here are included in the release commit
// the version command then creates and tags.
//
// Folds the pending fragments in changelog.d/ (one file per change,
// `<slug>.<breaking|added|changed|fixed>.md`) together with anything filed
// directly under the standing `## Unreleased` section into a new
// `## X.Y.Z — YYYY-MM-DD` section, deletes the consumed fragments, and
// leaves a fresh empty `## Unreleased` above it. Refuses to release when
// there is nothing to release, or when the input's shape is ambiguous.
//
// Run any other way, it would release into the version package.json already
// holds and delete the fragments it folded (#198), so it refuses unless its
// environment looks like a version command's `version` hook (see
// checkInvocation in release-changelog-run.mjs). That guards against running
// it by mistake, not on purpose: any process can set those variables.
// `--help` says what it does.
import { ReleaseError, run } from "./release-changelog-run.mjs";

try {
  console.log(run(process.cwd(), process.argv.slice(2), process.env));
} catch (e) {
  if (!(e instanceof ReleaseError)) throw e;
  console.error(`release-changelog: ${e.message}`);
  process.exitCode = 1;
}
