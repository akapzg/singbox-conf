// Which lines of a text an edit touched, for highlighting what a change did to the generated
// config. Lines are compared whole; edits are small and mostly contiguous, so the common head and
// tail are stripped first and only the middle gets a real (LCS) diff.

/** Inclusive line range in the new text. A pure deletion is marked on the line that follows it. */
export interface LineRange {
  start: number;
  end: number;
}

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
  if (!mb.length) return [{ start: Math.min(head, b.length - 1), end: Math.min(head, b.length - 1) }];
  if (!ma.length || ma.length * mb.length > LCS_LIMIT) return [{ start: head, end: head + mb.length - 1 }];

  // lcs[i][j]: length of the LCS of ma[i..] and mb[j..].
  const lcs: Uint16Array[] = Array.from({ length: ma.length + 1 }, () => new Uint16Array(mb.length + 1));
  for (let i = ma.length - 1; i >= 0; i--) {
    for (let j = mb.length - 1; j >= 0; j--) {
      lcs[i][j] = ma[i] === mb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // Walk the table; lines of mb not matched are changed, and deletions mark the next kept line.
  const ranges: LineRange[] = [];
  const mark = (line: number, deletion = false) => {
    const last = ranges[ranges.length - 1];
    if (last && line <= last.end + 1) {
      // A deletion next to lines already marked adds nothing to show.
      if (!deletion) last.end = Math.max(last.end, line);
    } else ranges.push({ start: line, end: line });
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
      mark(head + Math.min(j, mb.length - 1), true);
      i++;
    }
  }
  return ranges;
}
