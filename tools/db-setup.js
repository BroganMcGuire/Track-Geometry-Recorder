#!/usr/bin/env node
/**
 * Create the Supabase tables used to store the runs.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgres://…' npm run db:setup
 *
 * The script is idempotent: every statement of `db/schema.sql` uses
 * `create … if not exists`, so it can be re-run after a schema change.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { withClient } from './db.js';

const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));

const schema = await readFile(schemaPath, 'utf8');
await withClient(async (client) => {
  await client.query(schema);
});
process.stdout.write('Supabase schema applied.\n');
