// mend: the command-line tool SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// This file implements every section of SPEC.md: the command line, output and exit
// codes, safe paths, format detection, the three matching tiers, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits, and the all-or-nothing write.
// The trial hand-over at the bottom (MAKEFUN_ENV_URL -> runner.ts) is kept as the
// kit has it.
//
// Two readings of SPEC.md worth noting, both taken literally:
// - A hunk whose matched lines run to the end of the file sets the result's final
//   line break from the `\` line after its last context or `+` line; with no such
//   line the result ends with a line break (so deleting a file's tail leaves the
//   break, and an empty hunk at the end leaves the file as the rule states).
// - An `R` row is tied to one move edit's own old/new pair: a chained move
//   (a -> b, then b -> c) reports `D a` and `A c`, since neither recorded pair
//   meets the rule's before/after conditions on its own.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';

function tierMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** All 0-based positions where O occurs in lines at the given tier (overlapping allowed). */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const pos: number[] = [];
  if (O.length === 0) return pos;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierMatch(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at least once at or after `from`. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: text, and for a context line the index of its line in O. */
interface NewLine {
  text: string;
  ctx?: number;
}

/**
 * Replace the k lines at `at` (the matched occurrence of O) with N. Context lines
 * are written as the file's own matched lines; at tier 2 every other line of N is
 * re-indented from O's first line's leading whitespace to the file's. With an
 * empty O the lines of N are inserted as they are.
 */
function applyReplace(lines: string[], at: number, O: string[], N: NewLine[], tier: number): string[] {
  const out = lines.slice(0, at);
  if (O.length === 0) {
    for (const nl of N) out.push(nl.text);
  } else {
    const F = leadingWs(lines[at] ?? '');
    const P = leadingWs(O[0] ?? '');
    for (const nl of N) {
      if (nl.ctx !== undefined) {
        out.push(lines[at + nl.ctx]!);
      } else if (tier === 2) {
        const t = nl.text;
        if (t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
        else out.push(t);
      } else {
        out.push(nl.text);
      }
    }
  }
  out.push(...lines.slice(at + O.length));
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (as the kit's starter has them).
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  A: number;
  oldLines: string[];
  newLines: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  backslashAfterLastPlus: boolean;
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[at]!);
  if (!m) throw new Exit2(`error: parse ${at + 1}`);
  const A = parseInt(m[1]!, 10);
  const body: string[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b === '' || b.startsWith(' ') || b.startsWith('+')) lastCtxPlus = k;
    if (b.startsWith('+')) lastPlus = k;
  }
  const backslashAfterLast =
    lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const backslashAfterLastPlus =
    lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of body) {
    if (b.startsWith('\\')) continue;
    if (b === '' || b.startsWith(' ')) {
      const text = b === '' ? '' : b.slice(1);
      oldLines.push(text);
      newLines.push({ text, ctx: oldLines.length - 1 });
    } else if (b.startsWith('-')) {
      oldLines.push(b.slice(1));
    } else if (b.startsWith('+')) {
      newLines.push({ text: b.slice(1) });
    }
  }
  return { hunk: { A, oldLines, newLines, backslashAfterLast, backslashAfterLastPlus }, next: j };
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(file: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let cur: FileLines = { lines: file.lines.slice(), br: file.br, final: file.final };
  let d = 0;
  for (const h of hunks) {
    const O = h.oldLines;
    const N = h.newLines;
    if (O.length === 0) {
      const ins = Math.min(Math.max(h.A + d, 0), cur.lines.length);
      const out = [...cur.lines.slice(0, ins), ...N.map((n) => n.text), ...cur.lines.slice(ins)];
      let final = cur.final;
      if (ins === cur.lines.length) final = !h.backslashAfterLast;
      cur = { lines: out, br: cur.br, final };
      d += N.length;
      continue;
    }
    const found = findTier(O, cur.lines, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const touchesEnd = pos + O.length === cur.lines.length;
    const out = applyReplace(cur.lines, pos, O, N, found.tier);
    let final = cur.final;
    if (touchesEnd) {
      if (N.length === 0) final = out.length > 0;
      else final = !h.backslashAfterLast;
    }
    cur = { lines: out, br: cur.br, final };
    d += N.length - O.length;
  }
  return cur;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  const blankSection = (): UnifiedSection => ({
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const finish = (): void => {
    if (cur) sections.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        const m = /^diff --git a\/(.+?) b\/(.+?)\s*$/.exec(line);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        cur = blankSection();
        cur.diffOld = m[1]!;
        cur.diffNew = m[2]!;
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = blankSection();
        // The header state below consumes the pair.
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
      continue;
    }
    if (cur.hunks.length === 0) {
      // Section header: before its first hunk.
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
          cur.hasPair = true;
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (line.startsWith('diff --git ')) {
        finish();
      } else if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
      } else if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
      } else {
        i++;
      }
    } else {
      // Between hunks.
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
      } else if (line.startsWith('diff --git ')) {
        finish();
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finish();
      } else {
        i++;
      }
    }
  }
  finish();
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  const oldPath = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
  const newPath = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.diffNew);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (oldPath === null && newPath === null) return;
    const isCreation = oldPath === null || sec.newFile;
    const isDeletion = newPath === null || sec.deletedFile;
    if (isCreation) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const nl of h.newLines) if (nl.ctx === undefined) plus.push(nl.text);
      }
      let backslash = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.newLines.some((nl) => nl.ctx === undefined)) {
          backslash = h.backslashAfterLastPlus;
          break;
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (backslash ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) return;
    const curText = tree.get(oldPath);
    if (curText === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const result = applyHunks(splitFile(curText), sec.hunks, strict, oldPath);
    const text = joinFile(result);
    if (oldPath !== newPath) {
      tree.now.set(newPath, text);
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let j = searchLine + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      j++;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    j = sep + 1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      j++;
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(oldLines, f.lines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const N: NewLine[] = newLines.map((t) => ({ text: t }));
    const out = applyReplace(f.lines, found.pos[0]!, oldLines, N, found.tier);
    tree.now.set(path, joinFile({ lines: out, br: f.br, final: f.final }));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  oldLines: string[];
  newLines: NewLine[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerNo = i + 1;
    i++;
    const secStart = i;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      i++;
    }
    let secEnd = i;
    while (secEnd > secStart && blank(lines[secEnd - 1]!)) secEnd--;
    const secLines = lines.slice(secStart, secEnd);
    const secNos = secLines.map((_, k) => secStart + k + 1);
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${secNos[k]}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = 0; k < secLines.length; k++) {
        if (!blank(secLines[k]!)) throw new Exit2(`error: parse ${secNos[k]}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, secLines, secNos, headerNo, strict));
    }
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, secLines: string[], secNos: number[], headerNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.slice(13).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
  let seenChunk = false;
  const flush = (): void => {
    if (!cur) return;
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const b of cur.body) {
      if (b === '' || b.startsWith(' ')) {
        const text = b === '' ? '' : b.slice(1);
        oldLines.push(text);
        newLines.push({ text, ctx: oldLines.length - 1 });
      } else if (b.startsWith('-')) {
        oldLines.push(b.slice(1));
      } else if (b.startsWith('+')) {
        newLines.push({ text: b.slice(1) });
      }
    }
    chunks.push({ anchor: cur.anchor, oldLines, newLines, eof: cur.eof });
    cur = null;
  };
  for (; idx < secLines.length; idx++) {
    const l = secLines[idx]!;
    const no = secNos[idx]!;
    if (l.startsWith('@@')) {
      flush();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      seenChunk = true;
    } else if (l === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      flush();
    } else if (l.startsWith('*** ')) {
      throw new Exit2(`error: parse ${no}`);
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (!cur) {
        if (seenChunk) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, body: [], eof: false };
        seenChunk = true;
      }
      cur.body.push(l);
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], f.lines, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const O = ch.oldLines;
      const N = ch.newLines;
      if (O.length === 0) {
        const ins = ch.eof ? f.lines.length : cursor;
        const out = [...f.lines.slice(0, ins), ...N.map((n) => n.text), ...f.lines.slice(ins)];
        f = { lines: out, br: f.br, final: f.final };
        cursor = ins + N.length;
      } else {
        const found = findTier(O, f.lines, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        let positions = found.pos;
        if (ch.eof) positions = positions.filter((p) => p + O.length === f.lines.length);
        if (positions.length === 0) throw new Fail('no-match', path);
        const pos = positions[0]!;
        const out = applyReplace(f.lines, pos, O, N, found.tier);
        f = { lines: out, br: f.br, final: f.final };
        cursor = pos + N.length;
      }
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 10: order and atomicity; sections 1 and 2: invocation and output.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
