- **Chunks refused in a row, with nothing landing between them, are held, not
  quarantined.** A refusal now counts against its chunk only while compression
  lands otherwise on the same route and model, as a transient failure already
  did. When refusals exhaust a chunk's request family, and they exhausted the
  lane's previous family too, with no compression landing on that route and
  model between them, the lane holds both chunks and quarantines neither: the
  first one's record is cleared. While the hold lasts, each chunk that
  refusals exhaust is held, every queued chunk is asked once, no merge is sent
  on that route and model, and a held chunk's messages stay out of other
  requests, as a quarantined chunk's do. A compression that lands on that
  route and model, this strategy's or another's in the process, ends the hold.
  From then on each landing lets the oldest held chunk be asked again, one at
  a time, and one that refusals exhaust again is quarantined. While any chunk
  is held, `checkReadiness()` reports that the lane isn't ready, a tick that
  sends nothing throws `CompressionRefusalHold`, which says what was seen and
  what to check, and the quarantine alarm sends no all-clear. A hold lives only
  in its process: a restart asks every held chunk again. A family that a size
  or shape rejection, an empty answer or a rung's failures exhaust is still
  quarantined at once, and so is a chunk asked again in another shape.
