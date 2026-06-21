/**
 * KB1 Flash Tool - Serial Monitor
 */

export class SerialMonitor {
    private port: SerialPort | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private isReading = false;
    private onDataCallback: ((text: string) => void) | null = null;

    /**
     * Set data callback
     */
    onData(callback: (text: string) => void): void {
        this.onDataCallback = callback;
    }

    /**
     * Check if connected
     */
    get connected(): boolean {
        return this.port !== null && this.isReading;
    }

    /**
     * Request serial port and connect
     */
    async connect(): Promise<void> {
        if (this.port) {
            throw new Error('Already connected');
        }

        try {
            // Use a previously-granted port if available (avoids the picker dialog)
            const grantedPorts = await navigator.serial.getPorts();
            const espPort = grantedPorts.find(p => {
                const info = p.getInfo();
                return info.usbVendorId === 0x303a;
            });

            if (espPort) {
                this.port = espPort;
            } else {
                // First time: ask the user to select the port
                this.port = await navigator.serial.requestPort({
                    filters: [{ usbVendorId: 0x303a }] // Espressif ESP32
                });
            }

            if (!this.port) {
                throw new Error('No port selected');
            }

            // Open port
            await this.port.open({
                baudRate: 115200,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
            });

            console.log('Serial port opened');

            // Start reading
            this.startReading();
        } catch (error) {
            console.error('Failed to connect:', error);
            this.port = null;
            throw error;
        }
    }

    /**
     * Start reading from serial port
     */
    private async startReading(): Promise<void> {
        if (!this.port || !this.port.readable) {
            return;
        }

        this.isReading = true;
        this.reader = this.port.readable.getReader();

        try {
            const decoder = new TextDecoder();

            while (this.isReading && this.reader) {
                const { value, done } = await this.reader.read();

                if (done) {
                    break;
                }

                if (value) {
                    const text = decoder.decode(value);

                    if (this.onDataCallback) {
                        this.onDataCallback(text);
                    }
                }
            }
        } catch (error) {
            if (this.isReading) {
                console.error('Read error:', error);
            }
        } finally {
            if (this.reader) {
                this.reader.releaseLock();
                this.reader = null;
            }
        }
    }

    /**
     * Disconnect from serial port
     */
    async disconnect(): Promise<void> {
        this.isReading = false;

        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (error) {
                console.warn('Error canceling reader:', error);
            }
            this.reader = null;
        }

        if (this.port) {
            try {
                await this.port.close();
            } catch (error) {
                console.warn('Error closing port:', error);
            }
            this.port = null;
        }

        console.log('Serial port closed');
    }
}
