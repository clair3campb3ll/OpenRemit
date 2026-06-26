import crypto from 'node:crypto';
import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { isPendingGrant, isFinalizedGrantWithAccessToken } from '@interledger/open-payments';
import { db } from '../db';
import { members, groups, transactions } from '../db/schema';
import { requireAuth } from '../middleware/requireAuth';
import { getClient, normaliseWalletAddress } from '../lib/openPayments';
import { createQuoteTransaction } from '../lib/quoteFlow';
import { config } from '../config';

export const membersRouter = Router();

// ─── GET /api/members ─────────────────────────────────────────────────────────
// List all members for the group.
membersRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const all = await db.select().from(members);
    res.json(all);
  } catch (err) { next(err); }
});

// ─── POST /api/members/enroll ─────────────────────────────────────────────────
// Enrol a member in recurring contributions.
// Body: { groupId, walletAddress, contributionAmountMajor }
//   contributionAmountMajor: amount in major currency units (e.g. "5.00" for £5)
//
// Flow:
//   1. Resolve member's wallet → get assetCode, assetScale
//   2. Convert major units → smallest unit
//   3. Create member row (PENDING_GRANT)
//   4. Request interactive outgoing-payment grant WITH interval (monthly)
//   5. Store grant continuation on member row
//   6. Return { memberId, interactUrl }
membersRouter.post('/enroll', requireAuth, async (req, res, next) => {
  try {
    const { groupId, walletAddress, contributionAmountMajor } = req.body as {
      groupId:                 string;
      walletAddress:           string;
      contributionAmountMajor: string;
    };

    if (!groupId || !walletAddress || !contributionAmountMajor) {
      return res.status(400).json({ error: 'groupId, walletAddress, and contributionAmountMajor are required.' });
    }

    const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
    if (!group) return res.status(404).json({ error: 'Group not found.' });

    const client        = await getClient();
    const normalised    = normaliseWalletAddress(walletAddress);
    const memberWallet  = await client.walletAddress.get({ url: normalised });

    // Convert major units → smallest unit using wallet's actual assetScale
    const smallestUnit = String(Math.round(parseFloat(contributionAmountMajor) * Math.pow(10, memberWallet.assetScale)));

    const now      = new Date();
    const memberId = crypto.randomUUID();

    await db.insert(members).values({
      id:                 memberId,
      userId:             req.user!.id,
      groupId,
      walletAddress:      normalised,
      contributionAmount: smallestUnit,
      assetCode:          memberWallet.assetCode,
      assetScale:         memberWallet.assetScale,
      status:             'PENDING_GRANT',
      createdAt:          now,
      updatedAt:          now,
    });

    // Monthly recurring grant starting now
    const interval    = `R/${now.toISOString()}/P1M`;
    const nonce       = crypto.randomBytes(16).toString('hex');
    const callbackUrl = `${config.backendUrl}/api/members/callback?memberId=${memberId}`;

    console.log('[members] Requesting enrollment grant for member=%s wallet=%s amount=%s %s interval=%s',
      memberId, normalised, smallestUnit, memberWallet.assetCode, interval);

    const pendingGrant = await client.grant.request(
      { url: memberWallet.authServer },
      {
        access_token: {
          access: [
            {
              type:       'outgoing-payment',
              actions:    ['create', 'read'],
              identifier: memberWallet.id,
              limits: {
                debitAmount: {
                  value:      smallestUnit,
                  assetCode:  memberWallet.assetCode,
                  assetScale: memberWallet.assetScale,
                },
                interval,
              },
            },
          ],
        },
        interact: {
          start:  ['redirect'],
          finish: { method: 'redirect', uri: callbackUrl, nonce },
        },
      }
    );

    if (!isPendingGrant(pendingGrant) || !pendingGrant.interact?.redirect) {
      await db.delete(members).where(eq(members.id, memberId));
      return res.status(500).json({ error: 'Expected interactive grant with redirect URL.' });
    }

    await db
      .update(members)
      .set({
        grantContinueUri:   pendingGrant.continue.uri,
        grantContinueToken: pendingGrant.continue.access_token.value,
        grantInteractNonce: nonce,
        updatedAt:          now,
      })
      .where(eq(members.id, memberId));

    console.log('[members] Enrollment grant pending for member=%s interactUrl=%s',
      memberId, pendingGrant.interact.redirect);

    res.json({ memberId, interactUrl: pendingGrant.interact.redirect });
  } catch (err) { next(err); }
});

// ─── GET /api/members/callback ────────────────────────────────────────────────
// GNAP redirect after member approves the enrollment grant at their wallet.
// Query params: memberId, interact_ref (from auth server), result (on rejection)
membersRouter.get('/callback', async (req, res) => {
  const { memberId, interact_ref, result } = req.query as Record<string, string>;

  if (!memberId) return res.status(400).send('Missing memberId');

  const [member] = await db.select().from(members).where(eq(members.id, memberId));
  if (!member || member.status !== 'PENDING_GRANT') {
    return res.redirect(`${config.frontendUrl}#/claims?enroll=failed&reason=invalid_state`);
  }

  if (!interact_ref || result === 'grant_rejected') {
    await db
      .update(members)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(eq(members.id, memberId));
    return res.redirect(`${config.frontendUrl}#/claims?enroll=declined`);
  }

  try {
    const client = await getClient();

    const finalizedGrant = await client.grant.continue(
      { url: member.grantContinueUri!, accessToken: member.grantContinueToken! },
      { interact_ref }
    );

    if (!isFinalizedGrantWithAccessToken(finalizedGrant)) {
      await db
        .update(members)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(members.id, memberId));
      return res.redirect(`${config.frontendUrl}#/claims?enroll=failed&reason=no_token`);
    }

    await db
      .update(members)
      .set({
        status:     'ACTIVE',
        grantToken: finalizedGrant.access_token.value,
        updatedAt:  new Date(),
      })
      .where(eq(members.id, memberId));

    console.log('[members] Member %s enrolled — grant token stored, status=ACTIVE', memberId);
    res.redirect(`${config.frontendUrl}#/claims?enroll=success`);
  } catch (err) {
    console.error('[members] Enrollment callback failed for member=%s err=%j', memberId, err);
    await db
      .update(members)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(eq(members.id, memberId));
    res.redirect(`${config.frontendUrl}#/claims?enroll=failed`);
  }
});

// ─── POST /api/members/:id/contribute ────────────────────────────────────────
// Admin — execute one contribution cycle for an ACTIVE member.
// Runs quoteFlow (member wallet → pool wallet) then creates the outgoing
// payment using the member's stored grant token. Updates pool balance.
membersRouter.post('/:id/contribute', requireAuth, async (req, res, next) => {
  if (req.user!.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only admins can trigger contributions.' });
  }

  try {
    const [member] = await db.select().from(members).where(eq(members.id, req.params.id));
    if (!member) return res.status(404).json({ error: 'Member not found.' });
    if (member.status !== 'ACTIVE' || !member.grantToken) {
      return res.status(400).json({ error: 'Member is not ACTIVE or has no stored grant token.' });
    }

    const [group] = await db.select().from(groups).where(eq(groups.id, member.groupId));
    if (!group) return res.status(500).json({ error: 'Group not found.' });

    const client = await getClient();

    // quoteFlow: member wallet (sender) → pool wallet (receiver)
    let quoteResult: Awaited<ReturnType<typeof createQuoteTransaction>>;
    try {
      quoteResult = await createQuoteTransaction({
        senderWalletAddress:   member.walletAddress,
        receiverWalletAddress: group.poolWalletAddress,
        amount:                member.contributionAmount,
        paymentType:           'FIXED_SEND',
        userId:                member.userId ?? req.user!.id,
        client,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ error: `Quote failed: ${msg}` });
    }

    const memberWallet = await client.walletAddress.get({ url: member.walletAddress });

    let outgoingPayment: Awaited<ReturnType<typeof client.outgoingPayment.create>>;
    try {
      outgoingPayment = await client.outgoingPayment.create(
        { url: memberWallet.resourceServer, accessToken: member.grantToken },
        {
          walletAddress: memberWallet.id,
          quoteId:       quoteResult.quoteUrl,
          metadata:      { description: 'Fireline monthly contribution' },
        }
      );
    } catch (err) {
      // Token exhausted or expired — clear it so next enroll gets a fresh grant
      await db
        .update(members)
        .set({ status: 'PAUSED', grantToken: null, updatedAt: new Date() })
        .where(eq(members.id, member.id));
      const msg = (err as any)?.description ?? (err instanceof Error ? err.message : String(err));
      return res.status(502).json({
        error: `Contribution failed — grant may be exhausted or expired. Member paused. (${msg})`,
      });
    }

    // Mark transaction COMPLETED
    await db
      .update(transactions)
      .set({ status: 'COMPLETED', outgoingPaymentUrl: outgoingPayment.id, updatedAt: new Date() })
      .where(eq(transactions.id, quoteResult.transactionId));

    // Increase pool balance by the amount received into the pool wallet
    const received   = BigInt(quoteResult.quote.receiveAmount.value);
    const newBalance = String(BigInt(group.poolBalance) + received);
    await db
      .update(groups)
      .set({ poolBalance: newBalance, updatedAt: new Date() })
      .where(eq(groups.id, group.id));

    console.log('[members] Contribution executed for member=%s amount=%s %s pool_balance=%s',
      member.id, member.contributionAmount, member.assetCode, newBalance);

    res.json({
      memberId:           member.id,
      transactionId:      quoteResult.transactionId,
      contributionAmount: member.contributionAmount,
      assetCode:          member.assetCode,
      quote:              quoteResult.quote,
      newPoolBalance:     newBalance,
    });
  } catch (err) { next(err); }
});
