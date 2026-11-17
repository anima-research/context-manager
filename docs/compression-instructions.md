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
built-in text. No migration of existing summaries is performed.

## Slots and placeholders

| Slot | Where it is used | Available placeholders |
| --- | --- | --- |
| `opening` | L1 record marker, including split pieces; coordinate with `chunk` (the built-in chunk refers back to this notification) | `participant` |
| `chunk` | Ordinary/mixed L1 and split pieces | `participant`, `targetTokens` |
| `witnessedChunk` | Wholly inherited L1 and split pieces | `participant`, `targetTokens` |
| `readingChunk` | L1 portion of a larger sharded body | `participant`, `targetTokens`, `totalTokens` |
| `merge` | Ordinary/mixed consolidation | `participant`, `targetTokens`, `sourceLevelShown`, `targetLevel` |
| `witnessedMerge` | Consolidation with every source witnessed | same as `merge` |
| `readingMerge` | Consolidation of portions of one larger body | same as `merge`, plus `totalTokens` |
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
`targetLevel` is the level of the summary being produced (for example, 2 or 3).

`context` is the existing transition payload (capped head text and recent
higher-level summaries), **private data**, not template source. A transition
template must contain `{context}` exactly once. Braces and dollar signs in
inserted context or participant text remain literal. This substitution rule
is not a prompt-injection security boundary: the model still sees the data.

A source-level merge retry uses the applicable merge slot with
`sourceLevelShown` equal to the sources' actual level, rather than the level
of their expanded children. Retries ignore reading mode and use `witnessedMerge`
when every source is witnessed, otherwise `merge`; an omitted slot uses the
same built-in witnessed/general formatter. `readingMerge` never controls retries.
Split pieces keep the parent chunk's ordinary/witnessed classification and use `chunk`/`witnessedChunk`, including
pieces of reading-mode chunks. This does not change split/merge algorithms.

## Validation and precedence

Construction validates the entire `compressionInstructions` object, including
unused slots, before any provider call. `validateCompressionInstructions`
is also exported for recipe loaders. Unknown keys within this object or its
templates, unknown presets, wrong types, blank strings, malformed or
unsupported placeholders, and absent required participant/context are errors.
An empty `templates: {}` is an error; omit it instead. Errors are `TypeError`s
with allowlisted paths and reason categories after the existing value-free
`Invalid compressionInstructions configuration` prefix; values and unknown keys
are never echoed. Template settings are copied at construction;
mutating the caller's object afterward does not update a strategy. They are
not hot-tunable. The validator is scoped to this object, not a schema for all
existing strategy or host recipe options.

Precedence:

1. Existing subclass instruction overrides still run. They can call `super`
   to use these settings; an override returning its own text wins, including
   KnowledgeStrategy's phase/ordinary-merge overrides. Source-level retries use
   the separate `getSourceMergeInstruction` hook, whose base implementation uses
   configured `merge`/`witnessedMerge` text. Subclasses must override that hook
   separately to supply their own retry wording. `prepareCompressionRequest`
   still runs afterward. This option does not force subclasses to use it.
2. Existing `witnessedInstruction` wins over the built-in witnessed L1 text,
   including when custom templates are configured. Combining it with a
   `templates.witnessedChunk` override throws rather than hiding either one.
3. A supplied template slot replaces that phase's built-in wording; omitted
   slots retain the existing default. `default` is the only accepted preset.
4. `identityReminder`/`witnessedIdentityReminder` are appended at their
   existing L1/merge sites, including custom instructions. Neither is added
   to transition requests, matching existing behavior.

The existing merge retry did not call ordinary `getMergeInstruction` or
`getReadingMergeInstruction` overrides. It still does not; a new protected
`getSourceMergeInstruction` hook covers that distinct payload. Ordinary merge
hooks receive an optional final shown-level argument for selected wording.
The new `getCompressionOpening` hook handles the L1 marker. Transition
customization is inside `generateTransitionSummary`; overriding that method
still owns the whole operation.

`summarySystemPrompt` and `summaryUserPrompt` exist in the public config but
are not read by these current request-building paths. They are not aliases
for this option. The host-supplied live system prompt, tools, native content,
recall carriers, provenance, and transition system prompt are unchanged.

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
