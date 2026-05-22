/**
 * Set is_admin for a user (true/false).
 *
 * Usage:
 *   node scripts/set-admin.js user@example.com true
 *   node scripts/set-admin.js user@example.com false
 */
import 'dotenv/config';
import prisma from '../src/db/prisma.js';

const email = process.argv[2];
const flag = process.argv[3];

if (!email || !flag) {
  console.error('Usage: node scripts/set-admin.js <email> <true|false|1|0>');
  process.exit(1);
}

const isAdmin = flag === 'true' || flag === '1' || flag === 'yes';

async function main() {
  const user = await prisma.user.update({
    where: { email },
    data: { isAdmin },
    select: { id: true, email: true, isAdmin: true },
  });
  console.log('Updated:', user);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
