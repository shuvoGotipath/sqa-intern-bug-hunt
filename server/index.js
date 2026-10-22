import { createApp } from './app.js';
import { S3Storage } from './storage.js';
import { configFromEnv, loadDotEnv } from './config.js';

loadDotEnv();

let created;
let config;
try {
  config = configFromEnv(process.env);
  created = await createApp(config);
} catch (err) {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
const server = created.app.listen(port, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other process or set PORT in .env.` : err);
    process.exit(1);
  }
  console.log(`SQA Intern Bug Hunt running at http://localhost:${port}`);
  console.log(`Admin dashboard:        http://localhost:${port}/admin`);
  console.log(`Data: MongoDB "${config.dbName}" · Files: ${config.storage instanceof S3Storage ? `S3 bucket "${config.storage.bucket}"` : 'local uploads/ folder'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => created.client.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
