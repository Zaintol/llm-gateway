import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);
const app = buildApp({ logLevel: process.env.LOG_LEVEL ?? 'info' });

process.once('SIGTERM', () => void app.close().then(() => process.exit(0)));
process.once('SIGINT', () => void app.close().then(() => process.exit(0)));

await app.listen({ host: '0.0.0.0', port });
