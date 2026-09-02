#!/usr/bin/env node
/**
 * Supabase (PostgreSQL) connection helper.
 *
 * The connection string is never stored in the repository: it is read from the
 * `SUPABASE_DB_URL` environment variable, which contains the pooled connection
 * string shown in the Supabase dashboard under *Project settings → Database*.
 */
import pg from 'pg';

/**
 * Build a client configured from the environment.
 *
 * TLS is verified against the system certificate authorities by default.
 * Set `SUPABASE_DB_SSL=no-verify` only when connecting through a proxy that
 * presents a self-signed certificate.
 *
 * @returns {import('pg').Client}
 */
export function createClient() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      'SUPABASE_DB_URL is not set; export the Supabase connection string first.',
    );
  }
  const ssl =
    process.env.SUPABASE_DB_SSL === 'no-verify'
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true };
  return new pg.Client({ connectionString, ssl });
}

/**
 * Run a callback with a connected client and always close the connection.
 *
 * @template T
 * @param {(client: import('pg').Client) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withClient(callback) {
  const client = createClient();
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}
