# Calendar 360 API

Express backend for KingsChat OAuth login.

## Setup

```bash
cd api
cp .env.example .env
# Edit .env — DATABASE_URL, JWT_SECRET
npm install
npm run db:init
npm run dev
```

`npm run dev` uses **nodemon** (auto-restart on file changes).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/oauth/callback` | OAuth redirect page (used by Flutter WebView) |
| POST | `/api/user/kingschat` | Exchange KC tokens for app JWT |
| GET | `/api/user/me` | Current user (`token` header) |

## KingsChat developer settings

Add your OAuth redirect URI(s) in the [KingsChat Developer Site](https://developer.kingsch.at/) — **required** or login will time out:

- Android emulator: `http://10.0.2.2:4000/oauth/callback`
- iOS simulator: `http://localhost:4000/oauth/callback`
- Physical device: `http://YOUR_COMPUTER_LAN_IP:4000/oauth/callback`

The app opens `GET /oauth/start` which redirects to KingsChat with the matching `redirect_uri`.

## Flutter

`lib/app/services/api_config.dart` picks the API host automatically.

For a **physical device**, set `ApiConfig.overrideBaseUrl` to your machine IP, e.g. `http://192.168.1.10:4000`.
# api
