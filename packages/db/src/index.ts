import { Pool } from 'pg';

export function createHealthCheck(connectionString: string) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
  return async () => {
    await pool.query('SELECT 1');
  };
}
