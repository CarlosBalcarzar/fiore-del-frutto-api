import pg from 'pg';
import 'dotenv/config';
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL en .env');
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: true },
});
export async function transaction(work) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await work(client); await client.query('COMMIT'); return out; }
  catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}
