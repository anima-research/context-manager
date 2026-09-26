- The head window no longer ratchets down under calibration drift (#122).
  When a calibration rise moved the token-derived head boundary onto
  messages no chunk owned, those messages were minted into small, late L1s
  that merged with the open frontier: summaries mixing the chronicle's
  opening with much later material, rendered at the opening's position. The
  boundary now extends over that uncovered run to the first owned message
  (bounded at 2× `headWindowTokens`). Stores with no coverage after the
  boundary, and heads that grew over owned messages, keep the stock boundary.
