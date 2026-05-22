# Move data from Firestore to PostgreSQL

Your app now uses **PostgreSQL** (`calendar360`). Use **Prisma** to browse and edit data, including `is_admin`.

## Prisma setup (one time)

```bash
cd api
npm install
npm run db:generate
npm run db:push
```

### Open the database in a GUI (Prisma Studio)

```bash
npm run db:studio
```

Opens http://localhost:5555 — click **User**, edit **`isAdmin`**:

| Value in Studio | Meaning |
|-----------------|--------|
| `true` | Admin |
| `false` | Member |

PostgreSQL stores this as a real **BOOLEAN** (`true` / `false`). You do **not** need `1`/`0` in the app; Prisma maps them automatically. Raw SQL also works:

```sql
UPDATE users SET is_admin = true WHERE email = 'you@example.com';
UPDATE users SET is_admin = false WHERE email = 'member@example.com';
```

### CLI: set admin without Studio

```bash
node scripts/set-admin.js your@email.com true
node scripts/set-admin.js your@email.com false
```

---

## Export from Firestore

### Option A — Script (recommended)

1. In [Firebase Console](https://console.firebase.google.com) → your project **calendar-360** → ⚙️ Project settings → **Service accounts** → **Generate new private key** → save as e.g. `calendar-360-service-account.json`.

   **Do not use** `android/app/google-services.json` — that file is for the Android app only and will not work.

2. In terminal:

```bash
cd api
export GOOGLE_APPLICATION_CREDENTIALS="/full/path/to/calendar-360-service-account.json"
npm run db:export-firestore
```

Or pass the path directly:

```bash
npm run db:export-firestore -- "/full/path/to/calendar-360-service-account.json"
```

This creates `api/firestore-export/`:

- `users.json`
- `app_events.json`
- `user_events.json`
- `words_for_month.json`
- `app_config.json`

### Option B — Firebase CLI

```bash
npm install -g firebase-tools
firebase login
firebase firestore:export ./firestore-backup --project YOUR_PROJECT_ID
```

That produces a **different format** (not directly compatible with our import script). Prefer **Option A** unless you write a custom converter.

### Option C — Manual export (small datasets)

Firebase Console → Firestore → each collection → export or copy documents into JSON files matching the layout in `firestore-export/` (see sample structure after running Option A once).

---

## Import into PostgreSQL

1. Postgres and API DB URL in `api/.env`:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/calendar360
```

2. Ensure schema exists:

```bash
npm run db:push
```

3. Import:

```bash
npm run db:import-firestore
```

4. Verify in Prisma Studio or SQL:

```bash
npm run db:studio
# or
psql "$DATABASE_URL" -c "SELECT id, email, is_admin FROM users;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM events;"
```

---

## What gets migrated

| Firestore | PostgreSQL table |
|-----------|------------------|
| `users` | `users` (`is_admin` boolean) |
| `app_events` (day docs with `events[]`) | `events` (`is_global = true`) |
| `users/{uid}/events` | `events` (private, linked by `created_by_user_id`) |
| `words_for_month` | `words_for_month` |
| `app_config/main` | `app_settings` |

**Not migrated automatically:** Firebase Auth accounts (users sign in with KingsChat + JWT now). Image URLs in old events stay as `watch_url`; re-upload banner images via the admin form if you used Storage URLs.

---

## Prisma in your own scripts

```js
import prisma from './src/db/prisma.js';

const admins = await prisma.user.findMany({ where: { isAdmin: true } });
await prisma.user.update({
  where: { email: 'admin@church.org' },
  data: { isAdmin: true },
});
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `P1001` Can't reach database | Start Docker: `docker compose up -d` |
| Import skips files | Run export first; check `api/firestore-export/*.json` |
| Duplicate events | Import is upsert by event `id`; clear `events` table and re-import if needed |
| `is_admin` always false | Set manually in Studio or `set-admin.js` after import |
