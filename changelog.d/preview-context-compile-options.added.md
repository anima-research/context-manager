- `ContextManager.previewContext`'s `opts` takes, beside `render` and
  `thinkingBinding`, the other select options a compile takes:
  `kvUnifiedImmutablePrefixHash` and `kvUnifiedContinuityRelaxation`. Its dry
  select passes them on, so a kv-unified agent's preview runs with the prefix
  hash and continuity relaxation its compile uses. `dryRun` is always set, and
  `identity` isn't taken, since nothing in a preview reads it.
