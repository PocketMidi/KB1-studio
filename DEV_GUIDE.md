# KB1 Studio Development Guide

KB1 Studio is the active desktop web app for KB1 firmware management and instrument building.

## Quick Start

```bash
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio
npm install
npm run dev
```

Dev URL: `http://localhost:5174/kb1-studio/`

## Build + Type Check

```bash
npm run build
node_modules/typescript/bin/tsc --noEmit
```

## Project Structure

```text
kb1-studio/
├── src/
│   ├── main.ts
│   ├── flashTools.ts
│   ├── flasher.ts
│   ├── sampleImport.ts
│   ├── ptiExport.ts
│   ├── persistence.ts
│   └── style.css
├── public/
│   └── firmware/
│       └── releases.json
└── index.html
```

## Core Functional Areas

1. Firmware flashing via Web Serial with NVS backup/restore.
2. Firmware release browsing and local `.bin` drop support.
3. Serial monitor + device info over USB.
4. Tracker Mini instrument builder + PTI export.

## Browser Requirements

- Chrome, Edge, or Opera on desktop.
- HTTPS or localhost for Web Serial API.
- Mobile browsers are not supported.

## Migration Note

The standalone KB1 Flash app has been retired and is redirect-only. New flashing features should be added to KB1 Studio.
