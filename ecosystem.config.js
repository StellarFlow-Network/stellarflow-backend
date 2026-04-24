export default {
  apps: [
    {
      name: "stellarflow-backend",
      script: "dist/index.js",
      instances: "max",
      exec_mode: "cluster",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm Z",
      error_file: "./server.err.log",
      out_file: "./server.out.log",
      ignore_watch: ["node_modules", "dist", "logs", ".git"],
      env: {
        NODE_ENV: "development",
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3000,
      },
    },
  ],
};
