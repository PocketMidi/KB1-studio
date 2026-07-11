/**
 * KB1 Flash Tool - Firmware Flasher
 * Ported from KB1-config useFirmwareUpdate.ts composable
 */

import { ESPLoader, Transport } from 'esptool-js';
import type { FlashStatus, FlashStep } from './types';

// NVS partition configuration (from partition table)
const NVS_OFFSET = 0x9000;
const NVS_SIZE = 0x5000; // 20KB

// Flash configuration
const BAUDRATE = 115200;
const FLASH_SIZE = '8MB';
const FLASH_MODE = 'dio';
const FLASH_FREQ = '80m';

// USB vendor ID for Espressif ESP32
const ESPRESSIF_VENDOR_ID = 0x303a;

export class KB1Flasher {
    private port: SerialPort | null = null;
    private transport: Transport | null = null;
    private loader: ESPLoader | null = null;
    private nvsBackup: Uint8Array | null = null;
    private statusCallback: ((status: FlashStatus) => void) | null = null;
    private disconnectCallback: (() => void) | null = null;
    private disconnectHandler: (() => void) | null = null;
    private serialDisconnectHandler: ((event: Event) => void) | null = null;
    private disconnectListenerActive: boolean = false;
    private disconnectNotified: boolean = false;

    /**
     * Check if Web Serial API is supported
     */
    static isSupported(): boolean {
        return 'serial' in navigator && typeof navigator.serial !== 'undefined';
    }

    /**
     * Set status callback for progress updates
     */
    onStatus(callback: (status: FlashStatus) => void): void {
        this.statusCallback = callback;
    }

    /**
     * Set disconnect callback for when device is unplugged
     */
    onDisconnect(callback: () => void): void {
        this.disconnectCallback = callback;
    }

    /**
     * Notify the UI once when the selected device disappears.
     */
    private notifyDisconnect(): void {
        if (this.disconnectNotified) return;

        this.disconnectNotified = true;
        console.log('Device disconnected (USB unplugged)');

        if (this.disconnectCallback) {
            this.disconnectCallback();
        }
    }

    /**
     * Set up disconnect listener on the serial port
     */
    private setupDisconnectListener(): void {
        if (!this.port) return;
        if (this.disconnectListenerActive) return; // Already set up

        // Create bound handler so we can remove it later if needed
        this.disconnectHandler = () => {
            this.disconnectListenerActive = false; // Reset flag
            this.notifyDisconnect();
        };

        this.serialDisconnectHandler = (event: Event) => {
            if (event.target !== this.port) return;

            this.disconnectListenerActive = false; // Reset flag
            this.notifyDisconnect();
        };

        // Listen for disconnect event (fires when USB is unplugged)
        this.port.addEventListener('disconnect', this.disconnectHandler);
        navigator.serial.addEventListener('disconnect', this.serialDisconnectHandler);
        this.disconnectListenerActive = true;
    }

    /**
     * Update flash status
     */
    private updateStatus(step: FlashStep, progress: number, message: string, error?: string): void {
        const status: FlashStatus = { step, progress, message, error };

        console.log(`[${step}] ${progress}% - ${message}`);

        if (this.statusCallback) {
            this.statusCallback(status);
        }
    }

    /**
     * Request USB port from user
     */
    async requestPort(): Promise<void> {
        console.log('Requesting USB serial port...');

        try {
            this.port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: ESPRESSIF_VENDOR_ID }]
            });

            if (!this.port) {
                throw new Error('No USB device selected');
            }

            console.log('USB port selected');
            this.disconnectNotified = false;

            // Set up disconnect listener to detect when USB is unplugged
            this.setupDisconnectListener();
        } catch (error) {
            console.error('Failed to select USB port:', error);
            throw new Error('Failed to select USB port. Make sure KB1 is connected.');
        }
    }

    /**
     * Re-acquire the previously granted port without showing the picker.
     * Returns true if a port was found and assigned.
     */
    async reuseGrantedPort(): Promise<boolean> {
        const ports = await navigator.serial.getPorts();
        const espPort = ports.find(p => p.getInfo().usbVendorId === ESPRESSIF_VENDOR_ID);
        if (!espPort) return false;
        this.port = espPort;
        this.disconnectNotified = false;
        this.setupDisconnectListener();
        return true;
    }

    /**
     * Connect to ESP32 bootloader (public method for initial connection)
     */
    async connectToDevice(): Promise<void> {
        try {
            if (!this.port) {
                throw new Error('No USB port selected');
            }

            console.log('Creating transport and loader...');

            // Create transport (disable verbose logging for better performance)
            this.transport = new Transport(this.port, false);
            this.loader = new ESPLoader({
                transport: this.transport,
                baudrate: BAUDRATE,
                romBaudrate: BAUDRATE,
            });

            // Connect to bootloader
            await this.loader.main();

            console.log('Connected to ESP32 bootloader');

            // Set up disconnect listener after port is opened by transport
            this.setupDisconnectListener();

            // Wait a bit for stub to stabilize
            await new Promise(resolve => setTimeout(resolve, 500));
            console.log('Bootloader ready');
        } catch (error) {
            console.error('Connection failed:', error);
            throw error;
        }
    }

    /**
     * Connect to ESP32 bootloader (private method with status updates for flash workflow)
     */
    private async connect(): Promise<void> {
        this.updateStatus('checking-usb', 0, 'Connecting to KB1...');

        try {
            if (!this.port) {
                throw new Error('No USB port selected');
            }

            console.log('Creating transport and loader...');

            // Create transport (disable verbose logging for better performance)
            this.transport = new Transport(this.port, false);
            this.loader = new ESPLoader({
                transport: this.transport,
                baudrate: BAUDRATE,
                romBaudrate: BAUDRATE,
            });

            // Connect to bootloader
            await this.loader.main();

            console.log('Connected to ESP32 bootloader');

            // Set up disconnect listener after port is opened
            this.setupDisconnectListener();

            this.updateStatus('checking-usb', 5, 'Connected to KB1');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.updateStatus('error', 0, 'Failed to connect', message);
            throw error;
        }
    }

    /**
     * Read NVS data without status updates (for initial device info)
     */
    async readNVS(): Promise<void> {
        if (!this.loader) {
            throw new Error('Not connected to device');
        }

        try {
            // Read with progress callback to prevent timeout
            // Retry up to 3 times if timeout occurs
            let retries = 3;
            let lastError: Error | null = null;

            while (retries > 0) {
                try {
                    this.nvsBackup = await this.loader.readFlash(
                        NVS_OFFSET,
                        NVS_SIZE,
                        (_packet: Uint8Array, progress: number, _totalSize: number) => {
                            // Silent progress callback to keep connection alive
                            // Only log at 25% intervals to reduce console spam
                            if (progress === 0.25 || progress === 0.5 || progress === 0.75 || progress === 1) {
                                console.log(`Reading NVS: ${Math.floor(progress * 100)}%`);
                            }
                        }
                    );
                    console.log(`NVS read complete: ${this.nvsBackup.length} bytes`);
                    return; // Success!
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error('Unknown error');
                    const isTimeout = lastError.message.toLowerCase().includes('timeout');
                    retries--;
                    if (retries > 0) {
                        const reason = isTimeout ? 'timeout (may be unformatted)' : 'error';
                        console.warn(`NVS read failed (${reason}), retrying... (${retries} attempts left)`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }

            // All retries failed - provide context about what this might mean
            const isTimeout = lastError?.message.toLowerCase().includes('timeout');
            if (isTimeout) {
                throw new Error('Timeout reading NVS partition (device may be unformatted or new)');
            }
            throw lastError || new Error('Failed to read NVS after multiple attempts');
        } catch (error) {
            console.error('Failed to read NVS:', error);
            throw error;
        }
    }

    /**
     * Backup NVS partition (battery calibration & settings)
     */
    private async backupNVS(): Promise<void> {
        if (!this.loader) {
            throw new Error('Not connected to device');
        }

        this.updateStatus('backing-up-nvs', 10, 'Backing up battery calibration...');

        try {
            this.nvsBackup = await this.loader.readFlash(
                NVS_OFFSET,
                NVS_SIZE,
                (_packet: Uint8Array, progress: number, totalSize: number) => {
                    const fraction = totalSize > 0 ? progress / totalSize : 0;
                    const percent = 10 + Math.floor(fraction * 20);
                    this.updateStatus('backing-up-nvs', percent, 'Reading settings from device...');
                }
            );

            console.log(`NVS backed up: ${this.nvsBackup.length} bytes`);
            this.updateStatus('backing-up-nvs', 30, 'Settings backed up successfully');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.updateStatus('error', 0, 'Failed to backup settings', message);
            throw error;
        }
    }

    /**
     * Flash firmware binary
     */
    private async flashFirmware(firmwareBinary: ArrayBuffer): Promise<void> {
        if (!this.loader) {
            throw new Error('Not connected to device');
        }

        this.updateStatus('flashing-firmware', 30, 'Flashing firmware...');

        try {
            // Convert ArrayBuffer to binary string (esptool-js expects string)
            // Process in chunks to avoid stack overflow on large files
            const uint8Array = new Uint8Array(firmwareBinary);
            const chunkSize = 8192; // 8KB chunks
            let binaryString = '';
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
                const chunk = uint8Array.subarray(i, i + chunkSize);
                binaryString += String.fromCharCode(...chunk);
            }

            const fileArray = [{
                data: binaryString,
                address: 0x0, // Combined firmware starts at 0x0
            }];

            await this.loader.writeFlash({
                fileArray,
                flashSize: FLASH_SIZE,
                flashMode: FLASH_MODE,
                flashFreq: FLASH_FREQ,
                eraseAll: false,
                compress: true,
                reportProgress: (_fileIndex, written, total) => {
                    const progress = 30 + Math.floor((written / total) * 50);
                    this.updateStatus('flashing-firmware', progress, `Writing firmware: ${Math.floor((written / total) * 100)}%`);
                },
            });

            console.log('Firmware flashed successfully');
            this.updateStatus('flashing-firmware', 80, 'Firmware written successfully');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.updateStatus('error', 0, 'Failed to flash firmware', message);
            throw error;
        }
    }

    /**
     * Restore NVS partition
     */
    private async restoreNVS(): Promise<void> {
        if (!this.loader || !this.nvsBackup) {
            throw new Error('NVS backup not available');
        }

        this.updateStatus('restoring-nvs', 80, 'Restoring battery calibration...');

        try {
            // Convert Uint8Array to binary string
            const binaryString = String.fromCharCode(...this.nvsBackup);

            await this.loader.writeFlash({
                fileArray: [{
                    data: binaryString,
                    address: NVS_OFFSET,
                }],
                flashSize: FLASH_SIZE,
                flashMode: FLASH_MODE,
                flashFreq: FLASH_FREQ,
                eraseAll: false,
                compress: true,
                reportProgress: (_fileIndex, written, total) => {
                    const progress = 80 + Math.floor((written / total) * 15);
                    this.updateStatus('restoring-nvs', progress, 'Restoring settings...');
                },
            });

            console.log('NVS restored successfully');
            this.updateStatus('restoring-nvs', 95, 'Settings restored successfully');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.updateStatus('error', 0, 'Failed to restore settings', message);
            throw error;
        }
    }

    /**
     * Get NVS backup data (for inspection)
     */
    getNVSBackup(): Uint8Array | null {
        return this.nvsBackup;
    }

    /**
     * Read MAC address and chip description from the connected bootloader.
     * Must be called after connectToDevice() and before resetToFirmware().
     */
    async getDeviceInfo(): Promise<{ mac: string; chipDescription: string } | null> {
        if (!this.loader) return null;
        try {
            const mac = await this.loader.chip.readMac(this.loader);
            const chipDesc = await this.loader.chip.getChipDescription(this.loader);
            return { mac, chipDescription: chipDesc };
        } catch {
            return null;
        }
    }

    /**
     * Reset device to firmware mode and close bootloader connection
     * This allows serial monitor to connect to the running firmware
     */
    async resetToFirmware(): Promise<void> {
        try {
            if (this.loader) {
                console.log('Performing hard reset...');
                await this.loader.hardReset();
                console.log('Device reset to firmware mode');
            }

            // Close the port to release it for serial monitor
            if (this.transport) {
                await this.transport.disconnect();
                this.transport = null;
            }

            this.loader = null;
            // Keep port reference for re-connection during flash
        } catch (error) {
            console.error('Failed to reset device:', error);
            throw error;
        }
    }

    /**
     * After resetToFirmware(), briefly open the port at 115200 to read the
     * boot banner and extract the firmware version string.
     * Returns e.g. "2.2.0" or null if not detected within the timeout.
     */
    async readBootBanner(timeoutMs = 3000): Promise<string | null> {
        if (!this.port) return null;
        try {
            await this.port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
            const reader = this.port.readable!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let version: string | null = null;
            const deadline = Date.now() + timeoutMs;
            try {
                while (Date.now() < deadline) {
                    const timeout = new Promise<{ value: undefined; done: true }>(res =>
                        setTimeout(() => res({ value: undefined, done: true }), 200)
                    );
                    const result = await Promise.race([reader.read(), timeout]);
                    if (result.done) {
                        if (version) break; // got what we needed
                        continue;
                    }
                    buffer += decoder.decode(result.value);
                    const match = buffer.match(/KB1 FIRMWARE v(\d+\.\d+\.\d+)/i);
                    if (match) { version = match[1]; break; }
                    // trim buffer to avoid unbounded growth
                    if (buffer.length > 4096) buffer = buffer.slice(-2048);
                }
            } finally {
                reader.cancel();
                reader.releaseLock();
            }
            await this.port.close();
            return version;
        } catch {
            // Port may already be open or unavailable — swallow silently
            try { await this.port.close(); } catch { /* ignore */ }
            return null;
        }
    }

    /**
     * Disconnect from device
     */
    private async disconnect(): Promise<void> {
        try {
            if (this.loader) {
                await this.loader.hardReset();
            }

            // Remove disconnect listener before closing port
            if (this.port && this.disconnectHandler) {
                this.port.removeEventListener('disconnect', this.disconnectHandler);
                if (this.serialDisconnectHandler) {
                    navigator.serial.removeEventListener('disconnect', this.serialDisconnectHandler);
                }
                this.disconnectListenerActive = false;
                this.disconnectHandler = null;
                this.serialDisconnectHandler = null;
            }

            if (this.port) {
                await this.port.close();
            }
        } catch (error) {
            console.warn('Error disconnecting:', error);
        } finally {
            this.port = null;
            this.transport = null;
            this.loader = null;
            this.nvsBackup = null;
            this.disconnectNotified = false;
        }
    }

    /**
     * Erase NVS partition (write blank 0xFF bytes)
     */
    async clearNVS(): Promise<void> {
        if (!this.loader) {
            throw new Error('Not connected to device');
        }

        this.updateStatus('clearing-nvs', 10, 'Clearing device data...');

        try {
            const blank = new Uint8Array(NVS_SIZE).fill(0xFF);
            const binaryString = String.fromCharCode(...blank);

            await this.loader.writeFlash({
                fileArray: [{ data: binaryString, address: NVS_OFFSET }],
                flashSize: FLASH_SIZE,
                flashMode: FLASH_MODE,
                flashFreq: FLASH_FREQ,
                eraseAll: false,
                compress: true,
                reportProgress: (_fileIndex, written, total) => {
                    const progress = 10 + Math.floor((written / total) * 20);
                    this.updateStatus('clearing-nvs', progress, 'Clearing device data...');
                },
            });

            console.log('NVS cleared successfully');
            this.updateStatus('clearing-nvs', 30, 'Device data cleared');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.updateStatus('error', 0, 'Failed to clear device data', message);
            throw error;
        }
    }

    /**
     * Main flash workflow
     * @param firmwareBinary - firmware binary to flash
     * @param clearData - if true, skip backup/restore and clear NVS instead
     */
    async flash(firmwareBinary: ArrayBuffer, clearData = false): Promise<void> {
        try {
            // Step 1: Connect to device
            await this.connect();

            if (clearData) {
                // Clear NVS instead of backing up
                await this.clearNVS();
            } else {
                // Step 2: Backup NVS
                await this.backupNVS();
            }

            // Step 3: Flash firmware
            await this.flashFirmware(firmwareBinary);

            if (!clearData) {
                // Step 4: Restore NVS
                await this.restoreNVS();
            }

            // Complete
            this.updateStatus('complete', 100, 'Firmware update complete!');

            // Disconnect and reset device
            await this.disconnect();
        } catch (error) {
            console.error('Firmware update failed:', error);
            await this.disconnect();
            throw error;
        }
    }

    /**
     * Standalone clear device data (without flashing firmware)
     */
    async clearDeviceData(): Promise<void> {
        try {
            await this.connect();
            await this.clearNVS();
            this.updateStatus('complete', 100, 'Device data cleared successfully.');
            await this.disconnect();
        } catch (error) {
            console.error('Clear device data failed:', error);
            await this.disconnect();
            throw error;
        }
    }

    /**
     * Cleanup and release USB port (public for error recovery)
     */
    async cleanup(): Promise<void> {
        console.log('Cleaning up flasher...');
        await this.disconnect();
    }
}
