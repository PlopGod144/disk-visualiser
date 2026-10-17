# Storage Visualiser

See where your disk space went. A small local web app: a Node server scans a folder and streams the result to a browser UI as it goes. No dependencies to install (d3 loads from a CDN).

Windows only for now: Reveal and Recycle Bin use Explorer and PowerShell.

## Run

```
npm start        # or: node server.js
```

Open http://localhost:3000, type a folder (blank = your home folder) and press **Scan**.
`http://localhost:3000/?path=C:\some\folder` scans on open.

## What it does

- **Sunburst / Treemap**: click to zoom in, click the centre or a breadcrumb to zoom out. Colour by file **Type** or **Age**.
- **Search**: name, minimum size and file-type filters dim everything else in the chart.
- **Cleanup**: flags `node_modules`, caches, temp folders and old installers in Downloads. Hints only.
- **Duplicates**: finds byte-identical files of 1 MB or more. The **Connections** view draws folders as a graph, linked by the data they share.
- **Reveal / Recycle Bin**: buttons on every row and a right-click menu on the chart. Deleting only ever moves to the Recycle Bin, after a confirmation.

## Use it from your phone (same Wi-Fi)

```
$env:HOST='0.0.0.0'; node server.js     # PowerShell
HOST=0.0.0.0 node server.js             # Git Bash
```

The server prints a link with a one-off key for each network adapter. Open it on your phone. The phone only displays your PC's storage; it can't scan its own.
The connection is plain HTTP and the link gives access to your whole disk, so only do this on a network you trust, and stop the server afterwards.

## Safety notes

- By default it listens on `127.0.0.1` only and rejects other host names (DNS-rebinding guard).
- Reveal / Trash only act on real (non-symlink) entries inside folders you have scanned, never the scanned folder itself, and refuse cross-site requests. Scanning a large folder (such as your home folder) therefore makes everything inside it actionable.
- Windows shows its own prompt if an item is too big for the Recycle Bin.

## Limits

- Folders deeper than 6 levels are summed into one block and can't be zoomed into.
- Files under 1 MB are merged per folder, so search finds folders and files of 1 MB or more.
- Right-click menu only (no long-press on touch).

## Files

| File | Purpose |
|------|---------|
| `server.js` | scanner (`walk`), path guard (`safe`), HTTP endpoints, network mode |
| `dupes.js` | streaming duplicate finder (size, then first 64 KB, then full SHA-256) |
| `trash.ps1` | moves one path to the Recycle Bin |
| `public/` | the UI: `app.js`, `graph.js`, `style.css`, `index.html` |
| `test.js` | `npm test` |
