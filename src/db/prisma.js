import { PrismaClient } from '@prisma/client';

/** Singleton Prisma client — use in routes/scripts: `import prisma from '../db/prisma.js'` */
const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG === '1' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;
