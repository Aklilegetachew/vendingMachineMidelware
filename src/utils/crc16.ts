/**
 * Calculates CRC-16/CCITT-FALSE checksum for EMVCo QR code string validation.
 * Specification:
 * - Polynomial: 0x1021
 * - Initial Value: 0xFFFF
 * - RefIn / RefOut: false
 * - XOROut: 0x0000
 *
 * @param data Input string (including '6304' at the end)
 * @returns 4-character uppercase hexadecimal checksum (e.g. '5376')
 */
export function calculateCrc16CcittFalse(data: string): string {
  let crc = 0xffff;
  const polynomial = 0x1021;

  for (let i = 0; i < data.length; i++) {
    const byte = data.charCodeAt(i);
    crc ^= (byte << 8) & 0xffff;

    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ polynomial) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }

  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}
