import { describe, it, expect } from 'vitest';
import { generateEthSwitchQr } from '../src/services/qrEngine';

describe('EthSwitch Dynamic QR Engine', () => {
  it('should generate valid EMVCo TLV string with correct tags and 2-decimal amount', () => {
    const qrString = generateEthSwitchQr({
      amount: 25,
      orderNo: 'ORD123456',
      machineId: '2504150044',
      ethGuid: '581b314e257f41bfbbdc6384daa31d16',
      acquirerBic: 'CBETETAA',
      merchantAccount: '0000171234567890',
      merchantName: 'AFen Smart Vending',
      merchantCity: 'ADDIS ABABA',
    });

    // Tag 00: Payload Format Indicator = 01
    expect(qrString).toContain('000201');

    // Tag 01: Dynamic QR = 12
    expect(qrString).toContain('010212');

    // Tag 54: Amount = 25.00
    expect(qrString).toContain('540525.00');

    // Tag 58: Country = ET
    expect(qrString).toContain('5802ET');

    // Tag 62 Sub-tag 05: Order No = ORD123456
    expect(qrString).toContain('0509ORD123456');

    // Tag 62 Sub-tag 07: Machine ID = 2504150044
    expect(qrString).toContain('07102504150044');

    // Tag 63: CRC prefix
    expect(qrString).toContain('6304');

    // Total string length validation
    expect(qrString.length).toBeGreaterThan(150);
  });
});
