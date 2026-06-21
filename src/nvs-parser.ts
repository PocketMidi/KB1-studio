/**
 * NVS (Non-Volatile Storage) Parser
 * Parses ESP-IDF NVS partition format to extract battery calibration data
 */

export interface BatteryCalibrationData {
    percentage: number | null;
    bleOnTimeMs: number | null;
    bleOffTimeMs: number | null;
    dischargeTimeMs: number | null;
    calibrationTime: number | null;
    isChargingMode: boolean | null;
    usbAtBoot: boolean | null;
}

/**
 * Parse NVS partition data to extract battery calibration values
 * 
 * ESP-IDF NVS format uses a page-based structure with entries containing:
 * - Namespace (string)
 * - Key (string) 
 * - Type (u8, u32, etc.)
 * - Value (variable length)
 * 
 * We search for the "kb1-settings" namespace and extract known battery keys.
 */
export function parseNVSBatteryData(nvsData: Uint8Array): BatteryCalibrationData {
    const result: BatteryCalibrationData = {
        percentage: null,
        bleOnTimeMs: null,
        bleOffTimeMs: null,
        dischargeTimeMs: null,
        calibrationTime: null,
        isChargingMode: null,
        usbAtBoot: null,
    };

    try {
        console.log(`Parsing NVS data: ${nvsData.length} bytes`);

        // Show first 256 bytes in hex for debugging
        const hexPreview = Array.from(nvsData.slice(0, 256))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(' ');
        console.log('NVS Data Preview (first 256 bytes):', hexPreview);

        // Search for our namespace in binary data (not text!)
        const namespaceBytes = new TextEncoder().encode('kb1-settings');
        const namespaceIndex = findBytesInArray(nvsData, namespaceBytes);
        console.log(`Searching for 'kb1-settings' namespace... ${namespaceIndex !== -1 ? 'Found at index ' + namespaceIndex : 'NOT FOUND'}`);

        if (namespaceIndex === -1) {
            console.warn('kb1-settings namespace not found in NVS partition');
            return result;
        }

        // Search for each key in binary data
        // NVS Entry: 8-byte header + 16-byte key + 8-byte data

        // Battery Percentage (UChar/uint8 - 1 byte)
        result.percentage = findU8ValueBinary(nvsData, 'batPct');

        // BLE On Time (ULong/uint32 - 4 bytes, little-endian)
        result.bleOnTimeMs = findU32ValueBinary(nvsData, 'batBleOnMs');

        // BLE Off Time (ULong/uint32 - 4 bytes, little-endian)
        result.bleOffTimeMs = findU32ValueBinary(nvsData, 'batBleOffMs');

        // Discharge Time (UInt/uint32 - 4 bytes)
        result.dischargeTimeMs = findU32ValueBinary(nvsData, 'batDischMs');

        // Calibration Time (UInt/uint32 - 4 bytes)
        result.calibrationTime = findU32ValueBinary(nvsData, 'batCalTime');

        // Is Charging Mode (Bool/uint8 - 1 byte)
        const isCharging = findU8ValueBinary(nvsData, 'batFull');
        result.isChargingMode = isCharging !== null ? isCharging > 0 : null;

        // USB At Boot (Bool/uint8 - 1 byte)
        const usbBoot = findU8ValueBinary(nvsData, 'usbAtBoot');
        result.usbAtBoot = usbBoot !== null ? usbBoot > 0 : null;

        console.log('Parsed NVS battery data:', result);
    } catch (error) {
        console.error('Failed to parse NVS data:', error);
    }

    return result;
}

/**
 * Find byte sequence in array
 */
function findBytesInArray(haystack: Uint8Array, needle: Uint8Array, startFrom: number = 0): number {
    for (let i = startFrom; i <= haystack.length - needle.length; i++) {
        let found = true;
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                found = false;
                break;
            }
        }
        if (found) return i;
    }
    return -1;
}

/**
 * Find and extract a uint8 value from NVS entry (binary search)
 * NVS Entry structure: 8-byte header + 16-byte key + 8-byte data
 * Returns the LAST valid entry found (most recent)
 */
function findU8ValueBinary(data: Uint8Array, key: string): number | null {
    const keyBytes = new TextEncoder().encode(key);
    let searchFrom = 0;
    let lastValidValue: number | null = null;

    // Search for ALL occurrences and keep the last valid one
    while (true) {
        const keyIndex = findBytesInArray(data, keyBytes, searchFrom);
        if (keyIndex === -1) break;

        console.log(`Found '${key}' at binary index ${keyIndex}`);

        // Data field is 16 bytes after key start
        const dataOffset = keyIndex + 16;
        if (dataOffset >= data.length) {
            searchFrom = keyIndex + 1;
            continue;
        }

        console.log(`Bytes at key+16 to key+24:`, Array.from(data.slice(dataOffset, dataOffset + 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));

        const firstByte = data[dataOffset];

        // Skip entries that look erased (0xFF or pattern like 00 ff ff ff)
        if (firstByte === 0xFF || (firstByte === 0x00 && data[dataOffset + 1] === 0xFF)) {
            console.log(`  Entry appears erased, skipping`);
            searchFrom = keyIndex + 1;
            continue;
        }

        // For batPct, look for 0-100 range (skip 254 = uncalibrated default)
        if (key === 'batPct' && firstByte <= 100) {
            console.log(`Found valid ${key} value: ${firstByte}`);
            lastValidValue = firstByte;
        } else if (key === 'batPct' && firstByte === 254) {
            console.log(`  Found uncalibrated value (254), skipping`);
        }

        // For boolean fields
        if ((key === 'batFull' || key === 'usbAtBoot') && (firstByte === 0 || firstByte === 1)) {
            console.log(`Found valid ${key} value: ${firstByte}`);
            lastValidValue = firstByte;
        }

        searchFrom = keyIndex + 1;
    }

    if (lastValidValue !== null) {
        console.log(`Using LAST valid value for ${key}: ${lastValidValue}`);
    } else {
        console.log(`No valid value found for ${key}`);
    }
    return lastValidValue;
}

/**
 * Find and extract a uint32 (little-endian) value from NVS entry (binary search)
 * Returns the LAST valid entry found (most recent)
 */
function findU32ValueBinary(data: Uint8Array, key: string): number | null {
    const keyBytes = new TextEncoder().encode(key);
    let searchFrom = 0;
    let lastValidValue: number | null = null;

    // Search for ALL occurrences and keep the last valid one
    while (true) {
        const keyIndex = findBytesInArray(data, keyBytes, searchFrom);
        if (keyIndex === -1) break;

        console.log(`Found '${key}' at binary index ${keyIndex}`);

        // Data field is 16 bytes after key start
        const dataOffset = keyIndex + 16;
        if (dataOffset + 3 >= data.length) {
            searchFrom = keyIndex + 1;
            continue;
        }

        console.log(`Bytes at key+16 to key+24:`, Array.from(data.slice(dataOffset, dataOffset + 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));

        // Read 4 bytes as little-endian uint32
        const value = data[dataOffset] |
            (data[dataOffset + 1] << 8) |
            (data[dataOffset + 2] << 16) |
            (data[dataOffset + 3] << 24);

        const unsignedValue = value >>> 0;
        console.log(`  Value: ${unsignedValue} (0x${unsignedValue.toString(16)})`);

        // Skip erased entries (all 0xFF or 0x00 followed by 0xFF)
        if (data[dataOffset] === 0xFF ||
            (data[dataOffset] === 0x00 && data[dataOffset + 1] === 0xFF)) {
            console.log(`  Entry appears erased, skipping`);
            searchFrom = keyIndex + 1;
            continue;
        }

        // Accept reasonable time values (including 0, but not max uint32)
        if (unsignedValue < 0xFFFFFF00) {
            console.log(`Found valid ${key} value: ${unsignedValue}`);
            lastValidValue = unsignedValue;
        }

        searchFrom = keyIndex + 1;
    }

    if (lastValidValue !== null) {
        console.log(`Using LAST valid value for ${key}: ${lastValidValue}`);
    } else {
        console.log(`No valid value found for ${key}`);
    }
    return lastValidValue;
}

// Legacy text-based functions (kept for reference, not used)
/**
 * Find and extract a uint32 (little-endian) value from NVS entry
 * Note: Search for ALL occurrences as there may be erased entries
 */
