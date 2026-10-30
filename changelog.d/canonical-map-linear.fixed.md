- `AutobiographicalStrategy`'s lookup of the persisted canonical summaries no
  longer compares each held summary with the whole stored summary list. It
  groups the stored list by id once, and compares each held summary only with
  the stored copies of its own id. On synthetic stores of about 20,000
  summaries, on Linux with Node 24.22.1, one lookup took 4.2 and 5.7 s of CPU
  before this change and 0.26 and 0.32 s after it, in two rounds. It finds the
  same summaries.
