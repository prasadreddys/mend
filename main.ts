// mend: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a
// tree of text files, exactly as SPEC.md says. Node 22, standard library
// only; run as `node main.ts [options] [PATCH]`.
//
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set:
// in a trial the kit's runner reads the checks from the env and runs this
// file on each one. Keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse or usage failure that ends the run with exit 2 and one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, . or .. */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of paths, as UTF-8. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines: its own break, its lines, and whether it ends with a break. */
interface FileView {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileView {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line's key at a matching tier: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where old lines O occur in the file's lines at a tier, from `from`, optionally only ending at the last line. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const want = o.map((l) => tierKey(l, tier));
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs, with its positions. */
function firstTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const occ = occurrences(lines, o, tier, from, eofOnly);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of a replacement: a context line (taken from the file at its O index) or an added line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Re-indent an added line at tier 2: P (O's first line's lead) replaced by F (the file's first matched line's lead). */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** Replace the k matched lines at pos with N: context lines come from the file, added lines as written (re-indented at tier 2). */
function applyMatch(lines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = lines[pos] === undefined ? '' : leadingWs(lines[pos]!);
  const p = o.length === 0 ? '' : leadingWs(o[0]!);
  const written: string[] = [];
  for (const item of n) {
    if (item.ctx !== null) written.push(lines[pos + item.ctx]!);
    else if (tier === 2) written.push(reindent(item.text, p, f));
    else written.push(item.text);
  }
  return [...lines.slice(0, pos), ...written, ...lines.slice(pos + o.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; next: string }> = [];

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

/** Read a file the edit needs, failing missing when it is not there. */
function needFile(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

/** Detect the patch's format: v4a, json, search-replace, unified, in that order, or null. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = needFile(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = needFile(tree, p);
      const view = splitFile(before);
      if (line < 0 || line > view.lines.length) throw new Fail('no-match', p);
      const lines = [...view.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, view.br, view.final));
    };
  }
  return null;
}

/** The JSON edits of a patch: one array, or one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
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
    if (isBlank(l)) return;
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

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  plus: string[];
  lastNNoEol: boolean;
  lastPlusNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameOld: string | null;
  renameNew: string | null;
}

/** A `--- `/`+++ ` path: text after four characters, up to the first tab, spaces off, a/b prefix off, /dev/null as no file. */
function sectionPath(raw: string): string | null {
  let p = raw;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** The paths of a `diff --git a/<X> b/<Y>` line, or a parse error at its line. */
function diffGitPaths(line: string, n: number): [string, string] {
  const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${n}`);
  return [m[1]!, m[2]!];
}

/** A hunk header's A value, or a parse error at its line. */
function hunkA(line: string, n: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${n}`);
  return Number(m[1]);
}

/** A hunk's body: lines starting with space, -, + or \, or empty; ends at a diff --git line, a ---/+++ pair, or any other line. */
function readBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
      body.push(line);
      i += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function makeHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  const plus: string[] = [];
  let lastN = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const line = body[k]!;
    if (line === '' || line.startsWith(' ')) {
      const t = line === '' ? '' : line.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
      lastN = k;
    } else if (line.startsWith('-')) {
      o.push(line.slice(1));
    } else if (line.startsWith('+')) {
      const t = line.slice(1);
      plus.push(t);
      n.push({ text: t, ctx: null });
      lastN = k;
      lastPlus = k;
    }
  }
  const followsBs = (k: number): boolean => k >= 0 && k + 1 < body.length && body[k + 1]!.startsWith('\\');
  return { a, o, n, plus, lastNNoEol: followsBs(lastN), lastPlusNoEol: followsBs(lastPlus) };
}

function freshSection(): Section {
  return {
    oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [],
    diffOld: null, diffNew: null, pairOld: null, pairNew: null, hasPair: false,
    renameOld: null, renameNew: null,
  };
}

/** The sections of a unified patch, in order. */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'out' | 'header' | 'after' = 'out';
  const startGitSection = (line: string, n: number): void => {
    const [x, y] = diffGitPaths(line, n);
    cur = freshSection();
    cur.diffOld = x;
    cur.diffNew = y;
    sections.push(cur);
    state = 'header';
  };
  const startBareSection = (i: number): void => {
    cur = freshSection();
    cur.pairOld = sectionPath(headerPath(lines[i]!));
    cur.pairNew = sectionPath(headerPath(lines[i + 1]!));
    cur.hasPair = true;
    sections.push(cur);
    state = 'header';
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'out') {
      if (line.startsWith('diff --git ')) {
        startGitSection(line, i + 1);
        i += 1;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startBareSection(i);
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else i += 1;
    } else if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        startGitSection(line, i + 1);
        i += 1;
      } else if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.pairOld = sectionPath(headerPath(line));
          cur!.pairNew = sectionPath(headerPath(lines[i + 1]!));
          cur!.hasPair = true;
          i += 2;
        } else throw new Exit2(`error: parse ${i + 2}`);
      } else if (line.startsWith('@@')) {
        const a = hunkA(line, i + 1);
        const read = readBody(lines, i + 1);
        cur!.hunks.push(makeHunk(a, read.body));
        i = read.next;
        state = 'after';
      } else if (line.startsWith('rename from ')) {
        const p = line.slice('rename from '.length).trim();
        cur!.renameOld = p === '/dev/null' ? null : p;
        i += 1;
      } else if (line.startsWith('rename to ')) {
        const p = line.slice('rename to '.length).trim();
        cur!.renameNew = p === '/dev/null' ? null : p;
        i += 1;
      } else if (line.startsWith('new file mode')) {
        cur!.isCreate = true;
        i += 1;
      } else if (line.startsWith('deleted file mode')) {
        cur!.isDelete = true;
        i += 1;
      } else i += 1;
    } else {
      if (line.startsWith('diff --git ')) {
        startGitSection(line, i + 1);
        i += 1;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startBareSection(i);
        i += 2;
      } else if (line.startsWith('@@')) {
        const a = hunkA(line, i + 1);
        const read = readBody(lines, i + 1);
        cur!.hunks.push(makeHunk(a, read.body));
        i = read.next;
      } else i += 1;
    }
  }
  for (const s of sections) {
    s.oldPath = s.hasPair ? s.pairOld : (s.renameOld ?? s.diffOld);
    s.newPath = s.hasPair ? s.pairNew : (s.renameNew ?? s.diffNew);
  }
  return sections;
}

/** Apply a section's hunks in order to a file's lines, tracking the running offset d. */
function applyHunks(lines: string[], final: boolean, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; final: boolean } {
  let cur = lines;
  let curFinal = final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > cur.length) idx = cur.length;
      const touchesEnd = idx === cur.length;
      cur = [...cur.slice(0, idx), ...h.plus, ...cur.slice(idx)];
      if (touchesEnd) curFinal = !h.lastNNoEol;
      d += h.plus.length;
    } else {
      const found = firstTier(cur, h.o, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const touchesEnd = best + h.o.length === cur.length;
      cur = applyMatch(cur, best, h.o, h.n, found.tier);
      if (touchesEnd) curFinal = !h.lastNNoEol;
      d += h.n.length - h.o.length;
    }
  }
  return { lines: cur, final: curFinal };
}

/** One unified section as one edit. */
function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const kind = oldP === null || s.isCreate ? 'create' : newP === null || s.isDelete ? 'delete' : oldP !== newP ? 'move' : 'change';
    if (kind === 'create') {
      if (newP === null) return;
      if (!safePath(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastNoEol = false;
      let hasPlus = false;
      for (const h of s.hunks) {
        if (h.plus.length > 0) {
          hasPlus = true;
          lastNoEol = h.lastPlusNoEol;
        }
        plus.push(...h.plus);
      }
      tree.now.set(newP, hasPlus ? plus.join('\n') + (lastNoEol ? '' : '\n') : '');
      return;
    }
    if (kind === 'delete') {
      if (oldP === null) return;
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (kind === 'move') {
      const op = oldP!;
      const np = newP!;
      if (!safePath(op)) throw new Fail('unsafe', op);
      if (!safePath(np)) throw new Fail('unsafe', np);
      const before = needFile(tree, op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const view = splitFile(before);
      const done = applyHunks(view.lines, view.final, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, joinFile(done.lines, view.br, done.final));
      tree.moves.push({ old: op, next: np });
      return;
    }
    const p = oldP!;
    if (!safePath(p)) throw new Fail('unsafe', p);
    const before = needFile(tree, p);
    const view = splitFile(before);
    const done = applyHunks(view.lines, view.final, s.hunks, strict, p);
    tree.now.set(p, joinFile(done.lines, view.br, done.final));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

const isSearchLine = (l: string): boolean => l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH';
const isEqLine = (l: string): boolean => l.replace(/[ \t]+$/, '') === '=======';
const isReplaceLine = (l: string): boolean => l.replace(/[ \t]+$/, '') === '>>>>>>> REPLACE';

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = needFile(tree, path);
    const view = splitFile(before);
    const found = firstTier(view.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    tree.now.set(path, joinFile(applyMatch(view.lines, pos, oldLines, n, found.tier), view.br, view.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearchLine(lines[i]!)) {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isEqLine(lines[j]!)) {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (isReplaceLine(lines[j]!)) {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

function buildV4aChunk(anchor: string | null, body: string[], eof: boolean): V4aChunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const line of body) {
    if (line === '' || line.startsWith(' ')) {
      const t = line === '' ? '' : line.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (line.startsWith('-')) {
      o.push(line.slice(1));
    } else if (line.startsWith('+')) {
      n.push({ text: line.slice(1), ctx: null });
    }
  }
  return { anchor, o, n, eof };
}

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, raw: string[], baseLine: number, updateLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${baseLine + k}`);
    }
    return (tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${baseLine}`);
    return (tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
  let sawChunk = false;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(buildV4aChunk(cur.anchor, cur.body, cur.eof));
      cur = null;
    }
  };
  for (let k = idx; k < raw.length; k += 1) {
    const l = raw[k]!;
    const n = baseLine + k;
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      sawChunk = true;
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${n}`);
      cur.eof = true;
      closeChunk();
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (sawChunk) throw new Exit2(`error: parse ${n}`);
        cur = { anchor: null, body: [], eof: false };
        sawChunk = true;
      }
      cur.body.push(l);
    } else {
      throw new Exit2(`error: parse ${n}`);
    }
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = needFile(tree, path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const view = splitFile(before);
    let curLines = view.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let foundIdx = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && foundIdx < 0; t += 1) {
          for (let j = cursor; j < curLines.length; j += 1) {
            if (tierKey(curLines[j]!, t) === tierKey(chunk.anchor!, t)) {
              foundIdx = j;
              break;
            }
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? curLines.length : cursor;
        const added = chunk.n.map((x) => x.text);
        curLines = [...curLines.slice(0, at), ...added, ...curLines.slice(at)];
        cursor = at + added.length;
      } else {
        const found = firstTier(curLines, chunk.o, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        curLines = applyMatch(curLines, pos, chunk.o, chunk.n, found.tier);
        cursor = pos + chunk.n.length;
      }
    }
    const out = joinFile(curLines, view.br, view.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, next: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!isBlank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else throw new Exit2(`error: parse ${i + 1}`);
    const updateLine = i + 1;
    const start = i + 1;
    let end = start;
    while (end < last) {
      const l = lines[end]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      end += 1;
    }
    const raw = lines.slice(start, end);
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
    edits.push(v4aEdit(kind, path, raw, start + 1, updateLine, strict));
    i = end;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Invocation, output and exit codes (SPEC.md sections 1 and 2) ---- */

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
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
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const handled = new Set<string>();
  const seenMoves = new Set<string>();
  for (const m of tree.moves) {
    const mk = `${m.old} ${m.next}`;
    if (seenMoves.has(mk)) continue;
    seenMoves.add(mk);
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.next);
    const nowNew = tree.get(m.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      handled.add(m.old);
      handled.add(m.next);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    const dels = [...tree.now.keys()].filter((p) => tree.now.get(p) === null).sort(byteOrder);
    const writes = [...tree.now.keys()].filter((p) => tree.now.get(p) !== null).sort(byteOrder);
    for (const p of dels) {
      if (tree.original(p) !== null) rmSync(p, { force: true });
    }
    // A deleted file can leave an empty directory where a created file must go.
    for (const p of dels) {
      let dir = dirname(p);
      while (dir !== '.' && dir !== '') {
        try {
          if (readdirSync(dir).length !== 0) break;
          rmdirSync(dir);
        } catch {
          break;
        }
        dir = dirname(dir);
      }
    }
    for (const p of writes) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
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
