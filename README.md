# context-manager

`@animalabs/context-manager` keeps an LLM agent's conversation history and compiles it into the messages for each model call, within a token budget. Every message is stored in a [Chronicle](https://github.com/anima-research/chronicle) store, and a strategy decides what each compile sends. The autobiographical strategy folds older history into summaries in the agent's own words, written by the model you name, so a long-running agent's messages stay in the store while each compile fits its budget.

It's part of the Connectome ecosystem, with [chronicle](https://github.com/anima-research/chronicle), [membrane](https://github.com/antra-tess/membrane), [agent-framework](https://github.com/anima-research/agent-framework) and [connectome-host](https://github.com/anima-research/connectome-host). agent-framework opens one `ContextManager` for each agent on its shared Chronicle store, under the namespace `agents/<name>`. It compiles each request from that manager and calls `tick()` to run compression. Compiled messages are membrane's `NormalizedMessage`s, and the strategy writes summaries through membrane.

## Install

```bash
npm install @animalabs/context-manager
```

It needs Node 22.12 or later, as its `package.json` declares, and depends on `@animalabs/chronicle` and `@animalabs/membrane`. To compress with the autobiographical strategy you'll construct a `Membrane` yourself, so install `@animalabs/membrane` alongside it.

## Quick start

```ts
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';

// Opens the Chronicle store at this path, creating it if it doesn't exist.
const manager = await ContextManager.open({
  path: './agent-store',
  strategy: new PassthroughStrategy(),
});

manager.addMessage('User', [{ type: 'text', text: 'Hello!' }]);
manager.addMessage('Claude', [{ type: 'text', text: 'Hi. What are we working on?' }]);

const { messages, systemInjections } = await manager.compile({
  maxTokens: 100_000, // the whole window, the response included
  reserveForResponse: 4_000,
});
// `messages` go into a membrane request. Injections you pass to compile() as
// its second argument with position 'system' come back in `systemInjections`,
// as content blocks for your system prompt.

manager.close();
```

To use a store your application already holds, pass it as `store` (a Chronicle `JsStore`) instead of `path`. Your application then closes it. Several managers can share one store. `namespace` gives each its own context log and strategy state, summaries included, and `isolate: true` with a `namespace` gives it its own messages too.

## Strategies

| Strategy | What a compile sends |
|---|---|
| `PassthroughStrategy` (the default) | Every message as stored. When they don't all fit, the most recent ones that do. |
| `WindowedPassthroughStrategy` | Every message since an anchor, without compression. The anchor moves forward in coarse jumps when the window outgrows the budget, or wherever `setAnchor` puts it. Between moves the window only grows at its end, which keeps the compiled prefix stable for the provider's prompt cache, apart from images it strips past its live-image limits. |
| `AutobiographicalStrategy` | Recent messages as they are, and older history as summaries the agent's model writes, merged into higher levels as they accumulate. |
| `KnowledgeStrategy` | An `AutobiographicalStrategy` for knowledge-extraction work. It chunks at phase transitions, compresses each phase with its own prompts, and keeps unresolved leads across levels. |

## The autobiographical strategy

```ts
import { Membrane, AnthropicAdapter } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '@animalabs/context-manager';

const manager = await ContextManager.open({
  path: './agent-store',
  // The strategy writes summaries through this membrane. The adapter reads
  // ANTHROPIC_API_KEY unless you pass { apiKey }.
  membrane: new Membrane(new AnthropicAdapter()),
  strategy: new AutobiographicalStrategy({
    // Required: the model whose voice the summaries are in.
    compressionModel: 'claude-sonnet-4-5',
  }),
});

manager.addMessage('User', [{ type: 'text', text: 'Hello!' }]);
// ...more messages as the conversation goes...

await manager.tick(); // compresses the next waiting chunk or merge, if any
const { messages } = await manager.compile({ maxTokens: 200_000, reserveForResponse: 8_000 });

manager.close();
```

How it works, with each option's default in parentheses:
- The newest `recentWindowTokens` (30,000) stay raw. Older messages are cut into chunks of about `targetChunkTokens` (3,000), at message boundaries. Give compile a budget with room for the raw window and the summaries. A compile that can't fit is refused with `OverBudgetError`.
- Each `tick()` does at most one piece of compression work: it compresses the next waiting chunk, or else runs the next waiting merge. So call it regularly, for instance after each turn. For a chunk, the strategy asks `compressionModel`, through membrane, what it recalls from that part of the conversation. The answer is a level-1 summary, which takes the chunk's place in compiled context. Set `autoTickOnNewMessage: true` (false) to start a tick in the background on each new message instead of calling `tick()` yourself.
- `compressionModel` has no default. Without it, the strategy refuses to write summaries, because a substitute model writing in the agent's voice would corrupt the record. Without a membrane, `tick()` only logs a warning.
- A summary renders where its messages were, as a short exchange: a `Context Manager` turn with a header such as `[Recall L1-3]`, answered with the summary in a turn from `summaryParticipant` (`Claude`). With adaptive resolution (below), the `Context Manager` turn holds `summaryContextLabel` ("What do you remember from earlier?") instead.
- Summaries merge into one a level up once `mergeThreshold` (6) of them sit unmerged at a level. With `hierarchical` (true) set to false, they stay at one level.
- `headWindowTokens` (0) keeps the start of the conversation raw as well, for instructions that should stay verbatim.
- With `adaptiveResolution: true` (false), each compile chooses how deeply to fold each part of history to fit the budget. `foldingStrategy` names the solver: `flat-profile` (the default), `oldest-first`, `kv-stable` or `kv-unified`. `kv-unified` needs an explicit `kvUnified` policy.

With a strategy that supports them, as this one does, the manager also offers:
- `pinRange` and `markDocument` keep messages at their place in the conversation, raw by default. A pin that sets `level` or `maxLevel` holds its messages at that level, or no deeper than it, only with `adaptiveResolution` and the `kv-stable` or `kv-unified` solver. Under the other solvers, and without adaptive resolution, the pin keeps them raw. Under adaptive resolution, a pin or mark on any part of a long message stored in parts covers the whole message, in what the agent is sent, in compression and in the summarizer's prompt alike, less a part locked with `lockChunk` outside the span its ids name. As with any pin, a chunk recorded before it keeps its messages, so compression can still summarize those parts while the agent is sent them raw. Under `kv-stable`, a pin with `level` (not `maxLevel`) holds whole each summary it reaches, so a locked part that shares a summary with a part the pin covers renders at the level the pin holds that summary at. A compile whose budget can't hold the raw pins beside the rest refuses with `OverBudgetError`; where the adaptive plan's middle is over the budget, its message and `diagnostics.rawPins` name each pin keeping raw tokens in that middle. `listPins` and `unpin` manage the pins.
- `holdCompression` keeps messages out of compression until `releaseCompression`, or until an optional `timeoutMs` passes, for content you'll still edit. Holds live in memory, so a reopened manager starts with none, and a hold that's never released stalls compression of everything after it.
- `searchSummaries`, `getSummary` and `getSummariesInRange` read the summaries, for memory tools an agent can call.
- `setToolDefinitions` and `setSystemPrompt` give the summarizer's calls the agent's own tools and system prompt. A chunk whose messages hold tool calls or results waits to be compressed until tool definitions are set.
- `getRenderStats` reports how much of the last compile was raw and how much was summaries, with counts for levels 1 to 3. It's `null` until a live compile has run since the strategy loaded its branch, which opening the store, `setStrategy()` and a branch switch each do; a dry compile or preview leaves it as it was. Each compile's result carries its own as `renderStats`, so a dry compile (`dryRun`) shows the composition of the request it built without sending it.

For a model that binds each signed thinking block to the request it was minted in, pass `{ thinkingBinding: { binds: true, dropBlock, participant }, identity }` as compile's third argument, with `participant` the name the model's own replies are stored under and `identity` digests of the request's system text, tools, model and the rest of its head. The compile then leaves out the thinking such a model can no longer take, against a per-branch record of the last request the branch sent, and says what it newly left out in `thinkingStrip`. Once the branch has a record, a reply keeps its thinking at the compile after it's stored only if the host has noted it with `noteRequestSent(rows, identity, compileId)`, naming the `provenance.compileId` of the compile its stream was built from: as it sends each later round of a stream, the ids of the stored messages the request carried after the compiled ones, every round's so far, in order, and once the stream has ended, those and its last reply's, with `{ unstored: true }` for a row it can't vouch was carried or returned as stored. A host that doesn't call it loses each reply's thinking at the compile after it's stored, and is never refused for it. While one of a branch's requests is still streaming, compile for that branch with `binds` only with `dryRun`: a committing compile with `binds` makes that stream's later notes vouch for nothing (see `SelectOptions.thinkingBinding` in `src/types/strategy.ts`).

Every option is documented on `AutobiographicalConfig` in `src/types/strategy.ts`.

## Branches

Chronicle keeps the store's history, so a conversation can branch. `branchAt(messageId)` creates a branch as of a message, and `switchBranch(name)` moves to it. `fork()` creates a branch at the current head and switches to it. The strategy's state, summaries included, follows the branch.

## Inspecting and repairing stores

Among other tools, `scripts/` holds ones for inspecting and repairing stores. For example, `inspect-store.ts` writes out a store's messages, summary tree and resolutions, `audit-topology.ts` checks that each summary covers a contiguous run of messages, and `repair-topology.ts` plans a repair for one that doesn't, which it applies with `--apply`. Opening a store takes its lock and can write to it, so run them on a stopped agent's store or on a copy. `scripts/README.md` shows how to compile a script and describes several of them.

## Design notes

`docs/` holds the design behind the strategies. These are good places to start:
- [`adaptive-resolution-design.md`](docs/adaptive-resolution-design.md): adaptive resolution and its solvers.
- [`kv-stable-context-control.md`](docs/kv-stable-context-control.md): the `kv-stable` solver.
- [`unified-solve-design.md`](docs/unified-solve-design.md): the `kv-unified` solver.
- [`compression-recall-curve-fallback-spec.md`](docs/compression-recall-curve-fallback-spec.md): what compression does when the model refuses a request.
- [`memory-tools-design.md`](docs/memory-tools-design.md): memory tools for agents.

## Development

```bash
npm ci
npm test           # builds, then runs the compiled tests in dist/
npm run typecheck
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers how changes land, what a pull request should contain, changelog fragments and releases. [CHANGELOG.md](CHANGELOG.md) lists what each release changed.

## License

MIT, as `package.json` declares.
