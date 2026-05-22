# FCM push setup (one-time)

When an **admin** creates a **global event**, all app users get a push via topic `global_events`.

## 1. Firebase Console

1. Open [Firebase Console](https://console.firebase.google.com) → project **calendar-360**
2. **Project settings** → **Cloud Messaging** — note that Cloud Messaging API is enabled
3. **Project settings** → **Service accounts** → **Generate new private key**
4. Save the JSON as:
   - `api/calendar-360-firebase-adminsdk-fbsvc-85d7dbb4d0.json`  
   (or copy the file already in `android/`)

## 2. API `.env`

```env
FIREBASE_SERVICE_ACCOUNT=/absolute/path/to/calendar-360-firebase-adminsdk-fbsvc-85d7dbb4d0.json
```

## 3. Start API

```bash
cd api
npm install
npm run dev
```

You should see: `[fcm] Firebase Admin ready`

## 4. Flutter app

```bash
flutter pub get
flutter run
```

On login, the app subscribes to topic `global_events` and registers the device token with the API.

## 5. Test

1. Log in as **admin** on device A
2. Log in as any user on device B (or emulator)
3. Admin creates a **global event**
4. Device B should receive a notification even if the app was in the background

## Android emulator notes

- Use a **Google Play** system image (FCM requires Google Play Services). AOSP images without Play will log `SERVICE_NOT_AVAILABLE` / `Firebase Installations Service is unavailable` — the app still runs; push only works on Play images or real devices.
- Emulator must have network (Wi‑Fi icon in status bar). Cold boot the AVD if FIS keeps failing.
- Allow notifications when prompted.
- Logcat errors like `Failed to get FIS auth token` on a non-Play emulator are expected and safe to ignore during UI development.
