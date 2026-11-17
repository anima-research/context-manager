- Compression instruction validation now ignores inherited caller settings, reports
  value-free errors for invalid enforced or non-cloneable settings, and rejects
  an empty witnessedInstruction combined with a witnessedChunk template with an
  actionable conflict message.
