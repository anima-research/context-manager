- L1 compression no longer interprets recall-shaped raw Context Manager turns
  at or after the source opening as recall headers. Even with default settings,
  consecutive same-participant source turns can now collapse without the
  synthetic conversation-resumes separator previously inserted there. Raw
  history before the opening still uses header-shaped recall detection.
