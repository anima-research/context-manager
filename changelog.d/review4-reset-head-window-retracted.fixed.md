- `resetHeadWindow` rejects, without resetting the head window, when the
  strategy's `onPresented` hook for its transition takes the transition out
  of the window again. Before, it reset the head window to start at a row
  the window lacked.
