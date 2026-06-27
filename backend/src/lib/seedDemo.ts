/**
 * Demo seed — wipes all data and creates two known accounts for a clean demo.
 *
 * Usage: cd backend && npm run demo:seed
 *
 * Accounts created:
 *   admin@demo.com / demo  →  ADMIN
 *   alice@demo.com / demo  →  MEMBER, enrolled in the Mutual Fund
 *
 * Demo flow:
 *   Window 1 (normal browser):   admin@demo.com  →  All Claims
 *   Window 2 (incognito):        alice@demo.com  →  Relief Fund → Report a Fire
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import {
  users, groups, memberships, members,
  claims, fireEvents, postUnlocks,
  paymentRequests, transactions, posts,
} from '../db/schema';
import { config } from '../config';

async function seedDemo(): Promise<void> {
  console.log('[demo] Wiping all existing data...');

  await db.delete(memberships);
  await db.delete(members);
  await db.delete(claims);
  await db.delete(fireEvents);
  await db.delete(postUnlocks);
  await db.delete(paymentRequests);
  await db.delete(transactions);
  await db.delete(posts);
  await db.delete(groups);
  await db.delete(users);

  const now          = new Date();
  const passwordHash = await bcrypt.hash('demo', 10);
  const adminId      = crypto.randomUUID();
  const aliceId      = crypto.randomUUID();

  await db.insert(users).values([
    {
      id:           adminId,
      displayName:  'Admin',
      email:        'admin@demo.com',
      passwordHash,
      role:         'ADMIN',
      walletAddress: config.op.walletAddress,
      createdAt:    now,
    },
    {
      id:           aliceId,
      displayName:  'Alice Dlamini',
      email:        'alice@demo.com',
      passwordHash,
      role:         'MEMBER',
      walletAddress: config.op.walletAddress,
      createdAt:    new Date(now.getTime() + 1000),
    },
  ]);

  const groupId = crypto.randomUUID();
  const backstopWallet = config.backstop.walletAddress ?? config.op.walletAddress;

  await db.insert(groups).values({
    id:                    groupId,
    name:                  'Mutual Fund',
    poolWalletAddress:     config.op.walletAddress,
    backstopWalletAddress: backstopWallet,
    fixedPayoutAmount:     '80000',   // R800
    reserveFloor:          '20000',   // R200
    covariateThreshold:    3,
    designCapacity:        '800000',  // R8000
    poolBalance:           '200000',  // R2000 starting balance
    assetCode:             'ZAR',
    assetScale:            2,
    createdAt:             now,
    updatedAt:             now,
  });

  const nextCharge = new Date(now);
  nextCharge.setMonth(nextCharge.getMonth() + 1);

  await db.insert(memberships).values({
    id:                  crypto.randomUUID(),
    groupId,
    userId:              aliceId,
    memberWalletAddress: config.op.walletAddress,
    monthlyAmount:       '3000', // R30
    interval:            `R/${now.toISOString().slice(0, 10)}T00:00:00Z/P1M`,
    status:              'ACTIVE',
    nextChargeAt:        nextCharge,
    chargesMade:         0,
    createdAt:           now,
    updatedAt:           now,
  });

  console.log('[demo] Done. Accounts:');
  console.log('  admin@demo.com  /  demo  (ADMIN)');
  console.log('  alice@demo.com  /  demo  (MEMBER, enrolled in Mutual Fund)');
  console.log('[demo] Open two browser windows:');
  console.log('  Window 1 (normal):    admin@demo.com  →  All Claims');
  console.log('  Window 2 (incognito): alice@demo.com  →  Relief Fund');
}

seedDemo()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
