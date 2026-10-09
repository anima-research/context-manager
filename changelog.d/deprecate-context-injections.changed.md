- **`ContextInjection` and the `injections` parameter of
  `ContextManager.compile()` are deprecated** (anima-research/agent-framework#171).
  Injections are never stored: each compile splices them in fresh, re-anchored
  to the latest user-participant message, so the rendered prefix changes at
  every activation and prompt caches stop hitting past that point (head-only
  hits on OpenAI Responses/Codex); after a mid-activation recompile the anchor
  can also fall between a tool call and its result. Behavior is unchanged —
  injections are still accepted and placed as before — and
  `CompileResult.systemInjections` stays populated for `system`-position
  injections. Prefer content stored once at its own position: the system
  prompt for durable instructions, ordinary messages for changing state.
