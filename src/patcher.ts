import * as Diff from 'diff';

export interface PatchResult {
  patched: string;
  hasConflicts: boolean;
}

/**
 * Given the old master content, new master content, and child content,
 * produces a 3-way merge result with conflict markers if needed.
 */
export function applyPatch(
  oldMaster: string,
  newMaster: string,
  childContent: string
): PatchResult {
  // Compute the structural diff (hunks) between old and new master
  const patch = Diff.createPatch('file', oldMaster, newMaster, '', '');

  // Attempt to apply the patch to the child
  const result = Diff.applyPatch(childContent, patch);

  if (result !== false) {
    // Clean apply
    return { patched: result, hasConflicts: false };
  }

  // Conflict: fall back to a 3-way merge with conflict markers
  const merged = threeWayMerge(oldMaster, newMaster, childContent);
  return { patched: merged, hasConflicts: true };
}

/**
 * Minimal 3-way merge producing Git-style conflict markers.
 * Uses line-level diffs of (base→master) and (base→child) and merges non-overlapping hunks.
 */
function threeWayMerge(base: string, master: string, child: string): string {
  const baseLines = base.split('\n');
  const masterLines = master.split('\n');
  const childLines = child.split('\n');

  const masterDiff = Diff.diffLines(base, master);
  const childDiff = Diff.diffLines(base, child);

  // Build change maps: line index in base → {master lines, child lines}
  type Change = { masterLines: string[]; childLines: string[] };
  const changes = new Map<number, Change>();

  let baseIdx = 0;
  for (const part of masterDiff) {
    if (!part.added && !part.removed) {
      baseIdx += part.count ?? 0;
    } else if (part.removed) {
      const count = part.count ?? 0;
      for (let i = 0; i < count; i++) {
        if (!changes.has(baseIdx + i)) changes.set(baseIdx + i, { masterLines: [], childLines: [] });
        changes.get(baseIdx + i)!.masterLines = [];
      }
      baseIdx += count;
    } else if (part.added) {
      const insertAt = baseIdx - 1;
      if (!changes.has(insertAt)) changes.set(insertAt, { masterLines: [], childLines: [] });
      changes.get(insertAt)!.masterLines.push(...(part.value?.split('\n').filter((_, i, a) => i < a.length - 1) ?? []));
    }
  }

  baseIdx = 0;
  for (const part of childDiff) {
    if (!part.added && !part.removed) {
      baseIdx += part.count ?? 0;
    } else if (part.removed) {
      const count = part.count ?? 0;
      for (let i = 0; i < count; i++) {
        if (!changes.has(baseIdx + i)) changes.set(baseIdx + i, { masterLines: [], childLines: [] });
        changes.get(baseIdx + i)!.childLines = [];
      }
      baseIdx += count;
    } else if (part.added) {
      const insertAt = baseIdx - 1;
      if (!changes.has(insertAt)) changes.set(insertAt, { masterLines: [], childLines: [] });
      changes.get(insertAt)!.childLines.push(...(part.value?.split('\n').filter((_, i, a) => i < a.length - 1) ?? []));
    }
  }

  // Reconstruct output
  const output: string[] = [];
  for (let i = 0; i < baseLines.length; i++) {
    const change = changes.get(i);
    if (change) {
      const masterChanged = JSON.stringify(change.masterLines) !== JSON.stringify([baseLines[i]]);
      const childChanged = JSON.stringify(change.childLines) !== JSON.stringify([baseLines[i]]);

      if (masterChanged && childChanged && JSON.stringify(change.masterLines) !== JSON.stringify(change.childLines)) {
        // Conflict
        output.push('<<<<<<< master');
        output.push(...change.masterLines);
        output.push('=======');
        output.push(...change.childLines);
        output.push('>>>>>>> child');
      } else if (masterChanged) {
        output.push(...change.masterLines);
      } else if (childChanged) {
        output.push(...change.childLines);
      } else {
        output.push(baseLines[i]);
      }
    } else {
      output.push(baseLines[i]);
    }
  }

  return output.join('\n');
}
