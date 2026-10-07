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
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS hide_time BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS person_name VARCHAR(255);`);
  await pool.query(`ALTER TABLE words_for_month ADD COLUMN IF NOT EXISTS link_url VARCHAR(1000);`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS payment_id VARCHAR(255);`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS payment JSONB;`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS duration_days INT DEFAULT 1;`);
  // Adverts are priced and scheduled per hour. `duration_days` came first and
  // is kept only so historical rows stay readable — nothing writes it now.
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS duration_hours INT;`);
  // Backfill is a true conversion, not a guess: the old code set
  // end_at = start_at + duration_days * 24h, so those adverts really did run
  // that many days. IS NULL keeps this a no-op on every later boot.
  await pool.query(`
    UPDATE advertisements
       SET duration_hours = COALESCE(duration_days, 1) * 24
     WHERE duration_hours IS NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ads_active ON advertisements(status, end_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ads_payment_id ON advertisements(payment_id);`);

  // Advert approval. A paid advert now waits for an admin before it goes live,
  // so the moment it was paid for and the moment it starts running are no
  // longer the same thing and are recorded separately.
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS approved_by_user_id INT REFERENCES users(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS rejection_reason TEXT;`);
  // The approval queue is read newest-first and filtered by status.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ads_status_created ON advertisements(status, created_at DESC);`);

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
  // Must come after the CREATE above: this ALTER used to sit further up the
  // file, where it threw on any database that did not already have the table
  // and so skipped every statement after it.
  await pool.query(`ALTER TABLE theme_of_year ADD COLUMN IF NOT EXISTS link_url VARCHAR(1000);`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id SERIAL PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ,
      color VARCHAR(20),
      reminder INT DEFAULT 15,
      organizer_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meeting_invitees (
      id SERIAL PRIMARY KEY,
      meeting_id INT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      responded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(meeting_id, user_id)
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meetings_organizer ON meetings(organizer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meeting_invitees_user ON meeting_invitees(user_id, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meeting_invitees_meeting ON meeting_invitees(meeting_id);`);

  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location VARCHAR(500);`);
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_link TEXT;`);
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT ARRAY[]::TEXT[];`);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS meetings_sub JSONB;`);
  // Free meetings already scheduled, counted against FREE_MEETING_USES. This
  // replaced a 30-day trial; defaulting to 0 deliberately grants every
  // existing account the full free allowance from the day it ships, since the
  // old time-based trial had already lapsed for them.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS meetings_free_used INT NOT NULL DEFAULT 0;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(500) NOT NULL,
      notes TEXT,
      due_date DATE NOT NULL,
      reminder_at TIMESTAMPTZ,
      is_done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_todos_user_due_date ON todos(user_id, due_date);`);

  await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS group_id INT REFERENCES todos(id) ON DELETE SET NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_todos_group ON todos(group_id);`);
  await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS color VARCHAR(20);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS todo_subtasks (
      id SERIAL PRIMARY KEY,
      todo_id INT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      title VARCHAR(500) NOT NULL,
      is_done BOOLEAN NOT NULL DEFAULT false,
      position INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_subtasks_todo ON todo_subtasks(todo_id);`);

  // Birthday sync (KingsChat profile or manual entry).
  // kingschat_profile keeps the raw profile payload so we can see exactly which
  // fields KingsChat returns for this client id — birthdate is not documented.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday DATE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_source VARCHAR(20);`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_synced_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kingschat_birthday DATE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kingschat_profile JSONB;`);

  // ── Blog: admin-written posts about the global meetings, with likes and
  // comments from every user ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_posts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      excerpt TEXT,
      body TEXT,
      image_path VARCHAR(500),
      link_url VARCHAR(1000),
      meeting_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'published',
      created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // The primary key is what makes a like idempotent: tapping twice, or two
  // requests racing, cannot inflate the count.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_post_likes (
      post_id INT NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, user_id)
    );
  `);

  // user_name is stored alongside user_id so a deleted account still leaves a
  // readable thread, the way birthday_wishes does it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_post_comments (
      id SERIAL PRIMARY KEY,
      post_id INT NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      user_name VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_blog_posts_feed ON blog_posts(status, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_blog_likes_post ON blog_post_likes(post_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_blog_comments_post ON blog_post_comments(post_id, created_at DESC);`);

  // ── Admin broadcasts ──────────────────────────────────────────────────
  // Every push an admin sends is recorded, so the history survives the
  // notification tray and can be tracked afterwards.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      body TEXT NOT NULL,
      image_path VARCHAR(500),
      link_url VARCHAR(1000),
      sent_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      sent_by_name VARCHAR(255),
      fcm_message_id VARCHAR(255),
      delivered BOOLEAN NOT NULL DEFAULT true,
      delivery_error TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // One row per tap. Kept as rows rather than a counter on `broadcasts` so
  // total taps and distinct people can both be reported, and so a counter
  // cannot drift away from what actually happened. user_id is null for a tap
  // from a signed-out device, which still counts toward the total.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcast_clicks (
      id SERIAL PRIMARY KEY,
      broadcast_id INT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      clicked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_broadcasts_feed ON broadcasts(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_broadcast_clicks_bid ON broadcast_clicks(broadcast_id);`);

  // ── Today in History view counts ──────────────────────────────────────
  // One row per view, same reasoning as broadcast_clicks: the admin-facing
  // count is derived, never incremented in place.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS on_this_day_views (
      id SERIAL PRIMARY KEY,
      post_id INT NOT NULL REFERENCES on_this_day(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      viewed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_otd_views_post ON on_this_day_views(post_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_otd_views_user ON on_this_day_views(user_id);`);

  // ── Tracked viewers ───────────────────────────────────────────────────
  // A short list of accounts whose views are counted separately, so an admin
  // can tell whether one particular person has opened a post. Keyed by email
  // rather than user id: an email can be added before that person has ever
  // signed in, and it survives the account being deleted and recreated.
  // Always stored lower-cased, because users.email is not normalised.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_viewers (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      label VARCHAR(120),
      added_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('[db] schema ready');
}
