- What waits for a strategy's initialization stays small. A row presented
  again and again while initialization stays failed waits once to be heard,
  and a waiting `onRetracted` call keeps each row's id and ordinal, and the
  row itself only for a row a removal took; the rest are read from the
  record when the call is made. Before, every presentation and every
  retraction added an entry, each retraction holding its rows whole.
