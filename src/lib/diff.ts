/**
 * 极简行级 diff。
 *
 * 只为展示编辑历史用，不追求最短编辑脚本 ——
 * 装一个 diff 库要拖进几十 KB，而这里的需求就是
 * 「哪几行加了、哪几行删了」，LCS 足够。
 */

export type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "add"; text: string }
  | { kind: "remove"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // 最长公共子序列的长度表
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ kind: "remove", text: a[i] });
      i++;
    } else {
      result.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) result.push({ kind: "remove", text: a[i++] });
  while (j < b.length) result.push({ kind: "add", text: b[j++] });

  return result;
}

/**
 * 折叠没改动的大段落，只留改动处上下各 N 行。
 * 一篇两千字的帖子改了一个错别字，全文对照没人看得下去。
 */
export function collapseUnchanged(lines: DiffLine[], context = 2): (DiffLine | { kind: "gap"; count: number })[] {
  const changed = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind !== "same") {
      for (let k = index - context; k <= index + context; k++) {
        if (k >= 0 && k < lines.length) changed.add(k);
      }
    }
  });

  const output: (DiffLine | { kind: "gap"; count: number })[] = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (changed.has(index)) {
      if (gap > 0) {
        output.push({ kind: "gap", count: gap });
        gap = 0;
      }
      output.push(line);
    } else {
      gap++;
    }
  });
  if (gap > 0) output.push({ kind: "gap", count: gap });

  return output;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  return {
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "remove").length,
  };
}
