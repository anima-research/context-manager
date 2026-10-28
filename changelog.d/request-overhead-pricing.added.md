- `SelectOptions.requestOverhead` and `RenderStats.request`: a compile given
  its request's overhead, the system prompt and tool definitions it sends (the
  existing `RequestOverhead`), reports what the request carries besides the
  rendered context: `overheadTokens` for the overhead and `injectedTokens` for
  the compile's message-position injections. Both are in the units of `total`
  at the compile's multiplier, priced as a calibration sample prices them. A
  compile given no overhead reports no `request`, and an overhead changes
  nothing the compile selects. An overhead whose tool definitions can't be
  serialised as JSON is refused before anything is selected. The overhead's
  price is the store's estimate of the system prompt and of the tool
  definitions as JSON, not the provider's count. This is the report #323
  asked for in its second fix.
- `RenderStats.calibration.ceiling`: the largest multiplier the strategy
  applies, 1.8, reported with every calibration. It applies none above it,
  as before.
