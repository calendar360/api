/**
 * Import Firestore JSON export into PostgreSQL (via Prisma).
 *
 * 1. Export Firestore (see FIRESTORE_MIGRATION.md)
 * 2. Place files in api/firestore-export/:
 *    - users.json
 *    - app_events.json
 *    - user_events.json   (optional, from users subcollection events)
 *    - words_for_month.json
 *    - app_config.json    (optional)
 * 3. Run: npm run db:import-firestore
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../src/db/prisma.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(__dirname, '../firestore-export');

function readJson(name) {
  const p = path.join(EXPORT_DIR, name);
  if (!fs.existsSync(p)) {
    console.warn(`[skip] ${name} not found`);
    return null;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function parseFirestoreDate(v) {
  if (!v) return null;
  if (typeof v === 'string') return new Date(v);
  if (v._seconds != null) return new Date(v._seconds * 1000);
  if (v.seconds != null) return new Date(v.seconds * 1000);
  return new Date(v);
}

function toBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  return false;
}

async function importUsers(docs) {
  if (!docs?.length) return {};
  const uidToPgId = {};
  for (const doc of docs) {
    const d = doc.data || doc;
    const firebaseUid = doc.id || d.uid || d.firebaseUid;
    const email = d.email;
    if (!email) {
      console.warn('[users] skip doc without email', doc.id);
      continue;
    }
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        name: d.name || d.displayName || [d.firstName, d.lastName].filter(Boolean).join(' ') || email,
        email,
        firebaseUid: firebaseUid || null,
        firstName: d.firstName || d.first_name || null,
        lastName: d.lastName || d.last_name || null,
        username: d.username || null,
        isAdmin: toBool(d.isAdmin ?? d.is_admin),
        kingschatId: d.kingschatId || d.kingschat_id || null,
        avatar: d.avatar || d.profilePhoto || d.profile_photo || null,
        profilePhoto: d.profilePhoto || d.profile_photo || null,
        password: '',
      },
      update: {
        name: d.name || d.displayName || undefined,
        firebaseUid: firebaseUid || undefined,
        firstName: d.firstName || d.first_name || undefined,
        lastName: d.lastName || d.last_name || undefined,
        username: d.username || undefined,
        isAdmin: toBool(d.isAdmin ?? d.is_admin),
        kingschatId: d.kingschatId || d.kingschat_id || undefined,
        avatar: d.avatar || d.profilePhoto || undefined,
        profilePhoto: d.profilePhoto || d.profile_photo || undefined,
      },
    });
    if (firebaseUid) uidToPgId[firebaseUid] = user.id;
    uidToPgId[doc.id] = user.id;
  }
  console.log(`[users] imported ${Object.keys(uidToPgId).length} mappings`);
  return uidToPgId;
}

async function importEventDocs(docs, { isGlobal, uidToPgId }) {
  if (!docs?.length) return 0;
  let count = 0;
  for (const doc of docs) {
    const d = doc.data || doc;
    const events = d.events || [];
    for (const e of events) {
      const id = e.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const start = parseFirestoreDate(e.startTime);
      const end = parseFirestoreDate(e.endTime);
      if (!start || !end) continue;

      const createdByUid = e.createdBy || d.createdBy || d._userId;
      const createdByUserId = createdByUid ? uidToPgId[createdByUid] : null;

      await prisma.event.upsert({
        where: { id },
        create: {
          id,
          title: e.title || 'Untitled',
          type: e.type || 'event',
          startTime: start,
          endTime: end,
          createdByUserId: createdByUserId ?? null,
          isGlobal: isGlobal || e.isGlobal === true,
          color: e.color || null,
          reminder: e.reminder ?? 0,
          description: e.description || null,
          imagePath: e.imagePath || (e.imageUrl ? null : null),
          watchUrl: e.watchUrl || null,
        },
        update: {
          title: e.title || 'Untitled',
          type: e.type || 'event',
          startTime: start,
          endTime: end,
          isGlobal: isGlobal || e.isGlobal === true,
          color: e.color || null,
          reminder: e.reminder ?? 0,
          description: e.description || null,
          watchUrl: e.watchUrl || null,
        },
      });
      count++;
    }
  }
  return count;
}

async function importWords(docs) {
  if (!docs?.length) return 0;
  let n = 0;
  for (const doc of docs) {
    const d = doc.data || doc;
    const word = d.word;
    if (!word) continue;
    await prisma.wordForMonth.upsert({
      where: { id: doc.id },
      create: {
        id: doc.id,
        word,
        month: d.month || null,
        year: d.year ?? null,
      },
      update: { word, month: d.month || null, year: d.year ?? null },
    });
    n++;
  }
  return n;
}

async function importAppConfig(doc) {
  if (!doc) return;
  const d = doc.data || doc;
  for (const [key, value] of Object.entries(d)) {
    if (typeof value === 'string') {
      await prisma.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
  }
}

async function main() {
  console.log('Reading from', EXPORT_DIR);
  const uidToPgId = await importUsers(readJson('users.json'));
  const globalN = await importEventDocs(readJson('app_events.json'), {
    isGlobal: true,
    uidToPgId,
  });
  const userN = await importEventDocs(readJson('user_events.json'), {
    isGlobal: false,
    uidToPgId,
  });
  const wordsN = await importWords(readJson('words_for_month.json'));
  const config = readJson('app_config.json');
  if (config) await importAppConfig(Array.isArray(config) ? config[0] : config);

  console.log('Done:', { globalEvents: globalN, userEvents: userN, words: wordsN });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
