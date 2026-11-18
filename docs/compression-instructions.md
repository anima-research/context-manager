# Compression instruction templates

`AutobiographicalStrategy` accepts a JSON-serializable `compressionInstructions`
option. Templates work **without selecting a preset**:

```ts
import { AutobiographicalStrategy } from '@animalabs/context-manager';

const strategy = new AutobiographicalStrategy({
  compressionModel: 'your-configured-model',
  compressionInstructions: {
    participant: 'Participant', // trusted configuration, never inferred from history
    templates: {
      chunk: 'Record what happened to {participant}, attributing other speakers. Target {targetTokens} tokens.',
      transition: 'Summarize the following reference data in at most {targetTokens} tokens.\n{context}',
    },
  },
});
```

Omitting the entire option, using `{}`, or selecting `preset: 'default'`
keeps today's instruction text byte-for-byte. `default` is the only accepted
preset; all other names are rejected. A partial `templates` object
replaces only its named slots; every unspecified slot inherits the current
built-in text. No migration of existing summaries is performed. This instruction-text guarantee
is not a guarantee of identical full requests: L1 and L2 now distinguish constructed recall headers from recall-shaped raw
Context Manager history when separating recall answers.
Consecutive source turns can therefore collapse without the former synthetic
resume turn, even with default settings. This also applies before the L1 opening and throughout L2 raw sources.
Changed request bytes change request hashes and refusal-family identities: old
family outcomes may not be reused, so previously attempted work may incur new
paid calls (until the per-chunk quarantine cap is reached). Ordinary L1
`compress_l1` telemetry also changes: it describes the last dispatched attempt
and counts recalls by construction identity, including pair/envelope overhead.
Default instruction wording is unchanged; affected request bytes and provenance hashes
change. Unaffected requests can retain their identities and reuse matching outcomes.

Family/rung/outcome identity is computed from the prepared plan, before subclass
L1 authoring and carrier stripping. A subclass that changes authoring must version
its `compressionOutcomeNamespace()` result; retaining a stable namespace can reuse
a refusal for different would-be sent bytes. Mint provenance, in contrast, binds
the accepted authored request. This does not provide automatic authored-family
identity.

L1 recall totals in logs are estimates, not provider token measurements.
`prior_summary_token_estimate` is `stored-summary-estimate` normally (stored output
counts can include reasoning), `text-content-estimate` after carrier stripping
(text plus pair/envelope overhead), or `unavailable`. Failed recall projection reads
leave both totals `null` and issue one bounded warning without blocking dispatch.
Empty recall IDs skip the telemetry projection; nonempty retries reuse a lookup
for that compression operation. The remaining full-history lookup is not bounded
or benchmarked here. A branded host withdrawal is not evidence of dispatch, so it
leaves the preceding sent snapshot intact (or emits no request receipt if none
was sent). With logging enabled, a deferral, withdrawal, or error ending an operation
before any dispatch instead emits `compression:no-dispatch` for `compress_l1`, with `dispatched: false`, a
`reason` of `deferral`, `withdrawal`, or `error`, and a bounded `detail`. It has
no request, message, system, or response payload and does not claim a send.
Cancellation of an already-out call retains that call's snapshot.

## Slots and placeholders

| Slot | Where it is used | Available placeholders |
| --- | --- | --- |
| `opening` | L1 record marker, including split pieces; coordinate with `chunk` (the built-in chunk refers back to this notification) | `participant` |
| `chunk` | Ordinary/mixed L1 and split pieces | `participant`, `targetTokens` |
| `witnessedChunk` | Non-reading wholly inherited L1, and inherited split pieces | `participant`, `targetTokens` |
| `readingChunk` | L1 portion of a sharded body whose total tokens are at least twice the chunk’s tokens, even wholly inherited | `participant`, `targetTokens`, `totalTokens` |
| `merge` | Ordinary/mixed consolidation | `participant`, `targetTokens`, `sourceLevelShown`, `targetLevel` |
| `witnessedMerge` | Non-reading consolidation with every source witnessed | same as `merge` |
| `readingMerge` | Consolidation of portions of one larger body, even fully witnessed | same as `merge`, plus `totalTokens` |
| `transition` | `generateTransitionSummary` | `participant`, `targetTokens`, `context` |

Use single braces, for example `{targetTokens}`. Braces are reserved for
placeholders; there is no escaping, expression syntax, evaluation, callback,
or recursive substitution. Numeric values come from request construction;
`participant` is the explicitly configured string, required only when referenced
by a custom template. It is never inferred from history or `summaryParticipant`
and does not change message ownership. Repeated placeholders are replaced in
one pass.

`targetTokens` is the requested summary target; for `transition` it is 1500,
which is also the hard output cap (`maxTokens`), not a promise of complete output.
`totalTokens` is the token count of the larger sharded body.
`sourceLevelShown` is the numeric level of the material actually shown: **0 means
raw messages**, not “L0 memories”; positive values mean summaries at that level.
For heterogeneous sources this scalar describes only the first source's expanded
level, not every item in the payload.
`targetLevel` is the level of the summary being produced (for example, 2 or 3).

`context` is the existing transition payload (capped head text and recent
higher-level summaries), **private data**, not template source. A transition
template must contain `{context}` exactly once. Braces and dollar signs in
inserted context or participant text remain literal. This substitution rule
is not a prompt-injection security boundary: the model still sees the data.

A source-level merge retry uses the applicable merge slot with
`sourceLevelShown` equal to the sources' actual level, rather than the level
of their expanded children. These refusal retries ignore reading mode and use `witnessedMerge`
when every source is witnessed, otherwise `merge`; an omitted slot uses the
same built-in witnessed/general formatter. `readingMerge` does not control source-level refusal retries.
Split pieces keep the parent chunk's ordinary/witnessed classification and use `chunk`/`witnessedChunk`, including
pieces of reading-mode chunks. This does not change split/merge algorithms.

## Validation and precedence

Construction validates the entire `compressionInstructions` object, including
unused slots, before any provider call. `validateCompressionInstructions`
is also exported for recipe loaders. Unknown keys within this object or its
templates, unknown presets, wrong types, blank strings, malformed or
unsupported placeholders, non-enumerable or Symbol keys, and absent required
participant/context are errors.
A chunk containing 60% of a sharded body uses `chunk`/`witnessedChunk`, not `readingChunk`.
An empty `templates: {}` is an error; omit it instead. Validator errors are `TypeError`s
with allowlisted paths and reason categories after the existing
`Invalid compressionInstructions configuration` prefix. Unknown keys, preset names
and placeholder names are bounded, JSON-escaped and accompanied by supported
alternatives; template bodies and participant values are never echoed. Malformed
braces have a separate diagnostic. The separate witnessed-instruction conflict instead throws a
`TypeError` beginning `Conflicting witnessedInstruction`. Template settings are copied at construction;
mutating the caller's object afterward does not update a strategy. They are
not hot-tunable. Inherited outer strategy options are ignored. Settings and
`templates` must be plain objects (Object.prototype or null prototype); custom
prototypes are rejected, not stripped of inherited fields. Non-cloneable settings
are rejected at construction with value-free errors. The exported validator
checks structure; it does not itself test structured-clone compatibility. The validator is scoped to this object, not a schema for all
existing strategy or host recipe options.

Precedence:

1. Existing subclass instruction overrides still run. They can call `super`
   to use these settings; an override returning its own text wins, including
   KnowledgeStrategy's phase/ordinary-merge overrides. Source-level retries use
   the separate `getSourceMergeInstruction` hook, whose base implementation uses
   configured `merge`/`witnessedMerge` text. Subclasses must override that hook
   separately to supply their own retry wording. `prepareCompressionRequest`
   still runs afterward. This option does not force subclasses to use it.
2. A nonempty existing `witnessedInstruction` wins over the built-in witnessed L1 text,
   including when custom templates are configured; an empty string retains the
   built-in witnessed text. Combining it with a
   `templates.witnessedChunk` override (even when `witnessedInstruction` is empty) throws rather than hiding either one.
3. A supplied template slot replaces that phase's built-in wording; omitted
   slots retain the existing default. `default` is the only accepted preset.
4. `identityReminder`/`witnessedIdentityReminder` are appended at their
   existing L1/merge sites, including custom instructions. Neither is added
   to transition requests, matching existing behavior.

The source-level refusal merge retry did not call ordinary `getMergeInstruction` or
`getReadingMergeInstruction` overrides. It still does not; a new protected
`getSourceMergeInstruction` hook covers that distinct payload. Ordinary merge
hooks retain their original signatures: `getMergeInstruction(targetLevel, sources,
targetTokens)` and `getReadingMergeInstruction(targetLevel, sources, totalTokens,
targetTokens)`. Delegating overrides should call `super` with those same arguments;
the base hooks infer custom templates' shown level from the first source's declared
`sourceLevel` (falling back to its level minus one, or 0 for empty sources).
The source-retry hook takes only `(targetLevel, sources, targetTokens)`; it
ignores reading mode and has no reading-body `totalTokens` argument.
Before any refusal, `tool_use` retries retain the ordinary/reading merge hook
and template with the no-tools addition. After a refusal, source-level retry
selection stays sticky: a subsequent `tool_use` retry uses the source-retry hook
plus the no-tools addition.
The new `getCompressionOpening` hook handles the L1 marker. Transition
customization is inside `generateTransitionSummary`; overriding that method
still owns the whole operation.

`summarySystemPrompt` and `summaryUserPrompt` exist in the public config but
are not read by these current request-building paths. They are not aliases
for this option. The host-supplied live system prompt, tools, native content,
recall carrier content, and transition system prompt are not customized by this
option. This does not imply unchanged request bytes or provenance hashes; see
the compatibility caveat above.

## Scope and limits

Custom wording is guidance, not a guarantee of accuracy, secrecy, attribution,
provider acceptance, or improved compression quality. No real-provider
qualification is implied. Existing retry additions (such as no-tools/plain
prose instructions), request ceilings, and output caps still apply. The
“Attribution discipline” suffix also follows custom merge text whenever
`compressionMergeSourceOnly` (or its source-only fallback) applies, not just
on refusal retries. Templates can increase input size; target token placeholders
are not output validators.

## Proposed host recipe (requires companion wiring)

```json
{
  "agent": {
    "strategy": {
      "type": "autobiographical",
      "compressionInstructions": {
        "participant": "Participant",
        "templates": {
          "chunk": "Write an attributed event note about {participant}. Target {targetTokens} tokens."
        }
      }
    }
  }
}
```

Hosts must forward this option and validate it before constructing the strategy.
Companion integration and release coordination belong in the
[connectome-host companion PR](https://github.com/anima-research/connectome-host/pull/648),
not in version-pinned instructions here. This CM option does not itself add host wiring.

The developer prompt dump/replay scripts reconstruct built-in wording only;
they do not recover custom templates from stored summaries.
