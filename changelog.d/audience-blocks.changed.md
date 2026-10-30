- **Host operators:** a write is now refused, saying why, when it puts an
  `audience` on a tool call or tool result, a system change, inline media
  (which the store keeps as a blob) or a block inside another, or in a
  context entry, or when the `audience` isn't a list of reader names. So is
  a compile given one in an injection or in `messageInjections`, or a
  preview given one in `messageInjections`. A host that writes no
  `audience` meets none of these.
- **Host operators:** a block that has an `audience` is now left out of
  every compile of a manager that compiles for no reader, one opened with
  no `viewReader` on a namespace that records none, where it used to be
  compiled for every manager.
