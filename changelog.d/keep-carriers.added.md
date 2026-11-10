- `AutobiographicalStrategy.truncateContent` takes an optional `keepCarriers`.
  With it, the cut keeps a zero-width carrier wherever it sits, past the cap
  too. The strategy passes it when it cuts a raw message, and not for a
  summary's answer. An override that ignores it cuts carriers as earlier
  releases did.
