import { PrismaClient } from '@prisma/client';
import { config } from '../config';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * The connection string is built from the DB_* parts in `src/config`, not read
 * from a DATABASE_URL. Passing it explicitly here is what makes that work:
 * without the `datasources` override Prisma reads `env("DATABASE_URL")` from
 * schema.prisma and ignores the parts entirely.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
