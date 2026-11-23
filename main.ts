// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE, V4A patch, JSON tool calls) to a tree of
// text files, exactly as SPEC.md says. Node 22, standard library only.

import { mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Files as lines
// ---------------------------------------------------------------------------

interface FileRec {
  lines: string[];
  ends: boolean;
  br: string;
}

function parseText(text: string): FileRec {
  if (text === '') return { lines: [], ends: false, br: '\n' };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let ends = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    ends = true;
  }
  return { lines: parts, ends, br };
}

function serializeText(f: FileRec): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

// A patch's lines: split at \n, one trailing \r removed from each, and the
// empty piece after a final \n dropped.
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// The tree on disk
// ---------------------------------------------------------------------------

type Tree = Map<string, FileRec>;

function readTree(root: string): Tree {
  const out: Tree = new Map();
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        const rel = p.slice(root.length + 1).split(sep).join('/');
        out.set(rel, parseText(readFileSync(p, 'utf8')));
      }
    }
  };
  walk(root);
  return out;
}

function writeTree(root: string, initial: Tree, finalTree: Tree): void {
  // Deletions first, so a path that was a file can become a directory and
  // a directory that held a moved file can become a file.
  const removed: string[] = [];
  for (const p of initial.keys()) {
    if (!finalTree.has(p)) {
      rmSync(join(root, ...p.split('/')), { force: true });
      removed.push(p);
    }
  }
  // Drop directories left empty by the deletions, deepest first.
  const dirs = new Set<string>();
  for (const p of removed) {
    let d = dirname(p);
    while (d !== '.' && d !== '') {
      dirs.add(d);
      d = dirname(d);
    }
  }
  const sortedDirs = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const d of sortedDirs) {
    try {
      rmdirSync(join(root, ...d.split('/')));
    } catch {
      // Still holds files: leave it.
    }
  }
  for (const [p, f] of finalTree) {
    const before = initial.get(p);
    if (before !== undefined && serializeText(before) === serializeText(f)) continue;
    const target = join(root, ...p.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, serializeText(f));
  }
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5)
// ---------------------------------------------------------------------------

function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrencesAt(fileLines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!tierEqual(fileLines[i + j], oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

function findTier(fileLines: string[], oldLines: string[], strict: boolean, from = 0): TierHit | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = occurrencesAt(fileLines, oldLines, tier).filter((i) => i >= from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

// One line of an old/new pair. Context lines are the same object in both
// the O list and the N list, so a context line can be found in O by identity.
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  bs: boolean;
}

function mapNewLines(
  nItems: BodyItem[],
  oItems: BodyItem[],
  fileLines: string[],
  occPos: number,
  tier: number,
): string[] {
  const f = fileLines.length > 0 ? leadOf(fileLines[occPos]) : '';
  const p = oItems.length > 0 ? leadOf(oItems[0].text) : '';
  return nItems.map((item) => {
    if (item.kind === 'ctx') {
      const oi = oItems.indexOf(item);
      return fileLines[occPos + oi];
    }
    if (tier === 2) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) {
        return f + t.slice(p.length);
      }
      return t;
    }
    return item.text;
  });
}

function lastCtxOrNewBackslash(body: BodyItem[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k].kind === 'ctx' || body[k].kind === 'new') return body[k].bs;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

class ParseErr extends Error {
  n: number;
  constructor(n: number) {
    super(`parse ${n}`);
    this.n = n;
  }
}

type Fail = { ok: false; code: string; path: string };
type EditResult = { ok: true; moves: { old: string; nw: string }[] } | Fail;

function fail(code: string, path: string): Fail {
  return { ok: false, code, path };
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface UnifiedSection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

function diffPath(raw: string): string | null {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let pairDone = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (!m) throw new ParseErr(i + 1);
      cur = { oldPath: m[1], newPath: m[2], createFlag: false, deleteFlag: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      pairDone = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader && !pairDone) {
        cur.oldPath = diffPath(line);
        cur.newPath = diffPath(lines[i + 1]);
        pairDone = true;
      } else {
        cur = { oldPath: diffPath(line), newPath: diffPath(lines[i + 1]), createFlag: false, deleteFlag: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        pairDone = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new ParseErr(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseErr(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new ParseErr(i + 1);
      const a = parseInt(m[1], 10);
      inHeader = false;
      i++;
      const body: BodyItem[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (l === '') {
          body.push({ kind: 'ctx', text: '', bs: false });
          i++;
          continue;
        }
        if (l[0] === ' ') {
          body.push({ kind: 'ctx', text: l.slice(1), bs: false });
          i++;
          continue;
        }
        if (l[0] === '-') {
          body.push({ kind: 'old', text: l.slice(1), bs: false });
          i++;
          continue;
        }
        if (l[0] === '+') {
          body.push({ kind: 'new', text: l.slice(1), bs: false });
          i++;
          continue;
        }
        if (l[0] === '\\') {
          if (body.length > 0) body[body.length - 1].bs = true;
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1].kind === 'ctx' && body[body.length - 1].text === '') {
        body.pop();
      }
      cur.hunks.push({ a, body });
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        // A lone +++ line in a header (no --- before it: a ---/+++ pair is
        // consumed earlier) still names the new path.
        cur.newPath = diffPath(line);
      } else if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.createFlag = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deleteFlag = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

// Apply a section's hunks to a file's lines. Returns the new record, or
// 'no-match' when a hunk's old lines are nowhere in the file.
function applyHunks(file: FileRec, hunks: Hunk[], strict: boolean): FileRec | 'no-match' {
  let lines = [...file.lines];
  let ends = file.ends;
  let d = 0;
  for (const h of hunks) {
    const o = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'old');
    const n = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'new');
    const lastBs = lastCtxOrNewBackslash(h.body);
    if (o.length > 0) {
      const oTexts = o.map((x) => x.text);
      const found = findTier(lines, oTexts, strict);
      if (found === null) return 'no-match';
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === lines.length;
      const mapped = mapNewLines(n, o, lines, best, found.tier);
      lines = [...lines.slice(0, best), ...mapped, ...lines.slice(best + o.length)];
      if (atEnd) ends = !lastBs;
      if (lines.length === 0) ends = false;
      d += n.length - o.length;
    } else {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      const ins = n.map((x) => x.text);
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      if (atEnd) ends = !lastBs;
      if (lines.length === 0) ends = false;
      d += n.length;
    }
  }
  return { lines, ends, br: file.br };
}

function applyUnified(tree: Tree, sec: UnifiedSection, strict: boolean): EditResult {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if (oldP !== undefined && oldP !== null && !isSafePath(oldP)) return fail('unsafe', oldP);
  if (newP !== undefined && newP !== null && !isSafePath(newP)) return fail('unsafe', newP);
  const isCreate = oldP === null || sec.createFlag;
  const isDelete = newP === null || sec.deleteFlag;
  if (isCreate && isDelete) return { ok: true, moves: [] };
  if (isCreate) {
    const path = newP as string;
    if (tree.has(path)) return fail('exists', path);
    const plus: string[] = [];
    for (const h of sec.hunks) {
      for (const b of h.body) {
        if (b.kind === 'new') plus.push(b.text);
      }
    }
    // A created file ends with a line break unless a `\` line follows its
    // last `+` line: scan the hunks backwards for that line.
    let lastBs = false;
    outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
      const body = sec.hunks[hi].body;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k].kind === 'new') {
          lastBs = body[k].bs;
          break outer;
        }
      }
    }
    const rec: FileRec = { lines: plus, ends: plus.length > 0 ? !lastBs : false, br: '\n' };
    tree.set(path, rec);
    return { ok: true, moves: [] };
  }
  if (isDelete) {
    const path = oldP as string;
    if (!tree.has(path)) return fail('missing', path);
    tree.delete(path);
    return { ok: true, moves: [] };
  }
  if (oldP !== undefined && newP !== undefined && oldP !== null && newP !== null && oldP !== newP) {
    if (!tree.has(oldP)) return fail('missing', oldP);
    if (tree.has(newP)) return fail('exists', newP);
    const src = tree.get(oldP) as FileRec;
    const out = applyHunks(src, sec.hunks, strict);
    if (out === 'no-match') return fail('no-match', oldP);
    tree.delete(oldP);
    tree.set(newP, out);
    return { ok: true, moves: [{ old: oldP, nw: newP }] };
  }
  const path = (oldP ?? newP) as string;
  if (!tree.has(path)) return fail('missing', path);
  const src = tree.get(path) as FileRec;
  const out = applyHunks(src, sec.hunks, strict);
  if (out === 'no-match') return fail('no-match', path);
  tree.set(path, out);
  return { ok: true, moves: [] };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

interface SREdit {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SREdit[] {
  const edits: SREdit[] = [];
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (stripTrailing(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j];
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (edits.length > 0) path = edits[edits.length - 1].path;
      else throw new ParseErr(searchIdx + 1);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = stripTrailing(lines[j]);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new ParseErr(searchIdx + 1);
    let gt = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (stripTrailing(lines[j]) === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (gt === -1) throw new ParseErr(searchIdx + 1);
    edits.push({
      path,
      oldLines: lines.slice(searchIdx + 1, eq),
      newLines: lines.slice(eq + 1, gt),
    });
    prevEnd = gt + 1;
    i = gt + 1;
  }
  return edits;
}

function applySearchReplace(tree: Tree, edit: SREdit, strict: boolean): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (edit.oldLines.length === 0) {
    if (tree.has(edit.path)) return fail('exists', edit.path);
    const rec: FileRec = { lines: [...edit.newLines], ends: edit.newLines.length > 0, br: '\n' };
    tree.set(edit.path, rec);
    return { ok: true, moves: [] };
  }
  if (!tree.has(edit.path)) return fail('missing', edit.path);
  const file = tree.get(edit.path) as FileRec;
  const found = findTier(file.lines, edit.oldLines, strict);
  if (found === null) return fail('no-match', edit.path);
  if (found.occ.length > 1) return fail('ambiguous', edit.path);
  const pos = found.occ[0];
  const oItems: BodyItem[] = edit.oldLines.map((t) => ({ kind: 'old' as const, text: t, bs: false }));
  const nItems: BodyItem[] = edit.newLines.map((t) => ({ kind: 'new' as const, text: t, bs: false }));
  const mapped = mapNewLines(nItems, oItems, file.lines, pos, found.tier);
  const lines = [...file.lines.slice(0, pos), ...mapped, ...file.lines.slice(pos + edit.oldLines.length)];
  tree.set(edit.path, { lines, ends: lines.length === 0 ? false : file.ends, br: file.br });
  return { ok: true, moves: [] };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
  updateLine: number;
}

function parseV4A(lines: string[]): V4ASection[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const sections: V4ASection[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new ParseErr(i + 1);
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      i++;
      while (i < last && !isSectionStart(lines[i])) {
        const l = lines[i];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new ParseErr(i + 1);
        i++;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      sections.push({ kind: 'add', path, lines: fileLines, moveTo: null, chunks: [], updateLine: 0 });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path, lines: [], moveTo: null, chunks: [], updateLine: 0 });
      i++;
      continue;
    }
    // Update File
    const path = line.slice('*** Update File: '.length).trim();
    const updateLine = i + 1;
    i++;
    let moveTo: string | null = null;
    if (i < last && lines[i].startsWith('*** Move to: ')) {
      moveTo = lines[i].slice('*** Move to: '.length).trim();
      i++;
    }
    const chunks: V4AChunk[] = [];
    let cur: V4AChunk | null = null;
    let firstChunk = true;
    while (i < last && !isSectionStart(lines[i])) {
      const l = lines[i];
      if (l === '*** End of File') {
        if (cur === null) throw new ParseErr(i + 1);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        const anchorText = l.slice(2).trim();
        cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
        firstChunk = false;
        i++;
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (cur === null) {
          if (!firstChunk) throw new ParseErr(i + 1);
          cur = { anchor: null, body: [], eof: false };
          firstChunk = false;
        }
        if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), bs: false });
        else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1), bs: false });
        else cur.body.push({ kind: 'new', text: l.slice(1), bs: false });
        i++;
        continue;
      }
      if (l === '') {
        if (cur === null) {
          if (firstChunk && chunks.length === 0) {
            cur = { anchor: null, body: [], eof: false };
            firstChunk = false;
          } else {
            // A blank line after a closed chunk: a blank at the end of the
            // section, not part of it.
            i++;
            continue;
          }
        }
        cur.body.push({ kind: 'ctx', text: '', bs: false });
        i++;
        continue;
      }
      throw new ParseErr(i + 1);
    }
    if (cur !== null) chunks.push(cur);
    // Blank lines at the end of a section are not part of it.
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1];
      while (
        lastChunk.body.length > 0 &&
        lastChunk.body[lastChunk.body.length - 1].kind === 'ctx' &&
        lastChunk.body[lastChunk.body.length - 1].text === ''
      ) {
        lastChunk.body.pop();
      }
    }
    if (chunks.length === 0 && moveTo === null) throw new ParseErr(updateLine);
    sections.push({ kind: 'update', path, lines: [], moveTo, chunks, updateLine });
  }
  return sections;
}

function applyV4A(tree: Tree, sec: V4ASection, strict: boolean): EditResult {
  if (!isSafePath(sec.path)) return fail('unsafe', sec.path);
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return fail('unsafe', sec.moveTo);
  if (sec.kind === 'add') {
    if (tree.has(sec.path)) return fail('exists', sec.path);
    const rec: FileRec = { lines: [...sec.lines], ends: sec.lines.length > 0, br: '\n' };
    tree.set(sec.path, rec);
    return { ok: true, moves: [] };
  }
  if (sec.kind === 'delete') {
    if (!tree.has(sec.path)) return fail('missing', sec.path);
    tree.delete(sec.path);
    return { ok: true, moves: [] };
  }
  if (!tree.has(sec.path)) return fail('missing', sec.path);
  if (sec.moveTo !== null && tree.has(sec.moveTo)) return fail('exists', sec.moveTo);
  const file = tree.get(sec.path) as FileRec;
  let lines = [...file.lines];
  let cursor = 0;
  for (const chunk of sec.chunks) {
    if (chunk.anchor !== null) {
      const hit = findTier(lines, [chunk.anchor], strict, cursor);
      if (hit === null) return fail('no-match', sec.path);
      cursor = hit.occ[0] + 1;
    }
    const o = chunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'old');
    const n = chunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'new');
    if (o.length > 0) {
      const oTexts = o.map((x) => x.text);
      const hit = findTier(lines, oTexts, strict, cursor);
      if (hit === null) return fail('no-match', sec.path);
      let pos = -1;
      for (const p of hit.occ) {
        if (chunk.eof && p + o.length !== lines.length) continue;
        pos = p;
        break;
      }
      if (pos === -1) return fail('no-match', sec.path);
      const mapped = mapNewLines(n, o, lines, pos, hit.tier);
      lines = [...lines.slice(0, pos), ...mapped, ...lines.slice(pos + o.length)];
      cursor = pos + mapped.length;
    } else {
      const pos = chunk.eof ? lines.length : cursor;
      const ins = n.map((x) => x.text);
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      cursor = pos + ins.length;
    }
  }
  const rec: FileRec = { lines, ends: lines.length === 0 ? false : file.ends, br: file.br };
  if (sec.moveTo !== null) {
    tree.delete(sec.path);
    tree.set(sec.moveTo, rec);
    return { ok: true, moves: [{ old: sec.path, nw: sec.moveTo }] };
  }
  tree.set(sec.path, rec);
  return { ok: true, moves: [] };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

type JSONEdit =
  | { command: 'create'; path: string; fileText: string }
  | { command: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { command: 'insert'; path: string; insertLine: number; newStr: string };

function validateJSONEdit(obj: unknown, lineNo: number): JSONEdit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseErr(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseErr(lineNo);
  if (typeof o.command !== 'string') throw new ParseErr(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseErr(lineNo);
    return { command: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseErr(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseErr(lineNo);
    return { command: 'str_replace', path: o.path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (!Number.isInteger(o.insert_line)) throw new ParseErr(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseErr(lineNo);
    return { command: 'insert', path: o.path, insertLine: o.insert_line as number, newStr: o.new_str };
  }
  throw new ParseErr(lineNo);
}

function parseJSON(patchText: string, patchLines: string[]): JSONEdit[] {
  const firstNonWs = patchText.search(/\S/);
  if (firstNonWs === -1) throw new ParseErr(1);
  if (patchText[firstNonWs] === '[') {
    const startLine = patchText.slice(0, firstNonWs).split('\n').length;
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseErr(startLine);
    }
    if (!Array.isArray(arr)) throw new ParseErr(startLine);
    const edits = arr.map((obj) => validateJSONEdit(obj, startLine));
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  const edits: JSONEdit[] = [];
  for (let idx = 0; idx < patchLines.length; idx++) {
    const line = patchLines[idx];
    if (line.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseErr(idx + 1);
    }
    edits.push(validateJSONEdit(obj, idx + 1));
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function applyJSON(tree: Tree, edit: JSONEdit): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (edit.command === 'create') {
    if (tree.has(edit.path)) return fail('exists', edit.path);
    tree.set(edit.path, parseText(edit.fileText));
    return { ok: true, moves: [] };
  }
  if (!tree.has(edit.path)) return fail('missing', edit.path);
  const file = tree.get(edit.path) as FileRec;
  if (edit.command === 'str_replace') {
    let text = serializeText(file);
    let oldS = edit.oldStr;
    let newS = edit.newStr;
    const crlf = file.br === '\r\n';
    if (crlf) {
      text = text.replace(/\r\n/g, '\n');
      oldS = oldS.replace(/\r\n/g, '\n');
      newS = newS.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let firstPos = -1;
    let at = 0;
    for (;;) {
      const found = text.indexOf(oldS, at);
      if (found === -1) break;
      if (firstPos === -1) firstPos = found;
      count++;
      at = found + 1;
    }
    if (count === 0) return fail('no-match', edit.path);
    if (count > 1) return fail('ambiguous', edit.path);
    let result = text.slice(0, firstPos) + newS + text.slice(firstPos + oldS.length);
    if (crlf) result = result.replace(/\n/g, '\r\n');
    tree.set(edit.path, parseText(result));
    return { ok: true, moves: [] };
  }
  // insert
  if (edit.insertLine < 0 || edit.insertLine > file.lines.length) return fail('no-match', edit.path);
  const ins = splitNewStr(edit.newStr);
  const lines = [...file.lines];
  lines.splice(edit.insertLine, 0, ...ins);
  tree.set(edit.path, { lines, ends: lines.length === 0 ? false : file.ends, br: file.br });
  return { ok: true, moves: [] };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4) and the driver (sections 1, 2, 10)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const firstNonBlank = lines.find((l) => l.trim() !== '');
  if (firstNonBlank !== undefined) {
    if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (stripTrailing(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function printAndExit(lines: string[], code: number): never {
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(code);
}

function computeOutput(initial: Tree, finalTree: Tree, moves: { old: string; nw: string }[]): string[] {
  const rPairs = moves.filter(
    (m) => initial.has(m.old) && !finalTree.has(m.old) && !initial.has(m.nw) && finalTree.has(m.nw),
  );
  const rOlds = new Set(rPairs.map((m) => m.old));
  const rNews = new Set(rPairs.map((m) => m.nw));
  const rows: { key: string; line: string }[] = [];
  for (const [p, f] of finalTree) {
    if (rNews.has(p)) continue;
    if (!initial.has(p)) {
      rows.push({ key: p, line: `A ${p}` });
    } else if (serializeText(initial.get(p) as FileRec) !== serializeText(f)) {
      rows.push({ key: p, line: `M ${p}` });
    }
  }
  for (const p of initial.keys()) {
    if (rOlds.has(p)) continue;
    if (!finalTree.has(p)) rows.push({ key: p, line: `D ${p}` });
  }
  for (const m of rPairs) rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
  rows.sort((a, b) => cmpBytes(a.key, b.key));
  const out = rows.map((r) => r.line);
  out.push(rows.length === 1 ? 'ok: 1 file' : `ok: ${rows.length} files`);
  return out;
}

function main(): never {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positionals: string[] = [];
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) printAndExit(['error: usage'], 2);
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) printAndExit(['error: usage'], 2);
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) printAndExit(['error: usage'], 2);
        seenFormat = true;
        format = a.slice('--format='.length);
        if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(format)) {
          printAndExit(['error: usage'], 2);
        }
      } else {
        printAndExit(['error: usage'], 2);
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 1) printAndExit(['error: usage'], 2);

  let patchText: string;
  if (positionals.length === 1 && positionals[0] !== '-') {
    try {
      patchText = readFileSync(positionals[0], 'utf8');
    } catch {
      printAndExit(['error: no-patch'], 2);
    }
  } else {
    patchText = readFileSync(0, 'utf8');
  }
  const patchLines = splitPatchLines(patchText);

  let fmt = format ?? 'auto';
  if (fmt === 'auto') {
    const detected = detectFormat(patchLines);
    if (detected === null) printAndExit(['error: format'], 2);
    fmt = detected;
  }

  let edits: { kind: string; edit: unknown }[] = [];
  try {
    if (fmt === 'unified') {
      edits = parseUnified(patchLines).map((e) => ({ kind: 'unified', edit: e }));
    } else if (fmt === 'search-replace') {
      edits = parseSearchReplace(patchLines).map((e) => ({ kind: 'search-replace', edit: e }));
    } else if (fmt === 'v4a') {
      edits = parseV4A(patchLines).map((e) => ({ kind: 'v4a', edit: e }));
    } else {
      edits = parseJSON(patchText, patchLines).map((e) => ({ kind: 'json', edit: e }));
    }
  } catch (e) {
    if (e instanceof ParseErr) printAndExit([`error: parse ${e.n}`], 2);
    throw e;
  }
  if (edits.length === 0) printAndExit(['error: parse 1'], 2);

  const root = process.cwd();
  const initial = readTree(root);
  const working: Tree = new Map();
  for (const [p, f] of initial) working.set(p, { lines: [...f.lines], ends: f.ends, br: f.br });

  const failures: { code: string; path: string }[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const { kind, edit } of edits) {
    let result: EditResult;
    if (kind === 'unified') result = applyUnified(working, edit as UnifiedSection, strict);
    else if (kind === 'search-replace') result = applySearchReplace(working, edit as SREdit, strict);
    else if (kind === 'v4a') result = applyV4A(working, edit as V4ASection, strict);
    else result = applyJSON(working, edit as JSONEdit);
    if (result.ok) {
      moves.push(...result.moves);
    } else {
      failures.push({ code: result.code, path: result.path });
    }
  }

  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    printAndExit(out, 1);
  }
  if (!check) writeTree(root, initial, working);
  printAndExit(computeOutput(initial, working, moves), 0);
}

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
