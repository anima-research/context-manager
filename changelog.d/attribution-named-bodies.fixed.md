- `compile()` no longer groups every stored message into bodies to attribute
  its raw entries. Provenance now finds each body a raw entry names, through a
  store lookup when it doesn't follow the last body found, and reads the
  stored messages only around it. The rendered layout still walks the
  strategy's view, since it records every message of the view. Sources, their
  completeness and `rawBodies` are unchanged.
