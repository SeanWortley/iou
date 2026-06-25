import { Router } from 'express';
import { db } from '../db';
import { users, transactions } from '../db/schema';
import { eq } from 'drizzle-orm';
import { getClient } from '../lib/openPayments';
import { randomUUID } from 'crypto';

const router = Router();

// Endpoint for bot to check if user exists by phone or Telegram ID
router.post('/check-user', async (req, res) => {
    const { telegramId, phoneNumber } = req.body;
    try {
        let user = null;
        if (telegramId) {
            user = await db.select().from(users).where(eq(users.telegramId, telegramId)).get();
        } else if (phoneNumber) {
            user = await db.select().from(users).where(eq(users.phoneNumber, phoneNumber)).get();
        }
        return res.json({ registered: !!user, user });
    } catch (error) {
        return res.status(500).json({ error: 'Database check failed' });
    }
});

export default router;