import { Router } from 'express';
import { db } from '../db';
import { users, groupMembers, transactions } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getClient } from '../lib/openPayments';
import { isPendingGrant } from '@interledger/open-payments';
import axios from 'axios';
import crypto from 'crypto';

const router = Router();

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

// Inside backend/src/routes/bot.ts

router.post('/processPlainText', async (req, res) => {
    const { telegramUserId, text, context, telegramMessage } = req.body;

    try {
        const isGroup = context?.chatType === 'group' || context?.chatType === 'supergroup';
        const groupTelegramId = context?.chatId?.toString();

        // 1. DYNAMICALLY BUILD THE ROSTER FROM SQLITE [1]
        // If we are in a group chat, grab the display names of all registered users in this group! [1]
        let groupRoster: string[] = [];
        if (isGroup && groupTelegramId) {
            const members = await db.select({ displayName: users.displayName })
                .from(users)
                .innerJoin(groupMembers, eq(users.id, groupMembers.userId))
                .where(eq(groupMembers.groupTelegramId, groupTelegramId))
                .all(); // .all() gets the list of rows

            // Map DB rows to a string list: ["@Noah_99", "@Sizwe", ...] [1]
            groupRoster = members.map(m => m.displayName).filter((name): name is string => !!name);
        }

        // 2. Call their FastAPI endpoint on '/parse' [1]
        const aiServerUrl = process.env.AI_SERVER_URL || 'http://localhost:8000/parse';

        // We send the EXACT keys their UserRequest BaseModel expects! [1]
        const aiResponse = await axios.post(aiServerUrl, {
            text: text,
            chat_event: telegramMessage || {},
            group_roster: groupRoster // Passes the real SQLite group roster dynamically [1]
        });

        const intentData = aiResponse.data; // This is the structured PaymentIntent JSON! [1]

        const sessionId = crypto.randomUUID();

        if (intentData.intent !== 'PAYMENT') {
            return res.json({ status: 'error', reason: 'Only payment instructions are supported right now.' });
        }

        // Retrieve the transaction details from the first item of their extracted list [1]
        const extractedTx = intentData.transactions?.[0];
        if (!extractedTx || !extractedTx.recipients?.length) {
            return res.json({ status: 'error', reason: 'Could not detect who you want to pay.' });
        }

        const recipientQuery = extractedTx.recipients[0].trim(); // First recipient [1]
        const amount = extractedTx.amount;

        if (!amount || amount <= 0) {
            return res.json({ status: 'error', reason: 'Please specify a valid payment amount.' });
        }

        // 3. Resolve the recipient globally or within group [1]
        let matchedUser = null;
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

        // Save to our active payment sessions map [1]
        activeSessions.set(sessionId, {
            amount,
            currency: extractedTx.target_currency || 'ZAR',
            recipientWallet: matchedUser.walletAddress
        });

        return res.json({
            status: 'ok',
            sessionId,
            payment: {
                amountDisplay: amount.toFixed(2),
                currency: extractedTx.target_currency || 'ZAR',
                recipientDisplay: matchedUser.displayName,
                recipientWallet: matchedUser.walletAddress
            }
        });

    } catch (error) {
        console.error('processPlainText failed:', error);
        return res.json({ status: 'error', reason: 'Failed to complete transaction lookup.' });
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

// ─────────────────────────────────────────────────────────────────────────────
// 6. POST /bot/buildPayment
// The manual path wizard. No AI required — recipient and amount are structured. [1]
// ─────────────────────────────────────────────────────────────────────────────
router.post('/buildPayment', async (req, res) => {
    const { telegramUserId, recipient, amount, paymentType } = req.body;

    try {
        let recipientWallet = '';
        let recipientName = 'External Wallet';

        // Uncomment getClient at the top of your imports if you commented it out! [1]
        const client = await getClient();

        // 1. Resolve recipient based on the manual builder selection [1]
        if (recipient.type === 'phone') {
            const matchedUser = await db.select().from(users).where(eq(users.phoneNumber, recipient.value.trim())).get();
            if (!matchedUser || !matchedUser.walletAddress) {
                return res.json({ status: 'error', reason: `No registered user found with phone number "${recipient.value}".` });
            }
            recipientWallet = matchedUser.walletAddress;
            recipientName = matchedUser.displayName || 'Registered User';
        }
        else if (recipient.type === 'username') {
            const cleanUsername = recipient.value.trim().startsWith('@') ? recipient.value.trim() : `@${recipient.value.trim()}`;
            const matchedUser = await db.select().from(users).where(eq(users.telegramUsername, cleanUsername)).get();
            if (!matchedUser || !matchedUser.walletAddress) {
                return res.json({ status: 'error', reason: `No registered user found with username "${cleanUsername}".` });
            }
            recipientWallet = matchedUser.walletAddress;
            recipientName = matchedUser.displayName || 'Registered User';
        }
        else if (recipient.type === 'wallet') {
            // Direct out-of-ecosystem payment to a raw wallet pointer [1]
            recipientWallet = recipient.value.trim();
            try {
                const resolvedWallet = await client.walletAddress.get({ url: recipientWallet });
                recipientName = `External (${resolvedWallet.id.split('/').pop()})`;
            } catch (e) {
                return res.json({ status: 'error', reason: `Invalid Open Payments wallet address pointer.` });
            }
        }

        const receiverWallet = await client.walletAddress.get({ url: recipientWallet });
        const currency = receiverWallet.assetCode; // e.g. "USD" or "ZAR"

        const sessionId = crypto.randomUUID();

        activeSessions.set(sessionId, {
            amount: parseFloat(amount),
            currency,
            recipientWallet
        });

        return res.json({
            status: 'ok',
            sessionId,
            payment: {
                amountDisplay: parseFloat(amount).toFixed(2),
                currency,
                recipientDisplay: recipientName,
                recipientWallet
            }
        });

    } catch (error: any) {
        console.error('buildPayment failed:', error);
        return res.json({ status: 'error', reason: error.message || 'Failed to construct manual payment.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. POST /bot/confirmPayment
// User confirmed the payment interpretation is correct (no money has moved yet) [1].
// ─────────────────────────────────────────────────────────────────────────────
router.post('/confirmPayment', async (req, res) => {
    const { telegramUserId, sessionId } = req.body;

    try {
        // Verify the payment session exists in our memory cache [1]
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.status(400).json({ error: 'Payment session expired or not found.' });
        }

        // Acknowledge the confirmation
        return res.json({ ok: true });
    } catch (error) {
        console.error('confirmPayment failed:', error);
        return res.status(500).json({ error: 'Failed to confirm payment session.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. POST /bot/finalizePayment
// We check SQLite to see if the callback route successfully completed the transfer [1].
// ─────────────────────────────────────────────────────────────────────────────
router.post('/finalizePayment', async (req, res) => {
    const { telegramUserId, transactionId } = req.body;

    try {
        // Find the transaction in SQLite [1]
        const tx = await db.select().from(transactions).where(eq(transactions.id, transactionId)).get();

        if (!tx) {
            return res.json({ status: 'FAILED', detail: 'Transaction not found.' });
        }

        // Return the status based on whether /api/callback completed the ledger transfer [1]
        if (tx.status === 'COMPLETED') {
            return res.json({ status: 'COMPLETED' });
        }

        if (tx.status === 'FAILED') {
            return res.json({ status: 'FAILED', detail: tx.errorMessage || 'Ledger transfer failed.' });
        }

        // If still in AWAITING_GRANT, the redirect callback hasn't finished executing yet [1]
        return res.json({
            status: 'FAILED',
            detail: 'Authorization not detected on the ledger yet. Please ensure you have approved the payment in your wallet.'
        });

    } catch (error: any) {
        console.error('finalizePayment failed:', error);
        return res.json({ status: 'FAILED', detail: error.message || 'Verification failed.' });
    }
});

export default router;