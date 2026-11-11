import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { openDb, migrate } from './db/db.ts';
import { selectAdapter } from './submission/adapter.ts';
import { createApp } from './router.ts';

mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'civicshot.db'));
migrate(db);
const selection = selectAdapter(config);
if (selection.refused) console.warn(`submission adapter "${selection.refused}" refused; using mock`);

const app = createApp({ config, db, ...selection });

serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST || 'localhost' }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
