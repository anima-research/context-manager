# context-manager/tools

Operator tooling for chronicle/CM stores and agent debug logs. Kept **in this
repo** (not a scattered scripts dir) so the tools travel with the schema they
read and deploy via the same `git pull` every agent already does — the fix for
"offline rig drifts from live config/schema" (the recurring failure mode behind
several 2026-08 incidents).

All read-only unless noted. Store tools need the agent STOPPED (chronicle is
single-writer) or a copy. They resolve `@animalabs/chronicle` from this repo's
own `node_modules`, so run them from a tree with the stack installed.

| tool | what | mutates |
|------|------|---------|
| `llm-calls-query` | summarize `llm-calls.*.jsonl(.gz)` — group by kind/stop/category, `--refusals`, `--since/--boot`, streams multi-GB files | no |
| `tree-doctor.mjs` | audit the autobiographical summary tree for the non-nested / double-representation defect the kv-control picker only warns about tersely; names the overlapping nodes; exit 2 on conflicts (so a repair verifies against it) | no |
| `quarantine.mjs` | inspect (and `--clear`) the compression quarantine via the strategy's **own** `getCompressionQuarantineStatus()` — never re-derives the ledger projection (the bug that made the old inspect report 0 while ~80 were quarantined) | `--clear` only |

Examples:

    node tools/llm-calls-query ~/mythos-cm/data --boot --group kind,stop,category
    node tools/tree-doctor.mjs  ~/mythos-cm/data/sessions/<id>
    node tools/quarantine.mjs   ~/mythos-cm/data/sessions/<id>            # status
    node tools/quarantine.mjs   ~/mythos-cm/data/sessions/<id> --clear    # drain (agent stopped)
