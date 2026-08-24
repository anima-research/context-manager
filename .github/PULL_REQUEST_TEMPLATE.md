## Problem

<!-- What is wrong / missing, and for whom. Link the issue if one exists. -->

## Changes

<!-- What this PR does. For cross-repo or stacked work, list companion PRs
     and merge-order guidance ("safe in either order because…"). -->

## Tests

<!-- Evidence, not assertion: paste the numbers.
     e.g. `npm test`: 187 pass / 0 fail — failure count identical to main baseline.
     Tests run from dist/, so `npm run build` first. -->

## Not verified

<!-- Compression behavior is emergent: a strategy change can pass the suite
     and still degrade on a real store. Say whether you compiled against one,
     at what size, and what you did not exercise. "Nothing — verified against
     a 200k-token store" is a fine answer; silence is not. -->

---

- [ ] Changelog fragment added — `changelog.d/<slug>.<breaking|added|changed|fixed>.md`
      (see `changelog.d/README.md`) — or this change is internal-only /
      test-only / docs-only (apply the `no-changelog` label).

<!-- AI-assisted contributions are welcome and normal here — see
     CONTRIBUTING.md for the attribution convention (footer + Co-Authored-By). -->
