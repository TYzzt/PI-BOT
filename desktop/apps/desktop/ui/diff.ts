export interface DiffRow { kind: 'hunk' | 'context' | 'addition' | 'deletion' | 'note'; text: string; oldLine?: number; newLine?: number; }
/** Parse line numbers from unified hunks, without interpreting source as markup. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []; let oldLine = 0, newLine = 0, inHunk = false;
  const lines = diff.split('\n'); if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; rows.push({ kind: 'hunk', text: line }); continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) rows.push({ kind: 'addition', text: line.slice(1), newLine: newLine++ });
    else if (line.startsWith('-')) rows.push({ kind: 'deletion', text: line.slice(1), oldLine: oldLine++ });
    else if (line.startsWith(' ')) rows.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    else rows.push({ kind: 'note', text: line });
  }
  return rows;
}
