- `primaryToolProseHoist: { intoTool, fromTools, field?, result?, minChars? }` —
  the same rewrite as `compressionToolProseFallback`, applied to **every primary
  compile**, recent turns included. Long prose in a private-reasoning tool
  argument (`skip_reply.reason`, `think.content`) blocks primary turns too: five
  400–570-character reasons in the raw tail got every primary wake refused
  `reasoning_extraction`, and moving them into `journal` rounds passed on the
  exact refused request. Always-on rather than refusal-triggered so the render is
  deterministic turn over turn (stable cached prefix). A view only — stored
  history keeps the original words. Skipped unless `intoTool` is among the
  declared tools. Off by default. Exposed to `ContextManager.compile` through the
  new optional `ContextStrategy.getPrimaryToolProseHoist()`.
