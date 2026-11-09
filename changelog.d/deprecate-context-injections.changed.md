- **The `beforeUser` position of `ContextInjection` is deprecated**
  (anima-research/agent-framework#171). `compile()` places a `beforeUser`
  injection again before the last user message at every compile, so it moves
  as newer user messages arrive: the request misses the prompt cache from its
  old place on, a model that binds a reply's thinking to everything before it
  drops the thinking of every reply after that place, and since a tool's
  result is carried in a user message, after a tool call it lands between the
  call and its result. Store such content as an ordinary message
  (`addMessage`) instead. Behavior is unchanged: `beforeUser` injections are
  still accepted and placed as before. `system` and `afterUser` injections
  remain supported, and `ContextInjection.position` now says what each costs:
  a `system` injection's changed text misses the cache from the system prompt
  on, and an `afterUser` one moves as `beforeUser` does, which suits text
  that must stay near the end, such as instructions.
