// Which lines of a text an edit touched, for highlighting what a change did to the generated
// config. Lines are compared whole; edits are small and mostly contiguous, so the common head and
// tail are stripped first and only the middle gets a real (LCS) diff.

/**
 * Inclusive line range in the new text. A pure deletion has `deleted` set and start = end = the
 * line it happened before (the line count when it was at the end).
 */
export interface LineRange {
  start: number;
  end: number;
  deleted?: true;
}

/** A range plus the old lines it replaced (all of them for a deletion, none for an insertion). */
type Hunk = LineRange & { old: string[] };

/** Middle sizes beyond this skip the LCS and report the whole middle as one range. */
const LCS_LIMIT = 250_000;

export function changedLines(oldText: string, newText: string): LineRange[] {
  if (oldText === newText) return [];
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);

  const hunks: Hunk[] = [];
  if (!mb.length) hunks.push({ start: head, end: head, deleted: true, old: ma });
  else if (!ma.length || ma.length * mb.length > LCS_LIMIT) hunks.push({ start: head, end: head + mb.length - 1, old: ma });
  else walk(ma, mb, head, hunks);
  for (const h of hunks) slide(h, b);
  return hunks.map(({ start, end, deleted }) => (deleted ? { start, end, deleted } : { start, end }));
}

/** LCS diff of the middles: lines of mb not matched are changed; deletions sit before the next kept line. */
function walk(ma: string[], mb: string[], head: number, hunks: Hunk[]) {
  // lcs[i][j]: length of the LCS of ma[i..] and mb[j..].
  const lcs: Uint16Array[] = Array.from({ length: ma.length + 1 }, () => new Uint16Array(mb.length + 1));
  for (let i = ma.length - 1; i >= 0; i--) {
    for (let j = mb.length - 1; j >= 0; j--) {
      lcs[i][j] = ma[i] === mb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const mark = (line: number, removed?: string) => {
    const last = hunks[hunks.length - 1];
    if (removed !== undefined) {
      // Next to changed lines it is part of a replacement, which the shading already shows.
      if (last && (last.deleted ? last.start === line : line <= last.end + 1)) last.old.push(removed);
      else hunks.push({ start: line, end: line, deleted: true, old: [removed] });
    } else if (last?.deleted && last.start === line) {
      hunks[hunks.length - 1] = { start: line, end: line, old: last.old };
    } else if (last && !last.deleted && line <= last.end + 1) {
      last.end = Math.max(last.end, line);
    } else hunks.push({ start: line, end: line, old: [] });
  };
  let i = 0;
  let j = 0;
  while (i < ma.length || j < mb.length) {
    if (i < ma.length && j < mb.length && ma[i] === mb[j]) {
      i++;
      j++;
    } else if (j < mb.length && (i >= ma.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      mark(head + j);
      j++;
    } else {
      mark(head + j, ma[i]);
      i++;
    }
  }
}

const indent = (line: string | undefined) => (line === undefined ? -1 : line.length - line.trimStart().length);

/**
 * A removed or inserted object's "{" is the same line as the next object's, so a hunk tends to
 * land one line into that object. The hunk can move up while the line before it equals its last
 * line (same text, different boundary); of those positions, take the one whose first line is
 * least indented and, among those, whose preceding line isn't indented deeper than it: that is
 * where one object ends and the next begins.
 */
function slide(h: Hunk, b: string[]) {
  if (!h.deleted && h.old.length) return;
  // The hunk's lines at its current position.
  const lines = h.deleted ? [...h.old] : b.slice(h.start, h.end + 1);
  const candidates: { start: number; first: string; prev: string | undefined }[] = [];
  let start = h.start;
  for (;;) {
    candidates.push({ start, first: lines[0], prev: b[start - 1] });
    if (start === 0 || b[start - 1] !== lines[lines.length - 1]) break;
    lines.unshift(lines.pop()!);
    start--;
  }
  const best = candidates.reduce((best, c) => {
    const ci = indent(c.first);
    const bi = indent(best.first);
    if (ci !== bi) return ci < bi ? c : best;
    return indent(c.prev) <= ci && indent(best.prev) > bi ? c : best;
  });
  const shift = h.start - best.start;
  h.start -= shift;
  h.end -= shift;
}
