# KB1 Flash Tool - Development Guide

## Project Created: April 5, 2026

Complete desktop firmware updater for KB1 MIDI controller.

## Quick Start

```bash
# Navigate to project
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-flash

# Install dependencies (already done)
npm install

# Development server
npm run dev
# Opens http://localhost:5174

# Build for production
npm run build
# Output: dist/

# Preview production build
npm run preview
```

## Project Structure

```
kb1-flash/
├── src/
│   ├── main.ts              # UI logic, event handlers
│   ├── flasher.ts           # ESP32 flashing (esptool-js wrapper)
│   ├── github.ts            # GitHub releases API client
│   ├── serial-monitor.ts    # Serial port reader
│   ├── types.ts             # TypeScript interfaces
│   ├── web-serial.d.ts      # Web Serial API type definitions
│   └── style.css            # KB1 brand styles
├── index.html               # Main UI (2-tab layout)
├── dist/                    # Build output (git ignored)
└── README.md                # User documentation
```

## Technology

- **Vite 5** - Fast build tool, dev server
- **TypeScript 5** - Type safety
- **esptool-js 0.4** - ESP32 firmware flashing
- **Web Serial API** - USB communication (Chrome/Edge/Opera only)
- **Vanilla JS** - No framework (lightweight, minimal maintenance)

## Features

### Flash Tab
1. **GitHub Releases** - Auto-download from pocket-midi/KB1-firmware
2. **Local Upload** - Drag & drop .bin files
3. **Progress Tracking** - 4-step visual progress
4. **NVS Preservation** - Automatic battery calibration backup/restore

### Serial Monitor Tab
1. **Real-time Output** - View device boot logs
2. **Auto-scroll** - Toggle to follow newest output
3. **Clear Buffer** - Reset display

## How It Works

### Firmware Flashing Flow

```
1. User selects firmware (GitHub or local .bin)
   ↓
2. requestPort() - User picks USB device
   ↓
3. connect() - Open serial port, enter bootloader
   ↓
4. backupNVS() - Read 20KB @ 0x9000 (battery cal)
   ↓
5. flashFirmware() - Write .bin @ 0x0 (combined binary)
   ↓
6. restoreNVS() - Write saved 20KB back to 0x9000
   ↓
7. disconnect() - Hard reset device
   ↓
8. Complete! Device boots with new firmware + old battery cal
```

### NVS Partition

**Address:** 0x9000  
**Size:** 20KB (0x5000 bytes)  

**Contains:**
- `batPct` - Battery percentage
- `batBleOnMs` - Active BLE time
- `batBleOffMs` - Idle time
- `batDischMs` - Deep sleep time
- `batCalTime` - Calibration timestamp

**Critical:** Must be preserved across firmware updates or battery calibration is lost!

## Code Highlights

### flasher.ts
Core flashing logic ported from `KB1-config/src/composables/useFirmwareUpdate.ts`.

Key changes:
- Class-based instead of Vue composable
- Callback pattern for status updates
- No Vue reactivity

### github.ts
Fetches releases from GitHub API:
```typescript
const releases = await fetchReleases(5);
const firmwareUrl = findFirmwareBinary(release);
const data = await downloadFirmware(url);
```

### serial-monitor.ts
Simple Web Serial API reader:
```typescript
const monitor = new SerialMonitor();
monitor.onData(text => console.log(text));
await monitor.connect();
```

## Browser Support

**Supported:**
- Chrome 89+ (desktop)
- Edge 89+ (desktop)
- Opera 76+ (desktop)

**NOT Supported:**
- Firefox (no Web Serial API)
- Safari (no Web Serial API)
- Any mobile browser

**Requirements:**
- HTTPS or localhost
- USB permissions granted

## Testing Checklist

- [ ] Build completes without errors (`npm run build`)
- [ ] Dev server runs (`npm run dev`)
- [ ] Browser warning shows on Firefox/Safari
- [ ] GitHub releases load correctly
- [ ] File drag & drop works
- [ ] USB port selection appears
- [ ] Firmware flashes successfully
- [ ] NVS preservation works (battery % unchanged after flash)
- [ ] Serial monitor connects
- [ ] Device boots with new firmware

## Deployment

### Option 1: GitHub Pages

```bash
npm run build
# Upload dist/ to gh-pages branch
```

Configure in repo settings:
- Source: gh-pages branch
- Custom domain: kb1-flash.pocketmidi.com

### Option 2: Netlify

```bash
# Drag dist/ folder to Netlify
# Or connect GitHub repo with:
Build command: npm run build
Publish directory: dist
```

### Option 3: Custom Server

Requirements:
- HTTPS (required for Web Serial API)
- Static file hosting
- No server-side logic needed

## Known Issues

### esptool-js Buffer Format

esptool-js expects **binary strings**, not Uint8Array:

```typescript
// WRONG
await loader.writeFlash({ data: uint8Array });

// CORRECT
const binaryString = String.fromCharCode(...uint8Array);
await loader.writeFlash({ data: binaryString });
```

### Serial Port State

Don't rely on `port.readable`, `port.writable` properties - they're unreliable in browsers. Let Transport/ESPLoader handle opening.

## Future Enhancements

- [ ] Firmware version detection (read from device via BLE)
- [ ] Release notes display
- [ ] Multiple file support (bootloader + partitions + firmware separately)
- [ ] Advanced mode: Manual NVS editing
- [ ] Offline mode: Bundle firmware in tool
- [ ] Progress estimation (time remaining)

## Links

- **Live Tool:** (not deployed yet)
- **KB1 Config:** https://github.com/pocket-midi/KB1-config
- **KB1 Firmware:** https://github.com/pocket-midi/KB1-firmware
- **Web Serial API:** https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- **esptool-js:** https://github.com/espressif/esptool-js

## Support

For issues:
1. Check browser console for errors
2. Try different USB cable/port
3. Verify device is KB1 (Espressif vendor ID 0x303a)
4. Check serial monitor for boot messages

Contact: support@pocketmidi.com
