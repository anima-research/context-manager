- **`ContextInjection`, the `injections` parameter of
  `ContextManager.compile()` and `CompileResult.systemInjections` are
  deprecated** (anima-research/agent-framework#171). Injections are never
  stored: each compile splices `beforeUser` and `afterUser` injections in
  fresh, re-anchored to the latest message whose participant is `user`
  (ignoring case), so the rendered prefix changes each time a newer one
  arrives and prompt caches stop hitting past that point (head-only hits on
  OpenAI Responses/Codex); after a mid-activation recompile a `beforeUser`
  injection can also land between a tool call and its result. `system`
  injections are passed again with every compile too, so when one's content
  changes the caller's system prompt itself changes, and the prompt cache
  misses from there, ahead of every message. Behavior is unchanged —
  injections are still accepted and placed as before — and
  `CompileResult.systemInjections` stays populated for `system`-position
  injections. Prefer content stored once at its own position: the system
  prompt for durable instructions, ordinary messages for changing state.
