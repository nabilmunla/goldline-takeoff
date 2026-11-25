// What the drawing does when its area is measured (SheetCanvas's ResizeObserver), kept out of the
// component so the test runs what the screen runs (ritual run 3, 0.15.0).
//
// The drawing area's size is a guess (800 x 600) until it is first measured, and a sheet's view is set
// up by an effect (its remembered view, else a fit) that can run before or after that first measure.
// Two things went wrong with that, about half the time each (since 0.12 at least):
//  - the effect ran first: the sheet was fitted to the guess (and stored so), and the first measure then
//    saw a remembered view and did not fit again - the sheet sat in the top left corner, too big or small;
//  - the measure came first, for a sheet with a view from before: the placeholder view on screen was
//    stored as the sheet's view, over the remembered one - the sheet opened again at a fixed zoom in the
//    corner instead of as it was left.

export type MeasureStep = 'fit' | 'keep' | 'wait';

/**
 * - real: the area has a size (one not laid out yet measures 0 - not a measure)
 * - sized: it was really measured before
 * - remembered: this sheet has a view from before (or the one fitted a moment ago)
 * - fitOnGuess: the view on screen was fitted to the guessed size
 * - viewSet: this sheet's view is set up (remembered one restored, or fitted)
 *
 * fit: fit the sheet now. keep: the view stays (and is remembered as it is). wait: only draw - the view on
 * screen is still the placeholder, and the sheet's own view is about to be set up.
 */
export function measureStep(o: { real: boolean; sized: boolean; remembered: boolean; fitOnGuess: boolean; viewSet: boolean }): MeasureStep {
  if (o.real && !o.sized && (!o.remembered || o.fitOnGuess)) return 'fit';
  return o.viewSet ? 'keep' : 'wait';
}
