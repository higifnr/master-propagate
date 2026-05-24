import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RelationshipStore } from './store';
import { applyPatch } from './patcher';

let store: RelationshipStore;

export function activate(context: vscode.ExtensionContext) {
  store = new RelationshipStore(context.globalState);

  // ── Commands ────────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'masterPropagate.setAsMaster',
      async (uri?: vscode.Uri) => {
        uri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
        const content = readFile(uri.fsPath);
        if (content === undefined) return;
        await store.addMaster(uri.toString(), content);
        vscode.window.showInformationMessage(`Master Propagate: "${path.basename(uri.fsPath)}" set as master.`);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'masterPropagate.createChild',
      async (uri?: vscode.Uri) => {
        uri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;

        if (!store.isMaster(uri.toString())) {
          const confirm = await vscode.window.showWarningMessage(
            `"${path.basename(uri.fsPath)}" is not yet a master. Register it first?`,
            'Yes', 'No'
          );
          if (confirm !== 'Yes') return;
          const content = readFile(uri.fsPath);
          if (content === undefined) return;
          await store.addMaster(uri.toString(), content);
        }

        const masterContent = readFile(uri.fsPath);
        if (masterContent === undefined) return;

        const defaultName = childName(uri.fsPath);
        const picked = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(path.dirname(uri.fsPath), defaultName)),
          title: 'Create Child File',
        });
        if (!picked) return;

        fs.writeFileSync(picked.fsPath, masterContent, 'utf8');
        await store.addChild(uri.toString(), picked.toString(), masterContent);
        await vscode.window.showTextDocument(picked);
        vscode.window.showInformationMessage(`Master Propagate: child "${path.basename(picked.fsPath)}" created.`);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'masterPropagate.addExistingAsChild',
      async (uri?: vscode.Uri) => {
        uri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;

        const masters = store.getAllMasters();
        if (masters.length === 0) {
          vscode.window.showWarningMessage('Master Propagate: no masters registered yet.');
          return;
        }

        const items = masters.map(m => ({
          label: path.basename(vscode.Uri.parse(m.uri).fsPath),
          description: vscode.Uri.parse(m.uri).fsPath,
          uri: m.uri,
        }));

        const chosen = await vscode.window.showQuickPick(items, { title: 'Select master to attach to' });
        if (!chosen) return;

        const childContent = readFile(uri.fsPath);
        if (childContent === undefined) return;

        await store.addChild(chosen.uri, uri.toString(), childContent);
        vscode.window.showInformationMessage(`Master Propagate: "${path.basename(uri.fsPath)}" added as child.`);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'masterPropagate.unlink',
      async (uri?: vscode.Uri) => {
        uri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
        await store.unlink(uri.toString());
        vscode.window.showInformationMessage(`Master Propagate: "${path.basename(uri.fsPath)}" unlinked.`);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'masterPropagate.showRelationships',
      async () => {
        const masters = store.getAllMasters();
        if (masters.length === 0) {
          vscode.window.showInformationMessage('Master Propagate: no relationships defined.');
          return;
        }
        const lines = masters.map(m => {
          const masterName = path.basename(vscode.Uri.parse(m.uri).fsPath);
          const childNames = m.children
            .map(c => `  └─ ${path.basename(vscode.Uri.parse(c.uri).fsPath)}`)
            .join('\n');
          return `${masterName}\n${childNames || '  (no children)'}`;
        });
        vscode.window.showInformationMessage(lines.join('\n\n'), { modal: true });
      }
    )
  );

  // ── Save listener ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const masterUri = doc.uri.toString();
      if (!store.isMaster(masterUri)) return;

      const master = store.getMaster(masterUri)!;
      const config = vscode.workspace.getConfiguration('masterPropagate');
      const mode = config.get<string>('childSnapshotBehavior', 'alwaysTrackMaster');

      const oldContent = mode === 'snapshotAtCreation'
        ? master.snapshotContent
        : master.lastKnownContent;
      const newContent = doc.getText();

      if (oldContent === newContent) return;

      interface ConflictEntry {
        childFsPath: string;
        base: string;
        incoming: string;
        current: string;
      }
      const conflictedChildren: ConflictEntry[] = [];

      for (const childRecord of master.children) {
        const resolvedUri = await store.resolveUri(childRecord.uri, childRecord.contentHash);
        if (!resolvedUri) {
          vscode.window.showWarningMessage(
            `Master Propagate: cannot locate child "${childRecord.uri}" — skipping.`
          );
          continue;
        }

        if (resolvedUri !== childRecord.uri) {
          await store.updateChildUri(childRecord.uri, resolvedUri);
          childRecord.uri = resolvedUri;
        }

        const childFsPath = vscode.Uri.parse(resolvedUri).fsPath;
        const childContent = readFile(childFsPath);
        if (childContent === undefined) continue;

        const { patched, hasConflicts } = applyPatch(oldContent, newContent, childContent);

        if (!hasConflicts) {
          fs.writeFileSync(childFsPath, patched, 'utf8');
        } else {
          conflictedChildren.push({
            childFsPath,
            base: oldContent,
            incoming: newContent,
            current: childContent,
          });
        }
      }

      // Update master's last known content (always, regardless of mode)
      await store.updateMasterContent(masterUri, newContent);

      // Open merge editor for each conflict
      for (const entry of conflictedChildren) {
        await openMergeEditor(context, entry.childFsPath, entry.base, entry.incoming, entry.current);
      }
    })
  );

  // ── Rename listener ──────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (event) => {
      for (const { oldUri, newUri } of event.files) {
        const oldStr = oldUri.toString();
        const newStr = newUri.toString();

        if (store.isMaster(oldStr)) {
          await store.updateMasterUri(oldStr, newStr);
        } else {
          const rel = store.isChild(oldStr);
          if (rel) {
            await store.updateChildUri(oldStr, newStr);
          }
        }
      }
    })
  );
}

export function deactivate() {}

// ── Merge editor ──────────────────────────────────────────────────────────────

async function openMergeEditor(
  context: vscode.ExtensionContext,
  childFsPath: string,
  base: string,
  incoming: string,
  current: string
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-propagate-'));

  const basePath     = path.join(tmpDir, 'base.tmp');
  const incomingPath = path.join(tmpDir, 'incoming.tmp');

  fs.writeFileSync(basePath,     base,     'utf8');
  fs.writeFileSync(incomingPath, incoming, 'utf8');

  const baseUri     = vscode.Uri.file(basePath);
  const incomingUri = vscode.Uri.file(incomingPath);
  const resultUri   = vscode.Uri.file(childFsPath);

  // Clean up temp files once the merge editor closes
  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  try {
    // VS Code's built-in 3-way merge editor (available since 1.69)
    await vscode.commands.executeCommand('_open.mergeEditor', {
      base:     baseUri,
      input1:   { uri: incomingUri, title: 'Master', description: 'Changes from master' },
      input2:   { uri: resultUri,   title: 'Child',  description: 'Current child content' },
      result:   resultUri,
    });
  } catch {
    // Fallback: write conflict markers and open as plain text
    const { patched } = await import('./patcher').then(m => ({
      patched: m.applyPatch(base, incoming, current).patched
    }));
    fs.writeFileSync(childFsPath, patched, 'utf8');
    await vscode.window.showTextDocument(resultUri);
    vscode.window.showWarningMessage(
      `Master Propagate: conflicts in "${path.basename(childFsPath)}" — resolve markers manually.`
    );
  } finally {
    // Delay cleanup so VS Code has time to read the temp files
    setTimeout(cleanup, 10000);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFile(fsPath: string): string | undefined {
  try {
    return fs.readFileSync(fsPath, 'utf8');
  } catch {
    vscode.window.showErrorMessage(`Master Propagate: cannot read "${fsPath}".`);
    return undefined;
  }
}

function childName(masterFsPath: string): string {
  const ext = path.extname(masterFsPath);
  const base = path.basename(masterFsPath, ext);
  return `${base}.child${ext}`;
}