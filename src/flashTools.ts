/**
 * Flash Tools — migrated from kb1-flash/src/main.ts
 *
 * Called once from kb1-studio main.ts as `initFlashTools()` after
 * DOMContentLoaded.  All DOM queries are lazy (getElementById inside
 * functions) because the flash tab elements aren't guaranteed to be
 * in the layout at module-parse time.
 */

import { KB1Flasher } from './flasher';
import { downloadFirmware, fetchReleases } from './github';
import { parseNVSBatteryData } from './nvs-parser';
import { SerialMonitor } from './serial-monitor';
import type { FirmwareFile, FirmwareRelease, FlashStatus } from './types';

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

let flasher: KB1Flasher | null = null;
let serialMonitor: SerialMonitor | null = null;
let currentFirmware: FirmwareFile | null = null;
let latestVersion: string = '';
let connectionState: ConnectionState = 'disconnected';

// ─── Helpers ────────────────────────────────────────────────────────────────

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

// ─── Public entry point ─────────────────────────────────────────────────────

export function initFlashTools(): void {
    if (!KB1Flasher.isSupported()) {
        el('browser-warning')?.classList.remove('hidden');
        return;
    }

    setupConnectionButtons();
    setupFileUpload();
    setupGitHubFirmwareSelection();
    setupLocalFirmwareFlash();
    setupClearDeviceData();
    setupSerialMonitor();
    setupHelpModal();

    const progressMessage = el('progress-message');
    const progressFill = el('progress-fill');
    const progressPercent = el('progress-percent');
    if (progressMessage) progressMessage.textContent = 'Select a firmware version or upload a .bin file to begin';
    if (progressFill) progressFill.style.width = '0%';
    if (progressPercent) progressPercent.textContent = '0%';

    loadGitHubReleases();

    el('reset-btn')?.addEventListener('click', resetFlash);
    el('retry-btn')?.addEventListener('click', resetFlash);

    el('flash-toast')?.querySelector('.flash-toast-close')?.addEventListener('click', () => {
        el('flash-toast')?.classList.remove('visible');
    });
}

// ─── Connection ─────────────────────────────────────────────────────────────

function setConnState(state: ConnectionState): void {
    connectionState = state;
    const btn = el('conn-btn');
    if (!btn) return;
    btn.setAttribute('data-state', state);
    const label = btn.querySelector<HTMLElement>('.conn-label');
    if (label) {
        label.textContent = state === 'connecting' ? 'CONNECTING...'
            : state === 'connected' ? 'KB1'
                : 'CONNECT';
    }
    btn.title = state === 'connected' ? 'Disconnect KB1' : '';
    updateFlashButtonStates();
}

function setupConnectionButtons(): void {
    const btn = el('conn-btn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        if (connectionState === 'connecting') return;

        if (connectionState === 'connected') {
            if (flasher) {
                try { await flasher.cleanup(); } catch { /* ignore */ }
                flasher = null;
            }
            setConnState('disconnected');
            clearDeviceInfo();
            resetFlash();
            return;
        }

        try {
            setConnState('connecting');

            if (!flasher) {
                flasher = new KB1Flasher();
                flasher.onStatus((s: FlashStatus) => updateFlashUI(s));
                flasher.onDisconnect(handleAutoDisconnect);
            }

            await flasher.requestPort();
            await flasher.connectToDevice();
            await loadDeviceInfo();
            await flasher.resetToFirmware();

            // Read boot banner in background — device is already outputting it after reset
            void flasher.readBootBanner().then(version => {
                if (!version) return;
                const versionEl = el('device-firmware-version');
                const banner = el('firmware-version-banner');
                if (versionEl) versionEl.textContent = `v${version}`;
                if (banner) banner.classList.add('has-version');
            });

            setConnState('connected');
        } catch (err) {
            setConnState('disconnected');
            const msg = err instanceof Error ? err.message : 'Failed to connect to device';
            alert(msg);
        }
    });
}

function handleAutoDisconnect(): void {
    if (serialMonitor) {
        void serialMonitor.disconnect().catch((error) => {
            console.warn('Error during serial monitor disconnect:', error);
        });
        serialMonitor = null;
        el('serial-connect-btn')?.classList.remove('hidden');
        el('serial-disconnect-btn')?.classList.add('hidden');
        const portLabel = el('terminal-port-label');
        if (portLabel) portLabel.textContent = '● Monitor closed';
    }

    flasher = null;
    setConnState('disconnected');
    clearDeviceInfo();
    resetFlash();
    showToast('Device disconnected — USB unplugged', 'info');
}

function updateFlashButtonStates(): void {
    const flashGitHubBtn = el<HTMLButtonElement>('flash-github-btn');
    const flashLocalBtn = el<HTMLButtonElement>('flash-local-btn');
    if (!flashGitHubBtn || !flashLocalBtn) return;

    const connected = connectionState === 'connected';
    const connecting = connectionState === 'connecting';
    const hasGitHubSelection = !!(window as any).selectedRelease;
    const hasLocalFile = flashLocalBtn.style.display === 'block';

    const githubDisabled = !connected || connecting || !hasGitHubSelection;
    const localDisabled = !connected || connecting || !hasLocalFile;

    const githubReason = !connected && !connecting
        ? 'Please connect your KB1 device first'
        : connecting ? 'Connecting…' : !hasGitHubSelection ? 'Select a firmware version' : '';
    const localReason = !connected && !connecting
        ? 'Please connect your KB1 device first'
        : connecting ? 'Connecting…' : !hasLocalFile ? 'Upload a firmware file first' : '';

    flashGitHubBtn.classList.toggle('btn-disabled', githubDisabled);
    flashGitHubBtn.classList.toggle('btn-ready', !githubDisabled);
    if (githubReason) flashGitHubBtn.setAttribute('data-disabled-reason', githubReason);
    else flashGitHubBtn.removeAttribute('data-disabled-reason');

    flashLocalBtn.classList.toggle('btn-disabled', localDisabled);
    flashLocalBtn.classList.toggle('btn-ready', !localDisabled);
    if (localReason) flashLocalBtn.setAttribute('data-disabled-reason', localReason);
    else flashLocalBtn.removeAttribute('data-disabled-reason');
}

// ─── Device Info ────────────────────────────────────────────────────────────

async function loadDeviceInfo(): Promise<void> {
    // Populate static values first, then enrich with live device info
    const set = (id: string, v: string) => { const e = el(id); if (e) e.textContent = v; };
    set('device-name', 'KB1');
    set('device-chip-type', 'ESP32-S3');
    set('device-flash-size', '8 MB');
    // Firmware version is detected from serial output — show placeholder until detected
    const banner = el('firmware-version-banner');
    const versionEl = el('device-firmware-version');
    if (versionEl) versionEl.textContent = '—';
    if (banner) banner.classList.remove('has-version');

    // Read live chip description from bootloader
    if (flasher) {
        const info = await flasher.getDeviceInfo();
        if (info) {
            set('device-chip-type', info.chipDescription || 'ESP32-S3');
        }
    }

    await loadNVSData();
}

async function loadNVSData(): Promise<void> {
    try {
        if (!flasher) return;
        await flasher.readNVS();
        const raw = flasher.getNVSBackup();
        if (!raw) return;
        const nvs = parseNVSBatteryData(raw);
        const set = (id: string, v: string) => { const e = el(id); if (e) e.textContent = v; };
        const ms2h = (ms: number) => `${(ms / 3600000).toFixed(2)} h`;
        set('nvs-bat-pct', nvs.percentage != null ? `${nvs.percentage}%` : '—');
        set('nvs-bat-ble-on-ms', nvs.bleOnTimeMs != null ? ms2h(nvs.bleOnTimeMs) : '—');
        set('nvs-bat-ble-off-ms', nvs.bleOffTimeMs != null ? ms2h(nvs.bleOffTimeMs) : '—');
        set('nvs-bat-disch-ms', nvs.dischargeTimeMs != null ? ms2h(nvs.dischargeTimeMs) : '—');
        set('nvs-bat-cal-time', nvs.calibrationTime ? new Date(nvs.calibrationTime * 1000).toLocaleString() : '—');
        set('nvs-is-charging', nvs.isChargingMode ? 'Yes' : 'No');
        set('nvs-usb-boot', nvs.usbAtBoot ? 'Yes' : 'No');
    } catch (err) {
        console.error('Failed to load NVS data:', err);
    }
}

function clearDeviceInfo(): void {
    ['device-name', 'device-chip-type', 'device-flash-size',
        'device-firmware-version', 'nvs-bat-pct', 'nvs-bat-ble-on-ms',
        'nvs-bat-ble-off-ms', 'nvs-bat-disch-ms', 'nvs-bat-cal-time',
        'nvs-is-charging', 'nvs-usb-boot'].forEach(id => {
            const e = el(id);
            if (e) e.textContent = '—';
        });
    el('firmware-version-banner')?.classList.remove('has-version');
}

// ─── File Upload ─────────────────────────────────────────────────────────────

function setupFileUpload(): void {
    const fileInput = el<HTMLInputElement>('file-input');
    const fileDropZone = el('file-drop-zone');
    if (!fileInput || !fileDropZone) return;

    fileInput.addEventListener('change', (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file?.name.endsWith('.bin')) loadLocalFirmware(file);
    });

    fileDropZone.addEventListener('dragover', (e) => { e.preventDefault(); fileDropZone.classList.add('drag-over'); });
    fileDropZone.addEventListener('dragleave', () => fileDropZone.classList.remove('drag-over'));
    fileDropZone.addEventListener('drop', (e) => {
        (e as DragEvent).preventDefault();
        fileDropZone.classList.remove('drag-over');
        const file = (e as DragEvent).dataTransfer?.files[0];
        if (file?.name.endsWith('.bin')) loadLocalFirmware(file);
    });
}

async function loadLocalFirmware(file: File): Promise<void> {
    const fileName = el('file-name');
    const flashLocalBtn = el<HTMLButtonElement>('flash-local-btn');
    try {
        if (fileName) fileName.textContent = `Loading ${file.name}…`;
        const data = await file.arrayBuffer();
        currentFirmware = { name: file.name, data, source: 'local' };
        if (fileName) fileName.textContent = `${file.name} (${(data.byteLength / 1024 / 1024).toFixed(2)} MB) — Ready`;
        if (flashLocalBtn) flashLocalBtn.style.display = 'block';
        updateFlashButtonStates();
    } catch (err) {
        console.error('Failed to load firmware:', err);
        if (fileName) fileName.textContent = 'Drop .bin file or click to browse';
        if (flashLocalBtn) flashLocalBtn.style.display = 'none';
        showToast('Failed to load firmware file', 'error');
    }
}

// ─── GitHub Releases ─────────────────────────────────────────────────────────

async function loadGitHubReleases(): Promise<void> {
    const releasesLoading = el('releases-loading');
    const releasesList = el('releases-list');
    const flashGitHubBtn = el<HTMLButtonElement>('flash-github-btn');
    const versionNumber = el('version-number');
    if (!releasesLoading || !releasesList || !flashGitHubBtn) return;

    releasesLoading.style.display = 'flex';
    releasesList.style.display = 'none';
    flashGitHubBtn.style.display = 'none';

    try {
        const releases = await fetchReleases();
        if (releases.length === 0) {
            releasesLoading.innerHTML = '<p>No releases found</p>';
            return;
        }
        latestVersion = releases[0].version;
        if (versionNumber) versionNumber.textContent = latestVersion;

        const displayReleases = releases.slice(0, 10);
        releasesList.innerHTML = '';
        displayReleases.forEach((release, i) => {
            const item = document.createElement('div');
            item.className = 'release-list-item';
            item.dataset.index = String(i);
            item.innerHTML = `
                <div class="release-version">${release.name}${i === 0 ? ' <span class="release-badge">Latest</span>' : ''}</div>
                <div class="release-meta">${new Date(release.date).toLocaleDateString()}</div>`;
            item.addEventListener('click', () => selectRelease(item, i, displayReleases));
            releasesList.appendChild(item);
        });

        releasesLoading.style.display = 'none';
        releasesList.style.display = 'block';
        flashGitHubBtn.style.display = 'block';
        (window as any).githubReleases = displayReleases;
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        releasesLoading.innerHTML = `<p>Failed to load releases: ${msg}</p>`;
    }
}

function selectRelease(element: HTMLElement, index: number, releases: FirmwareRelease[]): void {
    const alreadySelected = element.classList.contains('selected');
    document.querySelectorAll('.release-list-item').forEach(el => el.classList.remove('selected'));
    if (alreadySelected) {
        (window as any).selectedRelease = null;
    } else {
        element.classList.add('selected');
        (window as any).selectedRelease = releases[index];
    }
    updateFlashButtonStates();
}

// ─── Flash ──────────────────────────────────────────────────────────────────

function setupGitHubFirmwareSelection(): void {
    el('flash-github-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const reason = btn.getAttribute('data-disabled-reason');
        if (reason) { showToast(reason, 'info'); return; }
        const release: FirmwareRelease | undefined = (window as any).selectedRelease;
        if (!release) return;
        try {
            const data = await downloadFirmware(release.filename);
            currentFirmware = { name: release.name, data, source: 'github' };
            await startFlash();
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Download failed', 'error');
        }
    });
}

function setupLocalFirmwareFlash(): void {
    el('flash-local-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const reason = btn.getAttribute('data-disabled-reason');
        if (reason) { showToast(reason, 'info'); return; }
        if (!currentFirmware || currentFirmware.source !== 'local') { showToast('No firmware file loaded', 'error'); return; }
        await startFlash();
    });
}

async function startFlash(): Promise<void> {
    if (!flasher || !currentFirmware) return;

    // Serial monitor and flasher share the same serial port — they cannot run
    // simultaneously. Disconnect the monitor before flashing so the ReadableStream
    // is unlocked and the Transport can call getReader() without error.
    if (serialMonitor) {
        try { await serialMonitor.disconnect(); } catch { /* ignore */ }
        serialMonitor = null;
        el('serial-connect-btn')?.classList.remove('hidden');
        el('serial-disconnect-btn')?.classList.add('hidden');
        const portLabel = el('terminal-port-label');
        if (portLabel) portLabel.textContent = '● Monitor closed';
    }

    const clearToggle = el<HTMLInputElement>('clear-data-toggle');
    try {
        await flasher.flash(currentFirmware.data, clearToggle?.checked ?? false);
    } catch (err) {
        showError(err instanceof Error ? err.message : 'Flash failed');
    }
}

function setupClearDeviceData(): void {
    const clearBtn = el<HTMLButtonElement>('clear-device-data-btn');
    const clearToggle = el<HTMLInputElement>('clear-data-toggle');
    const clearWarning = el('clear-data-warning');
    const backupStep = document.querySelector<HTMLElement>('.step[data-step="backing-up-nvs"]');
    const restoreStep = document.querySelector<HTMLElement>('.step[data-step="restoring-nvs"]');

    clearToggle?.addEventListener('change', () => {
        clearWarning?.classList.toggle('hidden', !clearToggle.checked);
        backupStep?.classList.toggle('step-skipped', clearToggle.checked);
        restoreStep?.classList.toggle('step-skipped', clearToggle.checked);
    });

    clearBtn?.addEventListener('click', async () => {
        if (!confirm('This will permanently erase all presets, calibration data, and settings from your KB1.\n\nAre you sure?')) return;
        clearBtn.disabled = true;
        clearBtn.textContent = 'Clearing…';
        try {
            const cf = new KB1Flasher();
            cf.onStatus((s: FlashStatus) => updateFlashUI(s));
            await cf.requestPort();
            el('flash-complete')?.classList.add('hidden');
            el('flash-error')?.classList.add('hidden');
            await cf.clearDeviceData();
            showToast('Device data cleared successfully', 'success');
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to clear device data', 'error');
        } finally {
            clearBtn.disabled = false;
            clearBtn.textContent = 'Clear Device Data';
        }
    });
}

// ─── Progress UI ─────────────────────────────────────────────────────────────

function updateFlashUI(status: FlashStatus): void {
    if (status.step === 'error') { showError(status.error || status.message); return; }
    if (status.step === 'complete') { showComplete(); return; }

    const progressFill = el('progress-fill');
    const progressPercent = el('progress-percent');
    const progressMessage = el('progress-message');

    if (progressFill) progressFill.style.width = `${status.progress}%`;
    if (progressPercent) progressPercent.textContent = `${status.progress}%`;
    if (progressMessage) progressMessage.textContent = status.message;

    const stepOrder = ['checking-usb', 'backing-up-nvs', 'flashing-firmware', 'restoring-nvs'];
    const curIdx = stepOrder.indexOf(status.step);

    document.querySelectorAll<HTMLElement>('.step').forEach(step => {
        const name = step.getAttribute('data-step')!;
        const idx = stepOrder.indexOf(name);
        const fill = step.querySelector<HTMLElement>('.step-progress-fill');

        step.classList.remove('active', 'complete');

        if (name === status.step && !step.classList.contains('step-skipped')) {
            step.classList.add('active');
            const pct = name === 'checking-usb' ? Math.min(status.progress * 10, 100)
                : name === 'backing-up-nvs' ? Math.min((status.progress - 10) * 5, 100)
                    : name === 'flashing-firmware' ? Math.min((status.progress - 30) * 2, 100)
                        : Math.min((status.progress - 80) * 6.67, 100);
            if (fill) fill.style.width = `${pct}%`;
        } else if (idx < curIdx && !step.classList.contains('step-skipped')) {
            step.classList.add('complete');
            if (fill) fill.style.width = '100%';
        } else if (idx > curIdx) {
            if (fill) fill.style.width = '0%';
        }
    });
}

function showComplete(): void {
    const progressFill = el('progress-fill');
    const progressPercent = el('progress-percent');
    const progressMessage = el('progress-message');
    if (progressFill) { progressFill.style.width = '100%'; progressFill.classList.add('success'); }
    if (progressPercent) progressPercent.textContent = '100%';
    if (progressMessage) progressMessage.textContent = 'Firmware update complete! Device is ready.';

    document.querySelectorAll<HTMLElement>('.step').forEach(step => {
        step.classList.remove('active');
        if (!step.classList.contains('step-skipped')) {
            step.classList.add('complete');
            const fill = step.querySelector<HTMLElement>('.step-progress-fill');
            if (fill) fill.style.width = '100%';
        }
    });
    showToast('Firmware update complete! Reconnecting…', 'success');
    el('flash-complete')?.classList.remove('hidden');

    // Auto-reconnect after flash: device needs ~3s to boot before bootloader is ready
    setTimeout(() => void autoReconnectAfterFlash(), 3000);
}

async function autoReconnectAfterFlash(): Promise<void> {
    if (!flasher) flasher = new KB1Flasher();
    flasher.onStatus((s: FlashStatus) => updateFlashUI(s));
    flasher.onDisconnect(handleAutoDisconnect);

    try {
        const found = await flasher.reuseGrantedPort();
        if (!found) return; // port no longer available — user will reconnect manually

        await flasher.connectToDevice();
        await loadDeviceInfo();
        await flasher.resetToFirmware();

        void flasher.readBootBanner().then(version => {
            if (!version) return;
            const versionEl = el('device-firmware-version');
            const banner = el('firmware-version-banner');
            if (versionEl) versionEl.textContent = `v${version}`;
            if (banner) banner.classList.add('has-version');
        });

        resetProgressUI();
        setConnState('connected');
        showToast('Reconnected — running new firmware.', 'success');
    } catch {
        // Silent — user can reconnect manually if needed
        setConnState('disconnected');
    }
}

function resetProgressUI(): void {
    el('flash-complete')?.classList.add('hidden');
    el('flash-error')?.classList.add('hidden');
    const pf = el('progress-fill');
    const pp = el('progress-percent');
    const pm = el('progress-message');
    if (pf) { pf.style.width = '0%'; pf.classList.remove('success'); }
    if (pp) pp.textContent = '0%';
    if (pm) pm.textContent = 'Select a firmware version or upload a .bin file to begin';
    document.querySelectorAll<HTMLElement>('.step').forEach(step => {
        step.classList.remove('active', 'complete');
        const fill = step.querySelector<HTMLElement>('.step-progress-fill');
        if (fill) fill.style.width = '0%';
    });
}

function showError(message: string): void {
    el('flash-error')?.classList.remove('hidden');
    const em = el('error-message');
    if (em) em.textContent = message;
    showToast(message, 'error');
}

async function resetFlash(): Promise<void> {
    if (flasher) { try { await flasher.cleanup(); } catch { /* ignore */ } }
    el('flash-complete')?.classList.add('hidden');
    el('flash-error')?.classList.add('hidden');

    currentFirmware = null;
    const fileName = el('file-name');
    const fileInput = el<HTMLInputElement>('file-input');
    const flashLocalBtn = el<HTMLButtonElement>('flash-local-btn');
    if (fileName) fileName.textContent = 'Drop .bin file or click to browse';
    if (fileInput) fileInput.value = '';
    if (flashLocalBtn) flashLocalBtn.style.display = 'none';

    (window as any).selectedRelease = null;
    document.querySelectorAll<HTMLElement>('.release-list-item').forEach(el => el.classList.remove('selected'));

    updateFlashButtonStates();

    const pf = el('progress-fill');
    const pp = el('progress-percent');
    const pm = el('progress-message');
    if (pf) { pf.style.width = '0%'; pf.classList.remove('success'); }
    if (pp) pp.textContent = '0%';
    if (pm) pm.textContent = 'Select a firmware version or upload a .bin file to begin';

    document.querySelectorAll<HTMLElement>('.step').forEach(step => {
        step.classList.remove('active', 'complete');
        const fill = step.querySelector<HTMLElement>('.step-progress-fill');
        if (fill) fill.style.width = '0%';
    });
}

// ─── Serial Monitor ──────────────────────────────────────────────────────────

function setupSerialMonitor(): void {
    const serialConnectBtn = el('serial-connect-btn');
    const serialDisconnectBtn = el('serial-disconnect-btn');
    const serialClearBtn = el('serial-clear-btn');
    const serialOutput = el('serial-output');
    const autoScrollCheckbox = el<HTMLInputElement>('auto-scroll');
    const portLabel = el('terminal-port-label');
    if (!serialConnectBtn || !serialOutput) return;

    serialConnectBtn.addEventListener('click', async () => {
        try {
            serialMonitor = new SerialMonitor();
            serialMonitor.onData((line: string) => {
                const div = document.createElement('div');
                div.className = 'serial-line-info';
                div.textContent = line;
                serialOutput.appendChild(div);
                if (autoScrollCheckbox?.checked) serialOutput.scrollTop = serialOutput.scrollHeight;
                // Detect firmware version from boot banner: "KB1 FIRMWARE v2.2.0"
                const vMatch = line.match(/KB1 FIRMWARE v(\d+\.\d+\.\d+)/i);
                if (vMatch) {
                    const versionEl = el('device-firmware-version');
                    const banner = el('firmware-version-banner');
                    if (versionEl) versionEl.textContent = `v${vMatch[1]}`;
                    if (banner) banner.classList.add('has-version');
                }
            });
            await serialMonitor.connect();
            serialConnectBtn.classList.add('hidden');
            serialDisconnectBtn?.classList.remove('hidden');
            if (portLabel) portLabel.textContent = '● Monitor open';
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to open monitor', 'error');
        }
    });

    serialDisconnectBtn?.addEventListener('click', async () => {
        await serialMonitor?.disconnect();
        serialMonitor = null;
        serialConnectBtn.classList.remove('hidden');
        serialDisconnectBtn.classList.add('hidden');
        if (portLabel) portLabel.textContent = '● Monitor closed';
    });

    serialClearBtn?.addEventListener('click', () => {
        if (serialOutput) serialOutput.innerHTML = '<span class="serial-placeholder">Waiting for serial connection...</span>';
    });
}

// ─── Help Modal ──────────────────────────────────────────────────────────────

function setupHelpModal(): void {
    const overlay = el('help-modal-overlay');
    const contentEl = el('help-modal-content');
    if (!overlay || !contentEl) return;

    document.querySelectorAll<HTMLElement>('.help-btn[data-modal], .flash-sidebar-btn[data-modal], .file-menu-btn[data-modal]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.modal;
            const tpl = document.getElementById(`${key}-help-content`) as HTMLTemplateElement | null;
            if (tpl) {
                contentEl.innerHTML = '';
                contentEl.appendChild(tpl.content.cloneNode(true));
                overlay.classList.remove('hidden');
            }
        });
    });

    el('help-modal-close')?.addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
}

// ─── Toast ──────────────────────────────────────────────────────────────────

function showToast(message: string, type: 'error' | 'success' | 'info' = 'info'): void {
    const toast = el('flash-toast');
    if (!toast) return;
    const msg = toast.querySelector<HTMLElement>('.flash-toast-msg');
    if (msg) msg.textContent = message;
    toast.className = `flash-toast flash-toast-${type} visible`;
    clearTimeout((toast as any)._t);
    (toast as any)._t = setTimeout(() => toast.classList.remove('visible'), 5000);
}
