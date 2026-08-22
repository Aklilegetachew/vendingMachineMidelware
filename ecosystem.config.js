/**
 * PM2 process definition for the vending machine middleware.
 *
 * Run the compiled output (`npm run build` first), not tsx - the TypeScript
 * watcher is a development tool and adds a compile step to every restart.
 */
module.exports = {
  apps: [
    {
      name: 'vending-middleware',
      script: 'dist/server.js',

      // Resolved relative to this file, so pm2 can be invoked from anywhere.
      // The app reads views/, public/ and .env from the working directory, so
      // this must stay the project root.
      cwd: __dirname,

      /**
       * Fork mode with a single instance - deliberately NOT cluster.
       *
       * Two pieces of state live in the process and would silently break if
       * requests were spread across workers:
       *   - the SSE client registry in services/eventBroadcaster (a broadcast
       *     would only reach viewers attached to the same worker)
       *   - the cached Telebirr signing mode in services/telebirr/client
       *
       * SQLite adds a third reason: concurrent writers hit lock contention.
       * Moving to Postgres and an external pub/sub is what unlocks cluster mode.
       */
      exec_mode: 'fork',
      instances: 1,

      env: {
        NODE_ENV: 'production',
        PORT: 14000,
      },

      // Restart policy. A crash loop backs off instead of hammering the DB.
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      min_uptime: '10s',
      max_memory_restart: '400M',

      // Logs land in ./logs, which already exists in the repo.
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true,

      // Payment callbacks must not be cut off mid-write on a reload.
      kill_timeout: 8000,

      watch: false,
    },
  ],
};
