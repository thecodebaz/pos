module.exports = {
  apps: [
    {
      name: "pos",
      script: "scripts/serve.mjs",
      cwd: __dirname,
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 5000,
      watch: false,
      time: true,
    },
  ],
};
