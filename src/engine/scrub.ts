// What a problem report may not carry: folder paths (they name projects and people).
// Folder names may have spaces (0.23.2, DeepSeek #8: the old rule stopped at the first space and kept the rest):
// a path's folders run to its last \ or / on the line, its last name to its extension when it has one; the known
// folders (team folder, this PC's folder...) go whole with whatever follows them. Left: the second and later words
// of a last name that has no extension (a folder at the end of a line).
const DIRS = String.raw`(?:[^\n"'|<>]*[\\/])?`;
const END = String.raw`(?:[^\n"'|<>\\/]*?\.[A-Za-z0-9]{1,5}(?=[\s"'|<>:),;]|$)|[^\s"'|<>]*)`;
const WIN = new RegExp(String.raw`\b[A-Za-z]:[\\/]` + DIRS + END, 'gm');
const UNC = new RegExp(String.raw`\\\\` + DIRS + END, 'gm');
const NIX = new RegExp(String.raw`(^|[\s"'(=])\/[^\s"'|<>\/]+\/` + DIRS + END, 'gm');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** folder paths out of a problem report's text */
export function scrubPaths(t: string, known: (string | null | undefined)[] = []): string {
  for (const k of known.filter((x): x is string => !!x && x.length > 3).sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(esc(k) + String.raw`(?:[\\/]` + DIRS + END + ')?', 'gm'), '<path>');
  }
  return t.replace(UNC, '<path>').replace(WIN, '<path>').replace(NIX, '$1<path>');
}
