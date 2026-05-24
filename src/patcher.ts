import * as Diff from 'diff';

export interface PatchResult {
  patched: string;
  hasConflicts: boolean;
}

/**
 * True 3-way merge: base → master (ours), base → child (theirs).
 * Non-overlapping changes from both sides are applied cleanly.
 * Overlapping changes produce Git-style conflict markers.
 */
export function applyPatch(
  base: string,
  master: string,
  child: string
): PatchResult {
  const baseLines   = base   === '' ? [] : base.split('\n');
  const masterLines = master === '' ? [] : master.split('\n');
  const childLines  = child  === '' ? [] : child.split('\n');

  const regions = diff3Regions(baseLines, masterLines, childLines);

  const output: string[] = [];
  let hasConflicts = false;

  for (const region of regions) {
    if (region.type === 'stable') {
      output.push(...region.lines);
    } else if (region.type === 'master') {
      output.push(...region.lines);
    } else if (region.type === 'child') {
      output.push(...region.lines);
    } else {
      // conflict
      hasConflicts = true;
      output.push('<<<<<<< master');
      output.push(...region.masterLines);
      output.push('=======');
      output.push(...region.childLines);
      output.push('>>>>>>> child');
    }
  }

  return { patched: output.join('\n'), hasConflicts };
}

// ── Diff3 implementation ──────────────────────────────────────────────────────

type StableRegion   = { type: 'stable';   lines: string[] };
type MasterRegion   = { type: 'master';   lines: string[] };
type ChildRegion    = { type: 'child';    lines: string[] };
type ConflictRegion = { type: 'conflict'; masterLines: string[]; childLines: string[] };
type Region = StableRegion | MasterRegion | ChildRegion | ConflictRegion;

function diff3Regions(
  base: string[],
  master: string[],
  child: string[]
): Region[] {
  // Build LCS-based edit scripts from base→master and base→child
  const masterEdits = buildEdits(base, master);
  const childEdits  = buildEdits(base, child);

  const regions: Region[] = [];

  let bi = 0; // base index
  let mi = 0; // master index
  let ci = 0; // child index
  let mei = 0; // master edits index
  let cei = 0; // child edits index

  while (bi < base.length || mi < master.length || ci < child.length) {
    // Find next edit in each stream
    const nextMasterEdit = masterEdits[mei];
    const nextChildEdit  = childEdits[cei];

    const nextMasterBase = nextMasterEdit ? nextMasterEdit.baseStart : Infinity;
    const nextChildBase  = nextChildEdit  ? nextChildEdit.baseStart  : Infinity;

    // Stable region: both streams agree, no edits pending
    const stableEnd = Math.min(nextMasterBase, nextChildBase);
    if (bi < stableEnd && bi < base.length) {
      const count = Math.min(stableEnd - bi, base.length - bi);
      regions.push({ type: 'stable', lines: base.slice(bi, bi + count) });
      bi  += count;
      mi  += count;
      ci  += count;
      continue;
    }

    // Collect overlapping edits at this base position
    const overlappingMaster: typeof masterEdits = [];
    const overlappingChild:  typeof childEdits  = [];

    // Gather all master edits starting at or before current base pos
    while (mei < masterEdits.length && masterEdits[mei].baseStart <= bi) {
      overlappingMaster.push(masterEdits[mei++]);
    }
    while (cei < childEdits.length && childEdits[cei].baseStart <= bi) {
      overlappingChild.push(childEdits[cei++]);
    }

    if (overlappingMaster.length === 0 && overlappingChild.length === 0) {
      // Advance stable line
      regions.push({ type: 'stable', lines: [base[bi]] });
      bi++; mi++; ci++;
      continue;
    }

    // Compute the base range covered by all overlapping edits
    const allEdits = [...overlappingMaster, ...overlappingChild];
    const baseEnd = Math.max(...allEdits.map(e => e.baseEnd));

    // Pull in any further edits from either side that overlap this range
    while (mei < masterEdits.length && masterEdits[mei].baseStart < baseEnd) {
      overlappingMaster.push(masterEdits[mei++]);
    }
    while (cei < childEdits.length && childEdits[cei].baseStart < baseEnd) {
      overlappingChild.push(childEdits[cei++]);
    }

    // Reconstruct what master and child produce for this base range
    const masterOut = applyEditsToRange(base, bi, baseEnd, master, mi, overlappingMaster);
    const childOut  = applyEditsToRange(base, bi, baseEnd, child,  ci, overlappingChild);

    const masterChanged = !arraysEqual(base.slice(bi, baseEnd), masterOut);
    const childChanged  = !arraysEqual(base.slice(bi, baseEnd), childOut);

    if (!masterChanged && !childChanged) {
      regions.push({ type: 'stable', lines: masterOut });
    } else if (masterChanged && !childChanged) {
      regions.push({ type: 'master', lines: masterOut });
    } else if (!masterChanged && childChanged) {
      regions.push({ type: 'child', lines: childOut });
    } else if (arraysEqual(masterOut, childOut)) {
      // Both changed the same way
      regions.push({ type: 'master', lines: masterOut });
    } else {
      regions.push({ type: 'conflict', masterLines: masterOut, childLines: childOut });
    }

    // Advance indices past the consumed base range
    const baseDelta  = baseEnd - bi;
    bi = baseEnd;

    // Advance master index: stable lines consumed + inserted lines
    const masterInserted = overlappingMaster.reduce((s, e) => s + e.inserted.length, 0);
    const masterDeleted  = overlappingMaster.reduce((s, e) => s + (e.baseEnd - e.baseStart), 0);
    mi += masterInserted + (baseDelta - masterDeleted);

    const childInserted = overlappingChild.reduce((s, e) => s + e.inserted.length, 0);
    const childDeleted  = overlappingChild.reduce((s, e) => s + (e.baseEnd - e.baseStart), 0);
    ci += childInserted + (baseDelta - childDeleted);
  }

  return mergeAdjacent(regions);
}

interface Edit {
  baseStart: number;
  baseEnd: number;
  inserted: string[];
}

function buildEdits(base: string[], target: string[]): Edit[] {
  const changes = Diff.diffArrays(base, target);
  const edits: Edit[] = [];
  let bi = 0;

  for (const part of changes) {
    const count = part.count ?? 0;
    if (!part.added && !part.removed) {
      bi += count;
    } else if (part.removed) {
      const next = changes[changes.indexOf(part) + 1];
      const inserted = (next?.added ? next.value as string[] : []);
      edits.push({ baseStart: bi, baseEnd: bi + count, inserted });
      bi += count;
    } else if (part.added) {
      // Pure insertion (not preceded by removal)
      const prev = edits[edits.length - 1];
      if (!prev || prev.baseEnd !== bi || prev.inserted.length === 0) {
        edits.push({ baseStart: bi, baseEnd: bi, inserted: part.value as string[] });
      }
      // If preceded by removal, already handled above
    }
  }

  return edits;
}

function applyEditsToRange(
  base: string[],
  rangeStart: number,
  rangeEnd: number,
  target: string[],
  targetStart: number,
  edits: Edit[]
): string[] {
  if (edits.length === 0) return base.slice(rangeStart, rangeEnd);

  const out: string[] = [];
  let bi = rangeStart;
  let ti = targetStart;

  for (const edit of edits) {
    // Stable lines before this edit
    const stableBefore = edit.baseStart - bi;
    out.push(...target.slice(ti, ti + stableBefore));
    ti += stableBefore;
    bi = edit.baseStart;

    // Inserted lines
    out.push(...edit.inserted);
    ti += edit.inserted.length;

    // Skip deleted base lines
    const deleted = edit.baseEnd - edit.baseStart;
    bi += deleted;
  }

  // Remaining stable lines up to rangeEnd
  const remaining = rangeEnd - bi;
  out.push(...target.slice(ti, ti + remaining));

  return out;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function mergeAdjacent(regions: Region[]): Region[] {
  const out: Region[] = [];
  for (const r of regions) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'stable' && r.type === 'stable') {
      prev.lines.push(...r.lines);
    } else if (prev && prev.type === 'master' && r.type === 'master') {
      prev.lines.push(...r.lines);
    } else if (prev && prev.type === 'child' && r.type === 'child') {
      prev.lines.push(...r.lines);
    } else if (r.type === 'conflict') {
      out.push({ type: 'conflict', masterLines: [...r.masterLines], childLines: [...r.childLines] });
    } else {
      out.push({ type: r.type, lines: [...r.lines] });
    }
  }
  return out;
}