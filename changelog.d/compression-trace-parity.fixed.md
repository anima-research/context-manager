- Compression outcome tracing no longer re-extracts live fallback response text;
  disabled logging skips diagnostic classification entirely. Attempt receipt
  construction is best-effort, including message ID getters. Unstripped lane
  resume errors retain the existing carrier-retry and model-attribution boundary.
