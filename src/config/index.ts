import dotenv from 'dotenv';

dotenv.config();

function resolveDatabaseUrl(): string {
  // If direct connection URL is provided, use it
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const dbType = (process.env.DB_TYPE || 'mysql').toLowerCase();
  const dbUser = process.env.DB_USER || 'root';
  const dbPassword = process.env.DB_PASSWORD || '';
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbPort = process.env.DB_PORT || (dbType === 'postgresql' ? '5432' : '3306');
  const dbName = process.env.DB_NAME || 'vending_db';

  if (dbType === 'postgresql' || dbType === 'postgres') {
    return `postgresql://${dbUser}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}?schema=public`;
  }

  if (dbType === 'mysql') {
    return `mysql://${dbUser}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;
  }

  // Prisma's provider is mysql, so a SQLite URL would fail at startup anyway.
  // Fall back to a mysql URL built from the DB_* parts.
  return `mysql://${dbUser}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database Connection Credentials
  dbType: process.env.DB_TYPE || 'mysql',
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: process.env.DB_PORT || '5432',
  dbUser: process.env.DB_USER || 'vending_user',
  dbPassword: process.env.DB_PASSWORD || '',
  dbName: process.env.DB_NAME || 'vending_db',
  databaseUrl: resolveDatabaseUrl(),

  // EthSwitch / NBE QR Configuration
  ethGuid: process.env.ETH_GUID || '581b314e257f41bfbbdc6384daa31d16',
  acquirerBic: process.env.ACQUIRER_BIC || 'CBETETAA',
  merchantAccount: process.env.MERCHANT_ACCOUNT || '0000171234567890',
  merchantName: process.env.MERCHANT_NAME || 'AFen Smart Vending',
  merchantCity: process.env.MERCHANT_CITY || 'ADDIS ABABA',
  mcc: process.env.MCC || '5999',
  currencyCode: process.env.CURRENCY_CODE || '586',
  countryCode: process.env.COUNTRY_CODE || 'ET',
};
