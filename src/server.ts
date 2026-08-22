import app from './app';
import { config } from './config';
import { prisma } from './lib/prisma';

const PORT = config.port;

const server = app.listen(PORT, () => {
  console.log(`🚀 AFen Vending Machine QR Middleware running on http://localhost:${PORT}`);
  console.log(`🏥 Health check live at http://localhost:${PORT}/`);
  console.log(`📖 Swagger API Docs live at http://localhost:${PORT}/api-docs`);
  console.log(`🛠️ Developer Workbench live at http://localhost:${PORT}/workbench`);
  console.log(`💳 Electric Pay endpoint live at http://localhost:${PORT}/api/vending/pay`);
  console.log(`📦 Electric Pickup polling live at http://localhost:${PORT}/api/vending/vend`);
  console.log(`🔔 Telebirr notify callback live at http://localhost:${PORT}/api/webhooks/telebirr`);
  console.log(`🔍 Diagnostic endpoints live at http://localhost:${PORT}/test/pay & /test/vend`);
});

/**
 * Graceful shutdown.
 *
 * pm2 sends SIGINT on restart/reload and waits `kill_timeout` before forcing.
 * Draining first means an in-flight Telebirr callback finishes writing rather
 * than being cut off midway, which would leave a paid order un-fulfilled.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] shutting down, draining connections...`);

  server.close(async () => {
    try {
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error disconnecting Prisma', error);
    }
    console.log('Shutdown complete.');
    process.exit(0);
  });

  // Backstop: never hang past pm2's kill_timeout waiting on a stuck socket.
  setTimeout(() => {
    console.error('Drain timed out, forcing exit.');
    process.exit(1);
  }, 7000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
