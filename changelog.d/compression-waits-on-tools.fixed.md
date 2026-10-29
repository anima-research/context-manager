- `AutobiographicalStrategy` no longer loses a chunk whose compression it
  defers because the host hasn't declared its tool definitions. The chunk
  stays queued where it was, and ticks after the host declares them compress
  the waiting chunks in order, where before they waited for the next rebuild
  of the chunks (a new message, or a compile). Every later chunk whose request
  replays the deferred one waits the same way.
- On a Fable- or Mythos-family compression model with no tools declared, a
  merge now waits for the host's tools as a chunk already did, rather than
  going out without them. The head merge reads as waiting once a tick has
  asked about it, and the merges behind it, and chunks the speculative cap
  holds behind it, wait with it. A head merge that makes no call (a missing or
  parented source, one a summary hold or quarantine record keeps, a crossed
  merge) is still dropped when a tick asks about it, so a loop that ticks
  until ready drops it too; one whose sources change after a tick found it
  waiting reads as waiting until the next rebuild or the tools.
- `scripts/drain-autobiographical.ts` no longer reports a store drained while
  work waits on tools: it stops with `stopped: "waiting-on-tools"` and says to
  run it again with `--tools-log`. `scripts/migrate-llr.ts` says its
  compression stopped, naming what waits, rather than that it completed.
