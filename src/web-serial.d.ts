/**
 * Web Serial API Type Definitions
 * https://wicg.github.io/serial/
 */

interface Navigator {
    serial: Serial;
}

interface Serial extends EventTarget {
    onconnect: ((this: this, ev: Event) => any) | null;
    ondisconnect: ((this: this, ev: Event) => any) | null;
    getPorts(): Promise<SerialPort[]>;
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    addEventListener(
        type: 'connect' | 'disconnect',
        listener: (this: this, ev: Event) => any,
        useCapture?: boolean
    ): void;
    removeEventListener(
        type: 'connect' | 'disconnect',
        listener: (this: this, ev: Event) => any,
        useCapture?: boolean
    ): void;
}

interface SerialPortRequestOptions {
    filters?: SerialPortFilter[];
}

interface SerialPortFilter {
    usbVendorId?: number;
    usbProductId?: number;
}

interface SerialPort extends EventTarget {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    onconnect: ((this: this, ev: Event) => any) | null;
    ondisconnect: ((this: this, ev: Event) => any) | null;

    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    forget(): Promise<void>;
    getInfo(): SerialPortInfo;
    getSignals(): Promise<SerialOutputSignals>;
    setSignals(signals: SerialOutputSignals): Promise<void>;
}

interface SerialOptions {
    baudRate: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
}

interface SerialPortInfo {
    usbVendorId?: number;
    usbProductId?: number;
}

interface SerialOutputSignals {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
    break?: boolean;
}
