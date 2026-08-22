import { config } from '../config';
import { formatTlv } from '../utils/tlvEncoder';
import { calculateCrc16CcittFalse } from '../utils/crc16';

export interface QrOptions {
  amount: number;
  orderNo: string;
  machineId: string;
  merchantName?: string;
  merchantCity?: string;
  ethGuid?: string;
  acquirerBic?: string;
  merchantAccount?: string;
  mcc?: string;
  currencyCode?: string;
  countryCode?: string;
}

export function generateEthSwitchQr(options: QrOptions): string {
  const ethGuid = options.ethGuid || config.ethGuid;
  const acquirerBic = options.acquirerBic || config.acquirerBic;
  const merchantAccount = options.merchantAccount || config.merchantAccount;
  const merchantName = (options.merchantName || config.merchantName).slice(0, 25);
  const merchantCity = (options.merchantCity || config.merchantCity).slice(0, 15);
  const mcc = options.mcc || config.mcc;
  const currencyCode = options.currencyCode || config.currencyCode;
  const countryCode = options.countryCode || config.countryCode;

  // Tag 00: Payload Format Indicator
  const tag00 = formatTlv('00', '01');

  // Tag 01: Point of Initiation Method (12 = Dynamic QR)
  const tag01 = formatTlv('01', '12');

  // Tag 28: Domestic Scheme (IPS ET)
  const subTag00 = formatTlv('00', ethGuid);
  const subTag01 = formatTlv('01', acquirerBic);
  const subTag02 = formatTlv('02', merchantAccount);
  const tag28Value = `${subTag00}${subTag01}${subTag02}`;
  const tag28 = formatTlv('28', tag28Value);

  // Tag 52: Merchant Category Code
  const tag52 = formatTlv('52', mcc);

  // Tag 53: Transaction Currency Code
  const tag53 = formatTlv('53', currencyCode);

  // Tag 54: Transaction Amount (formatted to 2 decimal places)
  const formattedAmount = options.amount.toFixed(2);
  const tag54 = formatTlv('54', formattedAmount);

  // Tag 58: Country Code
  const tag58 = formatTlv('58', countryCode);

  // Tag 59: Merchant Name
  const tag59 = formatTlv('59', merchantName);

  // Tag 60: Merchant City
  const tag60 = formatTlv('60', merchantCity);

  // Tag 62: Additional Data Template (05 = Order Reference, 07 = Terminal Label / Machine ID)
  const subTag05 = formatTlv('05', options.orderNo);
  const subTag07 = formatTlv('07', options.machineId);
  const tag62Value = `${subTag05}${subTag07}`;
  const tag62 = formatTlv('62', tag62Value);

  // Raw string before CRC calculation (appended with Tag 63 ID '63' and Length '04')
  const payloadWithoutCrc = `${tag00}${tag01}${tag28}${tag52}${tag53}${tag54}${tag58}${tag59}${tag60}${tag62}6304`;

  // Calculate CRC-16/CCITT-FALSE
  const crc = calculateCrc16CcittFalse(payloadWithoutCrc);

  // Full EMVCo String
  return `${payloadWithoutCrc}${crc}`;
}
