/**
 * Runs a Prisma CLI command with DATABASE_URL derived from the DB_* parts.
 *
 * The Prisma CLI only reads `env("DATABASE_URL")` from schema.prisma; it does
 * not know about DB_HOST / DB_USER and friends. This builds the URL the same
 * way the app does, sets it for the child process only, and never writes it to
 * a file, so the credentials stay in the DB_* variables.
 *
 *   node scripts/prisma-cli.js db push
 *   node scripts/prisma-cli.js generate
 */
require('dotenv').config();
const { spawnSync } = require('node:child_process');

function buildUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const type = (process.env.DB_TYPE || 'mysql').toLowerCase();
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || (type.startsWith('postgres') ? '5432' : '3306');
  const name = process.env.DB_NAME || 'vending_db';
  const scheme = type.startsWith('postgres') ? 'postgresql' : type;
  const suffix = type.startsWith('postgres') ? '?schema=public' : '';

  return `${scheme}://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}${suffix}`;
}

const url = buildUrl();
// Log the target without the password, so a wrong host is obvious.
console.log('[prisma] ' + url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@'));

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['prisma', ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } }
);

process.exit(result.status ?? 1);
