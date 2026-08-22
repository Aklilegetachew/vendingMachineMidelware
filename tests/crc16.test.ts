import { describe, it, expect } from 'vitest';
import { calculateCrc16CcittFalse } from '../src/utils/crc16';

describe('CRC-16/CCITT-FALSE Algorithm', () => {
  it('should match standard CRC-16/CCITT-FALSE test vector ("123456789" -> "29B1")', () => {
    const stdResult = calculateCrc16CcittFalse('123456789');
    expect(stdResult).toBe('29B1');
  });

  it('should compute valid 4-character uppercase hex CRC for EMVCo raw string', () => {
    const rawPayload =
      '00020101021202164000123456789012041653451234567890121516634512345678901228760032581b314e257f41bfbbdc6384daa31d160108CBETETAA021600001712345678905204599953035865802ET5924TewodrosSpices&Grains6010ADDISABABA62890117234567854321234560211032400000000324Tewodros Spices & Grains0513123876543212307124567890987656304';

    const calculatedChecksum = calculateCrc16CcittFalse(rawPayload);

    expect(calculatedChecksum).toHaveLength(4);
    expect(calculatedChecksum).toMatch(/^[0-9A-F]{4}$/);
  });
});
