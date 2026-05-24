# Master Propagate

Offers context menu action to define a master file (like a master slide / canvas in graphics design tools) and spawn children files from it.

Propagates changes from a master file to any number of children on save.
Children start as exact copies of the master. When the master is saved,
the delta is patched into each child. Conflicts open with Git-style conflict
markers so you can resolve them with VS Code's built-in merge editor.

Relationships survive across workspaces and track file renames/moves —
including moves made outside VS Code (resolved via content hash fallback).

---

## Setup

```bash
npm install
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host.

To package for install:
```bash
npm install -g @vscode/vsce
vsce package        # produces master-propagate-0.1.0.vsix
code --install-extension master-propagate-0.1.0.vsix
```

---

## Usage

All commands are available by **right-clicking a file** in the Explorer.

| Command | What it does |
|---|---|
| **Set as Master** | Registers the file as a master |
| **Create Child from Master** | Creates a copy and links it as a child |
| **Add Existing File as Child** | Links a pre-existing file to a master |
| **Unlink File** | Removes a master or child from all relationships |
| **Show Relationships** | Lists all master→child trees |

---

## How propagation works

1. You save the master file.
2. The extension diffs the master's **previous saved state** against the **new saved state**.
3. That patch is applied to each child.
4. If a patch applies cleanly → child is silently updated.
5. If there's a conflict → child is written with `<<<<<<< / ======= / >>>>>>>` markers and opened in the editor.

---

## Configuration

`masterPropagate.childSnapshotBehavior`

| Value | Behaviour |
|---|---|
| `alwaysTrackMaster` *(default)* | Diffs previous save vs current save — only incremental changes propagate |
| `snapshotAtCreation` | Diffs master-at-child-creation-time vs current save — full divergence since birth propagates |

# Disclaimer
This extension was **entirely** "vibe-coded".
I have no experience with JavaScript but I personally needed this tool for one of my workloads.
