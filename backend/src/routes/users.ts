import { Router } from 'express';
import { db } from '../db';
import { users, transactions } from '../db/schema';
import { like, ne, and, eq, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/requireAuth';

export const usersRouter = Router();

// GET /api/users/search?q=<string>
usersRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    const q = ((req.query.q as string) ?? '').trim();
    if (!q) {
      res.json([]);
      return;
    }

    const results = await db
      .select({ id: users.id, displayName: users.displayName, walletAddress: users.walletAddress, avatar: users.avatar })
      .from(users)
      .where(and(like(users.displayName, `%${q}%`), ne(users.id, req.user!.id)))
      .limit(10)
      .all();

    res.json(results);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id — public profile + shared transactions with the current user
usersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const [profile] = await db
      .select({ id: users.id, displayName: users.displayName, walletAddress: users.walletAddress, avatar: users.avatar })
      .from(users)
      .where(eq(users.id, req.params.id));

    if (!profile) return res.status(404).json({ error: 'User not found' });

    const wallet = profile.walletAddress;
    const sharedTransactions = wallet
      ? await db
          .select({
            id:                    transactions.id,
            status:                transactions.status,
            paymentType:           transactions.paymentType,
            senderWalletAddress:   transactions.senderWalletAddress,
            receiverWalletAddress: transactions.receiverWalletAddress,
            debitAmount:           transactions.debitAmount,
            receiveAmount:         transactions.receiveAmount,
            assetCode:             transactions.assetCode,
            assetScale:            transactions.assetScale,
            outgoingPaymentUrl:    transactions.outgoingPaymentUrl,
            errorMessage:          transactions.errorMessage,
            createdAt:             transactions.createdAt,
          })
          .from(transactions)
          .where(and(eq(transactions.userId, req.user!.id), eq(transactions.receiverWalletAddress, wallet)))
          .orderBy(desc(transactions.createdAt))
          .limit(10)
          .all()
      : [];

    res.json({ user: profile, sharedTransactions });
  } catch (err) {
    next(err);
  }
});
