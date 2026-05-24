import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ChildRecord {
  uri: string;
  contentHash: string; // hash at time of relationship creation, for fallback location
}

export interface MasterRecord {
  uri: string;
  contentHash: string;
  /** Content of master at last save — used to compute the forward diff */
  lastKnownContent: string;
  /** Content of master at child-creation time — used for snapshotAtCreation mode */
  snapshotContent: string;
  children: ChildRecord[];
}

const STORAGE_KEY = 'masterPropagate.relationships';

export class RelationshipStore {
  private records: Map<string, MasterRecord> = new Map();

  constructor(private globalState: vscode.Memento) {
    this.load();
  }

  private load() {
    const raw = this.globalState.get<Record<string, MasterRecord>>(STORAGE_KEY, {});
    this.records = new Map(Object.entries(raw));
  }

  private async persist() {
    const obj: Record<string, MasterRecord> = {};
    this.records.forEach((v, k) => { obj[k] = v; });
    await this.globalState.update(STORAGE_KEY, obj);
  }

  getMaster(uri: string): MasterRecord | undefined {
    return this.records.get(uri);
  }

  getAllMasters(): MasterRecord[] {
    return Array.from(this.records.values());
  }

  isMaster(uri: string): boolean {
    return this.records.has(uri);
  }

  isChild(uri: string): { masterUri: string; record: MasterRecord } | undefined {
    for (const [masterUri, record] of this.records) {
      if (record.children.some(c => c.uri === uri)) {
        return { masterUri, record };
      }
    }
    return undefined;
  }

  async addMaster(uri: string, content: string): Promise<void> {
    if (this.records.has(uri)) return;
    this.records.set(uri, {
      uri,
      contentHash: hash(content),
      lastKnownContent: content,
      snapshotContent: content,
      children: [],
    });
    await this.persist();
  }

  async addChild(masterUri: string, childUri: string, childContent: string): Promise<void> {
    const master = this.records.get(masterUri);
    if (!master) throw new Error('Master not registered');
    if (master.children.some(c => c.uri === childUri)) return;
    master.children.push({ uri: childUri, contentHash: hash(childContent) });
    await this.persist();
  }

  async updateMasterContent(masterUri: string, newContent: string): Promise<void> {
    const master = this.records.get(masterUri);
    if (!master) return;
    master.lastKnownContent = newContent;
    master.contentHash = hash(newContent);
    await this.persist();
  }

  async updateChildUri(oldUri: string, newUri: string): Promise<void> {
    for (const record of this.records.values()) {
      const child = record.children.find(c => c.uri === oldUri);
      if (child) {
        child.uri = newUri;
        await this.persist();
        return;
      }
    }
  }

  async updateMasterUri(oldUri: string, newUri: string): Promise<void> {
    const record = this.records.get(oldUri);
    if (!record) return;
    record.uri = newUri;
    this.records.delete(oldUri);
    this.records.set(newUri, record);
    await this.persist();
  }

  async unlink(uri: string): Promise<void> {
    // Could be a master or a child
    if (this.records.has(uri)) {
      this.records.delete(uri);
    } else {
      for (const record of this.records.values()) {
        record.children = record.children.filter(c => c.uri !== uri);
      }
    }
    await this.persist();
  }

  /**
   * Tries to resolve a URI. If the file doesn't exist at the stored path,
   * scans the filesystem near the last known location using the content hash.
   */
  async resolveUri(uri: string, knownHash: string): Promise<string | undefined> {
    if (fs.existsSync(vscode.Uri.parse(uri).fsPath)) return uri;

    // Fallback: search in the same directory tree
    const fsPath = vscode.Uri.parse(uri).fsPath;
    const searchRoot = findWorkspaceRoot(fsPath) ?? path.dirname(fsPath);
    return scanForHash(searchRoot, knownHash);
  }
}

function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function findWorkspaceRoot(filePath: string): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (filePath.startsWith(folder.uri.fsPath)) return folder.uri.fsPath;
  }
  return undefined;
}

function scanForHash(dir: string, targetHash: string): string | undefined {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = scanForHash(fullPath, targetHash);
        if (found) return found;
      } else {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (crypto.createHash('sha256').update(content).digest('hex') === targetHash) {
            return vscode.Uri.file(fullPath).toString();
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* skip unreadable dirs */ }
  return undefined;
}
