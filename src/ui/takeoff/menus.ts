// v0.16: menus / popovers that are open now (UI rule 6). The drawing's key handlers are on the window and
// registered first, so they see Esc before any menu: they ask anyMenuOpen() and leave the key alone.
// (its own module, with no imports: the drawing imports it, and so do tests that run without a window)
let openMenus = 0;
/** a menu / popover has opened; call the returned function when it closes (once) */
export function menuOpened(): () => void {
  openMenus++;
  let done = false;
  return () => { if (!done) { done = true; openMenus--; } };
}
/** is a menu / popover open (Esc closes it, nothing behind it sees the key) */
export const anyMenuOpen = () => openMenus > 0;
