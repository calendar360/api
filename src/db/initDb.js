import pool from './pool.js';
import { ensureSchema } from './ensureSchema.js';

const initDb = async () => {
  await ensureSchema();
  console.log('Database initialized');
  await pool.end();
};

initDb().catch((err) => {
  console.error('Database init failed:', err);
  process.exit(1);
});
