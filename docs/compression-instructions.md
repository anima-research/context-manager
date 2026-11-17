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
keeps today's instruction text byte-for-byte. A partial `templates` object
replaces only its named slots; every unspecified slot inherits the current
built-in text. No migration of existing summaries is performed.

## Slots and placeholders

| Slot | Where it is used | Available placeholders |
| --- | --- | --- |
| `opening` | L1 record marker, including split pieces | `participant` |
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
`participant` is the configured string. It is required when referenced, and
for the optional factual preset. It does not change `summaryParticipant` or
message ownership. Repeated placeholders are replaced in one pass.

`context` is the existing transition payload (capped head text and recent
higher-level summaries), **private data**, not template source. A transition
template must contain `{context}` exactly once. Braces and dollar signs in
inserted context or participant text remain literal. This substitution rule
is not a prompt-injection security boundary: the model still sees the data.

A source-level merge retry uses the applicable merge slot with
`sourceLevelShown` equal to the sources' actual level, rather than the level
of their expanded children. Reading retries retain `readingMerge` when
selected; with no selected reading wording they retain the existing
witnessed/general fallback text. Split pieces keep the parent chunk's
ordinary/witnessed classification and use `chunk`/`witnessedChunk`, including
pieces of reading-mode chunks. This does not change split/merge algorithms.

## Validation and precedence

Construction validates the entire `compressionInstructions` object, including
unused slots, before any provider call. `validateCompressionInstructions`
is also exported for recipe loaders. Unknown keys within this object or its
templates, unknown presets, wrong types, blank strings, malformed or
unsupported placeholders, and absent required participant/context are errors.
An empty `templates: {}` is an error; omit it instead. Errors are `TypeError`s
with fixed, value-free messages. Template settings are copied at construction;
mutating the caller's object afterward does not update a strategy. They are
not hot-tunable. The validator is scoped to this object, not a schema for all
existing strategy or host recipe options.

Precedence:

1. Existing subclass instruction overrides still run. They can call `super`
   to use these settings; an override returning its own text wins, including
   KnowledgeStrategy's phase/merge overrides. `prepareCompressionRequest`
   still runs afterward. This option does not force subclasses to use it.
2. Existing `witnessedInstruction` wins over the built-in witnessed L1 text,
   including when a preset is selected. Combining it with a
   `templates.witnessedChunk` override throws rather than hiding either one.
3. A supplied template slot wins over its preset. An omitted preset means
   `default`; omitted slots inherit that preset.
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

## Optional factual preset

```json
{
  "compressionInstructions": {
    "preset": "factual",
    "participant": "Participant"
  }
}
```

This opt-in wording asks for factual, attributed event notes, distinguishes
claims from outcomes, and treats inherited/reading content as attributed
reference data rather than autobiography. It is based on a public pure
formatter reference. Templates can override individual factual slots too.
The default preset is named **DEFAULT** (`'default'` in JSON), not `legacy`;
`legacy` is not accepted. Participant identity comes only from trusted config.

Wording is guidance, not a guarantee of factuality, secrecy, attribution,
provider acceptance, or improved compression quality. No real-provider
qualification is implied. Existing retry additions (such as no-tools/plain
prose instructions), request ceilings, and output caps still apply. Templates
can increase input size; target token placeholders are not output validators.

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

This is a proposed recipe fragment, **not a working host feature shipped by
this CM change alone**. Public connectome-host at
`3e715b4e08cfcc423e90593fc8305cfb12370fa9` declares `RecipeStrategy` in
`src/recipe.ts`, validates it in `validateRecipe`, and constructs options in
`src/framework-strategy.ts` through an explicit `PASSTHROUGH_KEYS` allowlist.
That source does not declare, validate, or forward `compressionInstructions`.
A companion must add the type, validate the object on recipe load (including
unknown keys), and forward it unchanged; it must resolve a CM/framework
version exposing this API and test recipe-to-request propagation. Hosts must
also reject misspelled outer recipe option names rather than drop them.
No host edits, deployment, or automatic actor inference are part of this CM
candidate.
