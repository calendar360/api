/**
 * Enable paid advertising for a user.
 * Usage: node scripts/set-paid.js user@email.com true
 */
import 'dotenv/config';
import prisma from '../src/db/prisma.js';

const email = process.argv[2];
const flag = process.argv[3] !== 'false';

if (!email) {
  console.error('Usage: node scripts/set-paid.js <email> [true|false]');
  process.exit(1);
}

const user = await prisma.user.update({
  where: { email },
  data: { isPaid: flag },
  select: { id: true, email: true, isPaid: true },
});

console.log('Updated:', user);
await prisma.$disconnect();
