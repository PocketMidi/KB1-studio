# KB1 Studio

User guides and desktop suite of tools for KB1 MIDI controller. Includes firmware management and an instrument builder for the Polyend Tracker Mini.
___

## Firmware Update

Flash KB1 firmware via USB. Battery calibration data is automatically preserved across updates.

**Requirements:** Chrome, Edge, or Opera on desktop (Windows, macOS, Linux). Web Serial API required. Mobile browsers are not supported.

**Usage:**

- Connect KB1 via USB-C.
- Select a firmware release from the list, or drag and drop a local `.bin` file.
- Grant USB permission when the browser prompts.
- Wait for the flash to complete. The device restarts automatically.

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

**Sample import:**

- Start with Batch import to load your sample set, or Add to bin to add files without auto assignment

- Use the adjustment strip under the piano roll to shift your full assignment layout by semitone or octave while preserving note spacing

- Scroll to zoom, Shift+scroll to pan in both the piano roll and waveform editor

- Use Slot duration to set playback length; keep the lock on for a consistent instrument, unlock for per-slot timing

- Use Normalize when your source files have low or uneven loudness


**Project files:**

- Save your project as .kb1i while working, then export .pti when ready

- The session is also persisted in browser storage so work-in-progress survives a page reload.

- Re-opening a `.kb1i` file restores all sample assignments. Audio files are re-linked by name match — if the browser can't find a file, it will prompt you to re-select it.


## Development & Deployment

### Quick Start

```bash
npm install
npm run dev      # → http://localhost:5174/kb1-studio/
```

Type-check and build:

```bash
node_modules/typescript/bin/tsc --noEmit
npm run build    # Output to dist/
npm run preview
```

### GitHub Pages Deployment

- **Repository:** `https://github.com/PocketMidi/KB1-studio`
- **Production URL:** `https://pocketmidi.github.io/KB1-studio/`

1. Set source to **GitHub Actions** in Repository Settings → Pages.
2. Ensure `vite.config.ts` uses `base: '/kb1-studio/'`.
3. Pushing to `main` triggers automated build and deployment to GitHub Pages.

**Verification Checklist:**
- Main app loads at `/kb1-studio/`
- Flash tab loads firmware release manifest
- Serial monitor connects over Web Serial (Chrome/Edge/Opera on desktop)

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
