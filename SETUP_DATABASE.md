# PostgreSQL setup for Calendar 360

Login data is saved when the **API is running** and **PostgreSQL is reachable**.

## Prisma (browse & edit data)

```bash
cd api
npm install
npm run db:generate
npm run db:push
npm run db:studio    # GUI at http://localhost:5555
```

- **`is_admin`** is a PostgreSQL **boolean** — in Prisma Studio use `true` / `false` (not 1/0).
- CLI: `node scripts/set-admin.js email@example.com true`

See **[FIRESTORE_MIGRATION.md](./FIRESTORE_MIGRATION.md)** to export Firestore and import into Postgres.

## Quick start (Docker — recommended)

```bash
cd api
docker compose up -d
```

Wait a few seconds, then start the API (creates tables automatically):

```bash
npm start
```

You should see: `[db] schema ready`

## Configure `.env`

`api/.env` should contain:

```env
PORT=4000
HOST=0.0.0.0
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/calendar360
JWT_SECRET=your_secret_here
```

## Verify users are saving

1. Start API: `cd api && npm start`
2. Run the app and **log in with KingsChat**
3. In a terminal:

```bash
docker exec -it calendar360-db psql -U postgres -d calendar360 -c "SELECT id, email, firebase_uid, kingschat_id, first_name FROM users;"
```

Or with local `psql`:

```bash
psql postgresql://postgres:postgres@localhost:5432/calendar360 -c "SELECT * FROM users;"
```

## Troubleshooting

| Problem | Fix |
|--------|-----|
| Empty `users` table | API not running, or Postgres not started |
| `User sync error` in Flutter logs | Wrong `apiBaseUrl` — emulator uses `http://10.0.2.2:4000` |
| `connection refused` on port 5432 | Run `docker compose up -d` in `api/` |
| `database "calendar360" does not exist` | Docker compose creates it; or `createdb calendar360` |

## Health check

```bash
curl http://localhost:4000/health
```

Look for `"database": "connected"`.
