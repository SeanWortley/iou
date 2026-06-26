import { Router } from 'express';
import { db } from '../db';
import { users, groupMembers, transactions } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getClient } from '../lib/openPayments';
import { isPendingGrant } from '@interledger/open-payments';
import axios from 'axios';
import crypto from 'crypto';

const router = Router();

// IN-MEMORY SESSION STORE: Remembers payment details between parsing and authorizing [1]
interface PaymentSession {
    amount: number;
    currency: string;
    recipientWallet: string;
}
const activeSessions = new Map<string, PaymentSession>();

// 1. POST /bot/checkUser
router.post('/checkUser', async (req, res) => {
    const { telegramUserId } = req.body;
    try {
        const user = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
        return res.json({ registered: !!user });
    } catch (error) {
        console.error('checkUser failed:', error);
        return res.status(500).json({ error: 'Database query failed' });
    }
});

// 2. POST /bot/processRegistration
router.post('/processRegistration', async (req, res) => {
    const { telegramUserId, telegramUsername, phoneNumber, walletAddress, privateKey, password } = req.body;

    try {
        const salt = crypto.randomBytes(16).toString('base64');
        const iv = crypto.randomBytes(12).toString('base64');

        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

        const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        let encrypted = cipher.update(privateKey, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        const authTag = cipher.getAuthTag().toString('base64');

        const displayName = telegramUsername ? `@${telegramUsername}` : 'User';

        await db.insert(users).values({
            id: crypto.randomUUID(),
            telegramId: telegramUserId.toString(),
            telegramUsername: telegramUsername ? `@${telegramUsername}` : null,
            displayName,
            phoneNumber,
            passwordHash: crypto.createHash('sha256').update(password).digest('hex'),
            walletAddress,
            privateKeyEncrypted: encrypted,
            privateKeyIv: iv,
            privateKeySalt: salt,
            createdAt: new Date(),
        });

        return res.json({ ok: true });
    } catch (error) {
        console.error('Registration failed:', error);
        return res.status(500).json({ error: 'Failed to complete registration' });
    }
});

// 3. POST /bot/processPlainText
router.post('/processPlainText', async (req, res) => {
    const { telegramUserId, text, context } = req.body;

    try {
        const aiServerUrl = process.env.AI_SERVER_URL || 'http://localhost:8000/parse';
        const aiResponse = await axios.post(aiServerUrl, { text });
        const intentData = aiResponse.data;

        const sessionId = crypto.randomUUID();

        if (intentData.intent !== 'PAYMENT') {
            return res.json({ status: 'error', reason: 'Only payment instructions are supported right now.' });
        }

        const recipientQuery = intentData.recipient?.trim();
        if (!recipientQuery) {
            return res.json({ status: 'error', reason: 'Could not detect who you want to pay.' });
        }

        let matchedUser = null;
        const isGroup = context?.chatType === 'group' || context?.chatType === 'supergroup';
        const groupTelegramId = context?.chatId?.toString();

        if (isGroup && groupTelegramId) {
            matchedUser = await db.select({
                id: users.id,
                displayName: users.displayName,
                walletAddress: users.walletAddress
            })
                .from(users)
                .innerJoin(groupMembers, eq(users.id, groupMembers.userId))
                .where(and(
                    eq(groupMembers.groupTelegramId, groupTelegramId),
                    eq(users.displayName, recipientQuery)
                )).get();
        }

        if (!matchedUser) {
            matchedUser = await db.select().from(users).where(eq(users.telegramUsername, recipientQuery)).get();
            if (!matchedUser) {
                matchedUser = await db.select().from(users).where(eq(users.phoneNumber, recipientQuery)).get();
            }
        }

        if (!matchedUser || !matchedUser.walletAddress) {
            return res.json({
                status: 'error',
                reason: `Could not find a registered user named "${recipientQuery}" in our system.`
            });
        }

        // SAVE PAYMENT TO SESSION MAP [1]
        activeSessions.set(sessionId, {
            amount: intentData.amount,
            currency: intentData.currency || 'USD',
            recipientWallet: matchedUser.walletAddress
        });

        return res.json({
            status: 'ok',
            sessionId,
            payment: {
                amountDisplay: intentData.amount.toString(),
                currency: intentData.currency || 'USD',
                recipientDisplay: matchedUser.displayName,
                recipientWallet: matchedUser.walletAddress,
                note: intentData.note || undefined
            }
        });

    } catch (error) {
        console.error('processPlainText failed:', error);
        return res.json({ status: 'error', reason: 'Internal parsing server error.' });
    }
});

// 4. POST /bot/joinGroup
router.post('/joinGroup', async (req, res) => {
    const { telegramUserId, telegramUsername, groupTelegramId } = req.body;

    try {
        const user = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
        if (!user) {
            return res.status(404).json({ error: 'User not registered.' });
        }

        const existing = await db.select().from(groupMembers)
            .where(and(
                eq(groupMembers.groupTelegramId, groupTelegramId.toString()),
                eq(groupMembers.userId, user.id)
            )).get();

        if (!existing) {
            await db.insert(groupMembers).values({
                id: crypto.randomUUID(),
                groupTelegramId: groupTelegramId.toString(),
                userId: user.id,
                lastSeenAt: new Date()
            });
        }

        return res.json({ ok: true });
    } catch (error) {
        console.error('joinGroup failed:', error);
        return res.status(500).json({ error: 'Failed to join group roster' });
    }
});

// 5. POST /bot/authorizePayment (REAL LEDGER TRANSACTION FLOW) [1]
router.post('/authorizePayment', async (req, res) => {
    const { telegramUserId, sessionId, password } = req.body;

    try {
        const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
        if (!sender || !sender.walletAddress) {
            return res.status(404).json({ error: 'Sender not registered.' });
        }

        // Verify Password
        const derivedHash = crypto.createHash('sha256').update(password).digest('hex');
        if (derivedHash !== sender.passwordHash) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        // Retrieve active session details [1]
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.status(400).json({ error: 'Session expired or invalid.' });
        }

        const client = await getClient();

        // Resolve wallets
        const senderWallet = await client.walletAddress.get({ url: sender.walletAddress });
        const receiverWallet = await client.walletAddress.get({ url: session.recipientWallet });

        // Request incoming-payment grant
        const incomingGrant = await client.grant.request(
            { url: receiverWallet.authServer },
            { access_token: { access: [{ type: 'incoming-payment', actions: ['create', 'read'] }] } }
        );

        if (isPendingGrant(incomingGrant) || !incomingGrant.access_token) {
            throw new Error('Expected non-interactive incoming payment grant');
        }

        // Calculate scale dynamically
        const scaleMultiplier = Math.pow(10, receiverWallet.assetScale);
        const amountInScale = Math.round(session.amount * scaleMultiplier).toString();

        // Create incoming payment
        const incomingPayment = await client.incomingPayment.create(
            { url: receiverWallet.resourceServer, accessToken: incomingGrant.access_token.value },
            {
                walletAddress: receiverWallet.id,
                incomingAmount: { value: amountInScale, assetCode: receiverWallet.assetCode, assetScale: receiverWallet.assetScale }
            }
        );

        // Request quote grant
        const quoteGrant = await client.grant.request(
            { url: senderWallet.authServer },
            { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } }
        );

        if (isPendingGrant(quoteGrant) || !quoteGrant.access_token) {
            throw new Error('Expected non-interactive quote grant');
        }

        // Create quote
        const quote = await client.quote.create(
            { url: senderWallet.resourceServer, accessToken: quoteGrant.access_token.value },
            {
                walletAddress: senderWallet.id,
                receiveAmount: incomingPayment.incomingAmount,
                receiver: incomingPayment.id,
                method: 'ilp'
            }
        );

        // Request interactive outgoing payment grant
        const interactNonce = crypto.randomUUID();
        const txId = crypto.randomUUID();
        const callbackUrl = `${process.env.BACKEND_URL}/api/callback?transactionId=${txId}`;

        const outgoingGrant = await client.grant.request(
            { url: senderWallet.authServer },
            {
                access_token: {
                    access: [{
                        type: 'outgoing-payment',
                        actions: ['create', 'read'],
                        identifier: senderWallet.id,
                        limits: { debitAmount: quote.debitAmount }
                    }]
                },
                interact: {
                    start: ['redirect'],
                    finish: { method: 'redirect', uri: callbackUrl, nonce: interactNonce }
                }
            }
        );

        if ('interact' in outgoingGrant) {
            const now = new Date();

            await db.insert(transactions).values({
                id: txId,
                status: 'AWAITING_GRANT',
                paymentType: 'FIXED_SEND',
                senderWalletAddress: senderWallet.id,
                receiverWalletAddress: receiverWallet.id,
                debitAmount: amountInScale,
                assetCode: receiverWallet.assetCode,
                assetScale: receiverWallet.assetScale,
                incomingPaymentUrl: incomingPayment.id,
                quoteUrl: quote.id,

                grantContinueUri: outgoingGrant.continue.uri,
                grantContinueToken: outgoingGrant.continue.access_token.value,
                grantInteractNonce: interactNonce,

                userId: sender.id,
                createdAt: now,
                updatedAt: now
            });

            return res.json({
                interactUrl: outgoingGrant.interact.redirect,
                transactionId: txId
            });
        }

        throw new Error("Unable to retrieve interactive authorization URL");
    } catch (error: any) {
        console.error('authorizePayment failed:', error);
        return res.status(500).json({ error: error.message || 'Payment initiation failed.' });
    }
});

export default router;