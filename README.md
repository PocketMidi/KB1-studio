# KB1 Studio

Desktop tool suite for KB1 MIDI controller. Combines firmware management with an instrument builder for the Polyend Tracker Mini.
___

## Firmware Update

Flash KB1 firmware via USB. Battery calibration data is automatically preserved across updates.

**Requirements:** Chrome, Edge, or Opera on desktop (Windows, macOS, Linux). Web Serial API required. Mobile browsers are not supported.

**Usage:**

1. Connect KB1 via USB-C.
2. Select a firmware release from the list, or drag and drop a local `.bin` file.
3. Grant USB permission when the browser prompts.
4. Wait for the flash to complete. The device restarts automatically.

**What happens during flash:**

- NVS partition (0x9000, 20KB) is read and saved before erasing.
- Firmware binary is written (bootloader + partition table + firmware).
- NVS partition is restored to the original contents.
- Battery calibration, active time counters, and user settings are preserved.

**Firmware format:** Expects a combined binary with bootloader at 0x0, partition table at 0x8000, and firmware at 0x10000. Use `build_complete.sh` in the firmware repo to produce this file — do not use `.pio/build/firmware.bin` directly.

### Device Info

Reads and displays connected device information over USB serial: firmware version, uptime, battery state, and NVS key values.

### Serial Monitor

Streams live serial output from KB1. Useful for verifying a successful flash, reading boot logs, and viewing debug output.
___

## Instrument Builder

Build Polyend Tracker Mini instruments from audio samples and export as `.pti` files.

**Workflow:**

1. Click **New Project** — a save dialog opens immediately. Name and save your `.kb1i` project file.
2. Drop audio files into the file bin (WAV, AIFF, FLAC, MP3).
3. Samples are mapped to the 48-key piano roll automatically. Root note is detected from filename or SFZ metadata.
4. Adjust assignments by dragging files from the bin onto piano roll keys.
5. Use the waveform editor to trim start/end points and set slice markers for each slot.
6. Click **Export PTI** to download the instrument file ready for Tracker Mini.

**Sample import:**

- Drop a folder of audio files for automatic root note detection via filename parsing (e.g. `Piano_C4.wav`, `strings_A3_f.wav`).
- Drop a `.sfz` file alongside audio files to use SFZ region mappings instead of filename heuristics.
- Velocity layers (f/mf/mp/p, hard/soft, etc.) are detected. One layer per note is selected for the default slot map; others are available for manual override.
- Release trigger samples (RT, release) are excluded from the default map.

**Project files:**

- Projects save as `.kb1i` (JSON). Save with **Ctrl/Cmd+S**, or use **File → Save As** to rename.
- The session is also persisted in browser storage so work-in-progress survives a page reload.
- Re-opening a `.kb1i` file restores all sample assignments. Audio files are re-linked by name match — if the browser can't find a file, it will prompt you to re-select it.



## Development

```bash
npm install
npm run dev      # → http://localhost:5174/kb1-studio/
npm run build
npm run preview
```

Type-check:

```bash
node_modules/typescript/bin/tsc --noEmit
```

## Architecture

```
kb1-studio/
├── src/
│   ├── main.ts              # Entry point, instrument builder UI
│   ├── flashTools.ts        # Flash tab UI and serial monitor
│   ├── flasher.ts           # Firmware flashing (esptool-js wrapper)
│   ├── sampleImport.ts      # Sample mapping and SFZ parser
│   ├── ptiExport.ts         # PTI file generation
│   ├── persistence.ts       # IndexedDB session storage
│   ├── github.ts            # GitHub releases API
│   ├── serial-monitor.ts    # Serial port reader
│   ├── nvs-parser.ts        # NVS partition parser
│   ├── types.ts             # TypeScript definitions
│   └── style.css            # Styles
├── index.html               # App shell
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Technology Stack

- **Vite** + **TypeScript** — build tooling
- **@polyend/tracker-lib** — PTI file generation
- **esptool-js** — ESP32 flashing via Web Serial API
- **GitHub API** — firmware release fetching
- **IndexedDB** — session persistence

## Deployment

Build and deploy the `dist/` folder to any static host with HTTPS. Web Serial API requires HTTPS (or localhost).

```bash
npm run build
```

The base path is `/kb1-studio/`. Update `vite.config.ts` if deploying to a different subdirectory.

## Troubleshooting

**"Browser not supported"** — Use Chrome, Edge, or Opera on desktop. HTTPS or localhost required.

**"Failed to connect USB"** — Check the USB cable and port. On macOS, verify USB permissions in System Settings. Make sure the serial monitor is disconnected before starting a flash.

**Flash fails mid-update** — Do not disconnect USB during flash. Check the serial monitor for error details. If NVS restore fails, calibration data can be re-entered via the KB1 Config app.

**Samples not detected** — If filename parsing produces wrong root notes, use the octave offset control to shift all assignments, or drag samples manually from the file bin to the correct piano roll keys. Alternatively, provide a `.sfz` mapping file alongside the audio files.

**SFZ import** — The SFZ parser handles `<region>`, `<group>`, and `<global>` sections. Supported opcodes: `sample`, `default_path`, `key`, `pitch_keycenter`, `lokey`, `hikey`, `lovel`, `hivel`. Samples are matched to provided files by basename.

## License

MIT License — see LICENSE file

## Links

- [KB1 Website](https://kb1.pocketmidi.com)
- [KB1 Config App](https://github.com/PocketMidi/KB1-config)
- [KB1 Firmware](https://github.com/PocketMidi/KB1-firmware)
- [Pocket MIDI](https://pocketmidi.com)
