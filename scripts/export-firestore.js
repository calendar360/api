/**
 * Export Firestore collections to api/firestore-export/*.json
 *
 * You need a **service account** JSON (NOT google-services.json):
 *   Firebase Console → Project settings → Service accounts → Generate new private key
 *
 * Usage (pick one):
 *   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
 *   npm run db:export-firestore
 *
 *   npm run db:export-firestore -- /path/to/serviceAccountKey.json
 *
 * Or in api/.env:
 *   FIREBASE_SERVICE_ACCOUNT=/path/to/serviceAccountKey.json
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../firestore-export');

function resolveCredentialsPath() {
  const fromArg = process.argv[2];
  if (fromArg) return path.resolve(fromArg);
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  return null;
}

function validateServiceAccountFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(
      'Service account JSON not found.\n' +
        'Download it from Firebase Console → Project settings → Service accounts → Generate new private key.\n' +
        'Then run:\n' +
        '  export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"\n' +
        '  npm run db:export-firestore',
    );
  }

  let json;
  try {
    json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`Invalid JSON file: ${filePath}`);
  }

  if (json.project_info?.project_id && json.client) {
    throw new Error(
      `Wrong file: "${filePath}" is google-services.json (Android config).\n` +
        'You need the **service account** key JSON from Firebase Console → Service accounts → Generate new private key.\n' +
        'It must contain "type": "service_account" and "private_key".',
    );
  }

  if (json.type !== 'service_account' || !json.private_key || !json.client_email) {
    throw new Error(
      `Invalid service account file: ${filePath}\n` +
        'Expected Firebase Admin SDK JSON with type, private_key, and client_email.',
    );
  }

  return json;
}

async function main() {
  const credPath = resolveCredentialsPath();
  const serviceAccount = validateServiceAccountFile(credPath);

  const firebaseAdmin = (await import('firebase-admin')).default;

  if (!firebaseAdmin.apps.length) {
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  }

  const db = firebaseAdmin.firestore();
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`Project: ${serviceAccount.project_id}`);
  console.log(`Export dir: ${OUT}\n`);

  async function dumpCollection(name, query = db.collection(name)) {
    const snap = await query.get();
    const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const file = path.join(OUT, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(docs, null, 2));
    console.log(`Wrote ${docs.length} docs → ${file}`);
    return docs;
  }

  await dumpCollection('users');
  await dumpCollection('app_events');
  await dumpCollection('words_for_month');

  const configSnap = await db.collection('app_config').get();
  fs.writeFileSync(
    path.join(OUT, 'app_config.json'),
    JSON.stringify(configSnap.docs.map((d) => ({ id: d.id, data: d.data() })), null, 2),
  );
  console.log(`Wrote ${configSnap.size} docs → app_config.json`);

  const userEvents = [];
  const usersSnap = await db.collection('users').get();
  for (const userDoc of usersSnap.docs) {
    const evSnap = await userDoc.ref.collection('events').get();
    for (const evDoc of evSnap.docs) {
      userEvents.push({
        id: `${userDoc.id}_${evDoc.id}`,
        data: { ...evDoc.data(), _userId: userDoc.id },
      });
    }
  }
  fs.writeFileSync(path.join(OUT, 'user_events.json'), JSON.stringify(userEvents, null, 2));
  console.log(`Wrote ${userEvents.length} user event day-docs → user_events.json`);

  console.log('\nNext: npm run db:import-firestore');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
