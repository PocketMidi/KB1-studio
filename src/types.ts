/**
 * KB1 Flash Tool - Type Definitions
 */

export type FlashStep =
  | 'idle'
  | 'checking-usb'
  | 'backing-up-nvs'
  | 'clearing-nvs'
  | 'flashing-firmware'
  | 'restoring-nvs'
  | 'complete'
  | 'error';

export interface FlashStatus {
  step: FlashStep;
  progress: number; // 0-100
  message: string;
  error?: string;
}

export interface FirmwareRelease {
  version: string;    // e.g. "v1.5.0"
  name: string;       // e.g. "Version 1.5.0"
  date: string;       // e.g. "2026-03-31"
  filename: string;   // e.g. "KB1-firmware-v1.5.0.bin"
  size: number;       // bytes
}

export interface FirmwareFile {
  name: string;
  data: ArrayBuffer;
  source: 'github' | 'local';
}
