/**
 * Inspect a chronicle store's autobiographical memory: its messages, the
 * summary tree and lineage, and the adaptive resolutions, written as files
 * under --output with an overview on stdout.
 *
 * Usage:
 *   node dist/scripts/inspect-store.js <store-path> [--namespace <ns>] [--message-slot isolated|shared] [--output <dir>] [--sample-compile <tokens>]
 *
 * The invocation is checked whole before anything is opened: the store path
 * comes first, then only the options above, each at most once and each with
 * its value. Anything else (an unknown or misspelled option, a stray
 * argument, an option given twice, an option without its value) is refused,
 * never read around, so a malformed selection can't fall back to a default.
 *
 * `--namespace` is the strategy namespace (default "default"; residents use
 * e.g. agents/<Name>). `--ns` is accepted as its old name.
 *
 * `--message-slot` says where the resident keeps its messages: `isolated`
 * for a ContextManager opened with `isolate: true` (the slot
 * `{namespace}/messages`), `shared` for one opened without it (the slot
 * `messages`). The store doesn't record which, and a registered slot is not
 * proof the resident uses it: an isolated slot outlives a switch to shared
 * messages. So a chosen slot must be registered; without a choice the sole
 * registered slot is read, and when both are registered nothing is
 * inspected until one is chosen. The overview, messages.md and the sample
 * name the slot they read.
 *
 * Mutation-free strategy inspection: the store is opened with JsStore.open
 * (it is never created), the strategy's persisted state is read as stored,
 * and without --sample-compile no strategy or ContextManager is constructed.
 * So inspection creates no strategy, chunk or namespace state and registers
 * no strategy state; a namespace without strategy state is reported and
 * nothing else is done. Messages are read through a MessageStore, whose
 * construction re-registers the message slot's history indexes,
 * idempotently, as every MessageStore construction does, rebuilding any that
 * are missing or stale; for an isolated slot those are the namespace's own.
 *
 * Summaries and resolutions are read as stored, before the strategy's
 * load-time repair (which drops empty summaries, dedupes ids and clears
 * dangling parents), so a count can include entries a resident drops when it
 * loads. A state that holds something other than what the strategy writes
 * (a summaries state that isn't a list, a resolutions state that isn't a map
 * of numbers) is reported on stderr and in the overview, never read as empty.
 *
 * Inspection is mutation-free logically, not byte-for-byte. Chronicle (as of
 * 0.4.0) has no read-only open: opening takes the store's lock, so run this on
 * a stopped resident's store or on a copy; a store whose lock is held is
 * refused with exit 1. Every close rewrites state.bin,
 * state-indexes.bin (where a rebuilt history index lands) and branches.bin,
 * whose bytes can change even when what they hold doesn't. And when the
 * store wasn't closed cleanly, opening may correct stale branch heads, which
 * the close writes to branches.bin, and truncate a torn tail from
 * records.log; a truncation is reported on stderr, even when the open then
 * fails, since nothing records it afterwards. So to keep a store's files as
 * they were, as forensics during an incident needs, copy the store before
 * inspecting it.
 *
 * `--sample-compile <tokens>` additionally writes one compile at that
 * budget from a live, audit-only open of the same message slot, using this
 * tool's default strategy configuration (not the resident's own, so it is a
 * sample, not a reproduction of the resident's view). That open writes: it
 * registers the namespace's states, re-applies the message slot's
 * registration (its snapshot cadence; the shared slot is store-global),
 * may migrate legacy chunk records, and may rewrite the summaries state as the
 * strategy repairs it on load. Use it on a copy. With no message slot there
 * is no history to compile, so it is refused.
 *
 * Exit codes:
 *   0 = inspected. With no message slot registered and no --sample-compile,
 *       the summaries are inspected and the messages reported as none.
 *   2 = nothing inspected, because the store doesn't settle the selection:
 *       the namespace has no strategy state, a chosen message slot isn't
 *       registered, both slots are registered and none was chosen, or a
 *       sample compile was asked for with no message slot.
 *   1 = a malformed invocation, a store that can't be opened (absent, not a
 *       store, or locked), or a failure after inspection began; outputs
 *       written before such a failure stay where they are.
 */

import { main } from './inspect-store-main.js';

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error('FATAL:', error);
  process.exitCode = 1;
});
