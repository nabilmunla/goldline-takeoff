// v0.16 (group g2): the room icon (outline with a door swing) - its own file so the take-off list (ItemTree,
// also loaded by tests in node) does not load the room panel and the app's window API with it.
export function RoomIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6.5 13.5H2.5v-11h11v11h-3" />
      <path d="M6.5 13.5a4 4 0 014-4" strokeDasharray="1.4 1.4" />
    </svg>
  );
}
