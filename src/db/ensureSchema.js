import pool from './pool.js';

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255),
      firebase_uid VARCHAR(255) UNIQUE,
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      username VARCHAR(255),
      is_admin BOOLEAN DEFAULT false,
      is_paid BOOLEAN DEFAULT false,
      fcm_token TEXT,
      kingschat_id VARCHAR(255),
      kingschat_refresh_token VARCHAR(255),
      kingschat_access_token TEXT,
      avatar VARCHAR(500),
      profile_photo VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id VARCHAR(64) PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      type VARCHAR(100) DEFAULT 'event',
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ NOT NULL,
      created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      is_global BOOLEAN DEFAULT false,
      color VARCHAR(20),
      reminder INT DEFAULT 0,
      description TEXT,
      image_path VARCHAR(500),
      watch_url VARCHAR(500),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS birthday_wishes (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(64) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      user_name VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS words_for_month (
      id VARCHAR(64) PRIMARY KEY,
      word TEXT NOT NULL,
      month VARCHAR(32),
      year INT,
      created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_global ON events(is_global);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wishes_event ON birthday_wishes(event_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS advertisements (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      image_path VARCHAR(500),
      link_url VARCHAR(500),
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      amount_cents INT DEFAULT 0,
      status VARCHAR(32) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS payment_id VARCHAR(255);`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS payment JSONB;`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS duration_days INT DEFAULT 1;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ads_active ON advertisements(status, end_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ads_payment_id ON advertisements(payment_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS theme_of_year (
      id SERIAL PRIMARY KEY,
      year INT NOT NULL UNIQUE,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      image_path VARCHAR(500),
      created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_theme_year ON theme_of_year(year);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS on_this_day (
      id SERIAL PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      image_path VARCHAR(500),
      created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('[db] schema ready');
}
