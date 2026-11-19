/**
 * Install or edit an autobiographical memory whose text was written outside
 * the strategy's own compression calls, for work the provider refuses on
 * every attempt. For a STOPPED resident's store. The tree's shape stays the
 * strategy's: the operator supplies the text of work the strategy would do
 * itself, never a grouping of their own.
 *
 * Usage:
 *   node dist/scripts/external-memory.js export-request <store-path> --namespace <ns> [--message-slot isolated|shared]
 *       (--level <n> | --chunk <chunk-record-id>) --out <file> --model <model> --participant <name>
 *       [--recipe <recipe.json>] [--tools-log <log>]
 *   node dist/scripts/external-memory.js import <store-path> --namespace <ns> [--message-slot isolated|shared]
 *       --descriptor <file> --body-file <file> --by <who> [--note <text>] [--apply]
 *   node dist/scripts/external-memory.js edit <store-path> --namespace <ns> [--message-slot isolated|shared]
 *       --id <summary-id> --body-file <file> --by <who> [--note <text>] [--apply]
 *
 * The invocation is checked whole before anything is opened, as
 * inspect-store's is: the subcommand, the store path, then only that
 * subcommand's options, each at most once and each with its value. The files
 * it names are read before the store is opened too. `--message-slot` is
 * settled as inspect-store settles it. `import` and `edit` are DRY RUNS
 * without `--apply`.
 *
 * export-request writes one JSON file to --out and nothing to the store's
 * memory:
 *   - `workItem`: the work, as `import` requires it back (level, ordered
 *     source ids, source level, the message id range, and for an L1 its
 *     chunk record);
 *   - `request`: the request the strategy would send for it now, as it hands
 *     it to membrane (system, messages by participant, tools, model
 *     settings), to give to whatever writes the text instead;
 *   - `settings`: the strategy options, system prompt and tool definitions
 *     the request was built under, which `import` opens the store with.
 *   `--level <n>` is the next merge into L<n>, the first of: the group of
 *   the oldest merge-quarantine record at that level that holds its sources;
 *   the first queued merge into it that would still run; the group the merge
 *   check would queue now. `--chunk <id>` is the L1 of a chunk record no L1
 *   covers yet, quarantined or not. The request is the resident's only under
 *   its settings: --model and --participant, --recipe for its strategy
 *   options and system prompt, --tools-log for its tool definitions, all as
 *   drain-autobiographical reads them.
 *
 * import installs the text of --body-file as the summary of the work in
 * --descriptor (the file export-request wrote). It is refused unless the
 * strategy, under the same settings, would do that same work now. The text
 * takes the place of the provider's answer, so the summary is written as a
 * native one is, its sources parented, its chunk record marked and the
 * quarantine of its chunk or merge paid off, and the merge check runs after
 * it as after any summary. It carries no reasoning, and `external`
 * ({ by, at, note }) records who supplied it.
 *
 * edit replaces the text of one summary by id: lineage untouched, tokens
 * stamped from the new text, the verbatim response blocks dropped, `external`
 * set. It prints the old text's sha256 and length, and the summaries merged
 * over the old text, which it leaves as they are. The store's history keeps
 * the old text: the line printed after an applied edit names the sequence
 * to read the summaries state at (chronicle's getStateJsonAt).
 *
 * The store is opened audit-only (no frontier chunking), under a lock, and
 * the open still writes what any audit-only open does (see `auditOnly`); a
 * dry run writes nothing else. Back the store up before --apply.
 *
 * Exit codes: 0 = done (or a dry run that would be); 2 = the store doesn't
 * settle the namespace or its message slot; 1 = a malformed invocation, an
 * unreadable file or store, or work refused, with the reason on stderr.
 */

import { main } from './external-memory-main.js';

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error('FATAL:', error);
  process.exitCode = 1;
});
