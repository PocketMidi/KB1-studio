/**
 * KB1 Flash Tool - Firmware Release Fetcher
 *
 * Firmware binaries and the release manifest are served as static files
 * from the same origin (public/firmware/), so there are no CORS issues.
 */

import type { FirmwareRelease } from './types';

// Vite's BASE_URL is '/KB1-flash/' in production, '/' in dev.
const FIRMWARE_BASE = import.meta.env.BASE_URL.replace(/\/$/, '') + '/firmware/';

/**
 * Fetch the firmware release list from the local manifest.
 */
export async function fetchReleases(): Promise<FirmwareRelease[]> {
    try {
        const response = await fetch(FIRMWARE_BASE + 'releases.json');

        if (!response.ok) {
            throw new Error(`Failed to load release manifest: ${response.statusText}`);
        }

        const releases: FirmwareRelease[] = await response.json();
        return releases;
    } catch (error) {
        console.error('Failed to fetch releases:', error);
        throw error;
    }
}

/**
 * Download firmware binary from the same-origin firmware directory.
 */
export async function downloadFirmware(
    filename: string,
    onProgress?: (loaded: number, total: number) => void
): Promise<ArrayBuffer> {
    const url = FIRMWARE_BASE + filename;
    try {
        console.log('Downloading firmware:', url);

        const response = await fetch(url, { method: 'GET' });

        if (!response.ok) {
            throw new Error(`Download failed: ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;

        if (!response.body) {
            throw new Error('Response body is null');
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;

        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            chunks.push(value);
            loaded += value.length;

            if (onProgress && total > 0) {
                onProgress(loaded, total);
            }
        }

        // Combine chunks into single ArrayBuffer
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        return combined.buffer;
    } catch (error) {
        console.error('Failed to download firmware:', error);
        throw error;
    }
}


