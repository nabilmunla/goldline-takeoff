// v0.16 the ONE list of the take-off's keys and mouse gestures (UI rule 7): the tool bar's "?" and the F1
// list (Help.tsx, "Take-off (drawings)") are both made from it. A key added or changed: change it here.
export interface KeyRow {
  /** one key or combination per entry, shown as chips: ['Ctrl+Z', 'Ctrl+Y'] */
  keys: string[];
  what: string;
}
export interface KeySection {
  title: string;
  rows: KeyRow[];
}

export const QTO_KEYS: KeySection[] = [
  {
    title: 'Tools',
    rows: [
      { keys: ['V', 'A', 'L', 'C', 'B', 'E', 'F'], what: 'Select · area · length · count · wall · beam · room (finishes)' },
      { keys: ['H', 'Q', 'S', 'W', 'N'], what: 'Cut-out · ruler (not saved) · scale · viewport scale · note' },
      { keys: ['P', 'R', 'O'], what: 'How the next shape is drawn: nodes (polygon / polyline) · rectangle · circle' },
      { keys: ['T'], what: 'Count by tag on this sheet (D01, SD-1…): every one shown to keep or leave out' },
      { keys: ['D', 'O'], what: 'Walls (while drawing, or on a wall already drawn): a door · another opening, then click on the wall' },
      { keys: ['D', 'O'], what: 'Rooms (while drawing the outline, or with the room selected): a door · another opening (with its sill), then click on a wall edge of the room' },
      { keys: ['Right-click an edge'], what: 'Rooms: Open edge (no wall) · Shadow gap here - each a ✓ to switch on / off' },
    ],
  },
  {
    title: 'Aids',
    rows: [
      { keys: ['G'], what: 'Snap to the drawing’s lines and nodes on / off' },
      { keys: ['F8'], what: 'Ortho on / off: horizontal and vertical only, and ⊥ onto a take-off near the pointer' },
      { keys: ['Shift'], what: 'Hold: ortho for the moment · Rectangle: a square' },
      { keys: ['M'], what: 'Magnifier on / off (a round loupe next to the pointer)' },
      { keys: ['Alt+wheel'], what: 'Magnifier: more / less magnification (×2 to ×8)' },
      { keys: ['Crosshair'], what: 'Tool bar button: lines across the whole sheet through the pointer' },
    ],
  },
  {
    title: 'Selecting (Select tool)',
    rows: [
      { keys: ['Click'], what: 'Select a shape · Shift+click / Ctrl+click: add or take it out' },
      { keys: ['Drag →'], what: 'On empty paper, left to right: window - selects what is wholly inside (solid blue box)' },
      { keys: ['Drag ←'], what: 'Right to left: crossing - selects what the box touches (dashed green box)' },
      { keys: ['Shift+drag', 'Ctrl+drag'], what: 'Window / crossing: the shapes go into or out of the selection' },
      { keys: ['Drag a shape'], what: 'Move the selection · Alt+drag: copy it' },
      { keys: ['Del'], what: 'Delete the selected shapes (the drawing has the keyboard: click it first)' },
      { keys: ['Right-click'], what: 'Everything you can do with what is under the pointer' },
    ],
  },
  {
    title: 'Nodes',
    rows: [
      { keys: ['Drag a grip'], what: 'Move that node (it snaps; F8 / Shift: square to the next one)' },
      { keys: ['Double-click'], what: 'On a line, wall, beam or an area’s edge: a new node there (the shape does not change)' },
      { keys: ['Double-click a node'], what: 'Delete it · also right-click › Delete node, or Alt+click' },
      { keys: ['Click an end grip', '4.2', 'Enter'], what: 'That end segment exactly that long, in the same direction' },
      { keys: ['Drag a middle dot'], what: 'Add a node there; on an arc: reshape it (Alt = the other one)' },
    ],
  },
  {
    title: 'While drawing',
    rows: [
      { keys: ['Backspace', 'Ctrl+Z'], what: 'Undo the last node · Ctrl+Y puts it back' },
      { keys: ['Enter', 'Double-click'], what: 'Finish the shape' },
      { keys: ['Esc'], what: 'Stop: a complete shape is kept, loose nodes go · again: clear the ruler / the selection, stop the take-off, back to Select' },
      { keys: ['4.2', '4200', '420cm'], what: 'Type a length + Enter: the next node exactly that far (4.2 = m, 4200 = mm) · keep typing for more' },
      { keys: ['Space'], what: 'Tap: end this run, start the next in the same take-off' },
      { keys: ['A', 'L'], what: 'Next segments as arcs (click the end, then a point on the arc) / straight' },
      { keys: ['Shift+C'], what: 'Close an area (or cut-out) and finish' },
      { keys: ['✕ Cancel'], what: 'On the bar: throw the shape away (Bring back / Ctrl+Z for 15 s)' },
      { keys: ['Backspace'], what: 'Count: take back the last count' },
      { keys: ['D'], what: 'Count: doors not on a wall (cores, partitions) - each click a door of the schedule, counted in it; the next clicks use the same door (▾ = another)' },
    ],
  },
  {
    title: 'Moving around',
    rows: [
      { keys: ['Wheel'], what: 'Zoom where the pointer is · Ctrl+wheel: faster · Shift+wheel: sideways' },
      { keys: ['Middle-drag', 'Right-drag', 'Space+drag'], what: 'Pan (a plain drag on the paper selects, it does not pan)' },
      { keys: ['←', '↑', '→', '↓'], what: 'Pan' },
      { keys: ['Home', '+', '−'], what: 'Fit the sheet · zoom in / out' },
      { keys: ['PgUp', 'PgDn'], what: 'Previous / next sheet (in this tab)' },
      { keys: ['Ctrl+Tab', 'Ctrl+Shift+Tab'], what: 'Next / previous drawing tab' },
      { keys: ['Ctrl+W', 'Middle-click'], what: 'Close the drawing tab' },
      { keys: ['Ctrl+Z', 'Ctrl+Y'], what: 'Undo / redo' },
    ],
  },
  {
    title: 'Drawing list',
    rows: [
      { keys: ['Click'], what: 'Open the sheet (its tab if it is open, else a new tab)' },
      { keys: ['Ctrl+click', 'Middle-click'], what: 'Open the sheet in a new tab' },
      { keys: ['Shift+click', 'Ctrl+Shift+click'], what: 'Pick several sheets (a run / one more) - then drag them under a heading (in the “As arranged” order)' },
      { keys: ['Double-click', 'F2'], what: 'Rename the sheet' },
      { keys: ['Right-click'], what: 'Open in a new tab · rename · split a bound set into sheets · register · remove' },
    ],
  },
  {
    title: 'Take-off list',
    rows: [
      { keys: ['Click'], what: 'Select the take-off (and its shapes on the sheet) · ▶ on its row: measure into it' },
      { keys: ['Ctrl+click', 'Shift+click'], what: 'Pick several take-offs' },
      { keys: ['Drag'], what: 'Move rows, and headings with everything under them (the wheel scrolls the list meanwhile)' },
      { keys: ['F2'], what: 'Rename the take-off or heading picked' },
      { keys: ['Del'], what: 'Delete the take-offs / headings picked (asks first; Ctrl+Z brings them back)' },
      { keys: ['Esc'], what: 'Nothing picked' },
    ],
  },
];

/** the same rows as one list (the F1 panel's section) */
export const QTO_KEY_ROWS: KeyRow[] = QTO_KEYS.flatMap((s) => s.rows);
