# KB1 Studio

User guides and desktop suite of tools for KB1 MIDI controller. Includes firmware management and an instrument builder for the Polyend Tracker Mini.

**Live app:** [KB1 Studio](https://pocketmidi.github.io/KB1-studio/)

## Documentation

- **User Guide** tab: Hardware layout, charging, Bluetooth, and Tracker setup. Switch between **Quick Start** and **Detailed Guide**; **?** buttons provide contextual help. Click anywhere in the invitation panel beneath Tracker Settings to open the Detailed Guide from the top.
- [Configurator User Guide](https://github.com/PocketMidi/KB1-config/blob/main/docs/USER_GUIDE.md): Current app settings, presets, and performance sliders. Keep Configurator parameter descriptions there rather than duplicating them in Studio.
- **Guide** in the Flash Tools and Instrument Builder sidebars: Tool-specific instructions.

This README covers repository setup and tool overviews. The in-app guides are the detailed user-facing reference.

Detailed Guide includes a matching **Quick Start** return panel. The **?** in the Configurator App header explains Tracker CC assignments versus KB1 Expression functions; browser help remains available beside **Designed for mobile**.

On mobile, Detailed Guide panels—including the Tracker Setup diagram—expand from their headers. Quick Start and desktop keep the diagram visible.
___

## Firmware Update

Flash KB1 firmware via USB. Battery calibration data is automatically preserved across updates.

**Exception:** **Clear device data on update** skips NVS backup/restore and erases saved settings, presets, and calibration.

**Requirements:** Chrome, Edge, or Opera on desktop (Windows, macOS, Linux). Web Serial API required. Mobile browsers are not supported.

**Usage:**

- Connect KB1 via USB-C.
- If KB1 is connected to Tracker Mini, power down the Tracker before flashing.
- The latest release is pre-selected. Use **Choose a different version** for an older release, or load a local complete `.bin` image.
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

- The current app uses file-first storage: **Save** or **Save As…** to preserve your work. Unsaved sessions are not automatically restored after a page reload.

- Re-opening a `.kb1i` file restores assignments and editing settings. Projects reference the audio files rather than embedding them; keep the source samples and re-select them when prompted.


## Development & Deployment

### Quick Start

Use a Node.js version supported by Vite 7 (20.19+ or 22.12+).

```bash
npm install
npm run dev      # → http://localhost:5174/KB1-studio/
```

Type-check and build:

```bash
npm run typecheck
npm run build    # Output to dist/
npm run preview
```

### GitHub Pages Deployment

- **Repository:** `https://github.com/PocketMidi/KB1-studio`
- **Production URL:** `https://pocketmidi.github.io/KB1-studio/`

1. Set source to **GitHub Actions** in Repository Settings → Pages.
2. Ensure `vite.config.ts` uses `base: '/KB1-studio/'` (case-sensitive).
3. Pushing to `main` triggers automated build and deployment to GitHub Pages.

**Verification Checklist:**
- Main app loads at `/KB1-studio/`
- Flash tab loads firmware release manifest
- Serial monitor connects over Web Serial (Chrome/Edge/Opera on desktop)

## Troubleshooting

**"Browser not supported"** — Use Chrome, Edge, or Opera on desktop. HTTPS or localhost required.

**"Failed to connect USB"** — Check the USB cable and port. On macOS, verify USB permissions in System Settings. Make sure the serial monitor is disconnected before starting a flash.

**Flash fails mid-update** — Do not disconnect USB during flash. Check the serial monitor for error details. If NVS restore fails, calibration data can be re-entered via the KB1 Config app.

**Samples not detected** — If filename parsing produces wrong root notes, use the octave offset control to shift all assignments, or drag samples manually from the file bin to the correct piano roll keys. Alternatively, provide a `.sfz` mapping file alongside the audio files.

**SFZ import** — The SFZ parser handles `<region>`, `<group>`, and `<global>` sections. Supported opcodes: `sample`, `default_path`, `key`, `pitch_keycenter`, `lokey`, `hikey`, `lovel`, `hivel`. Samples are matched to provided files by basename.

## License

MIT License — see [LICENSE](LICENSE).

## Links

- [KB1 Website](https://kb1.pocketmidi.com)
- [KB1 Config App](https://github.com/PocketMidi/KB1-config)
- [KB1 Firmware](https://github.com/PocketMidi/KB1/tree/main/firmware)
- [Pocket MIDI](https://pocketmidi.com)
