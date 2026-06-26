import { Router } from 'express';
import { db } from '../db';
import { users, groupMembers, transactions } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getClient } from '../lib/openPayments';
import { isPendingGrant } from '@interledger/open-payments';
import axios from 'axios';
import crypto from 'crypto';

const router = Router();

interface QueuedTransaction {
    amount: number;
    currency: string;
    recipientWallet: string;
    recipientName: string;
    paymentType: 'FIXED_SEND' | 'FIXED_RECEIVE';
}

interface PaymentSession {
    transactions: QueuedTransaction[];
    currentIndex: number;
    telegramUserId: string;
}

// EXPORTED activeSessions so callbackRouter can read and update the queue [1]
export const activeSessions = new Map<string, PaymentSession>();
export const txToSessionMap = new Map<string, string>();

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
    const { telegramUserId, telegramUsername, phoneNumber, walletAddress } = req.body;

    try {
        const displayName = telegramUsername ? `@${telegramUsername}` : 'User';

        await db.insert(users).values({
            id: crypto.randomUUID(),
            telegramId: telegramUserId.toString(),
            telegramUsername: telegramUsername ? `@${telegramUsername}` : null,
            displayName,
            phoneNumber,
            walletAddress,
            createdAt: new Date(),
        });

        return res.json({ ok: true });
    } catch (error) {
        console.error('Registration failed:', error);
        return res.status(500).json({ error: 'Failed to complete registration' });
    }
});

// 3. POST /bot/processPlainText (With multi-payment queue and DEFAULT currency support) [1]
router.post('/processPlainText', async (req, res) => {
    const { telegramUserId, text, context, telegramMessage } = req.body;

    try {
        const isGroup = context?.chatType === 'group' || context?.chatType === 'supergroup';
        const groupTelegramId = context?.chatId?.toString();

        let groupRoster: string[] = [];
        if (isGroup && groupTelegramId) {
            const members = await db.select({ displayName: users.displayName })
                .from(users)
                .innerJoin(groupMembers, eq(users.id, groupMembers.userId))
                .where(eq(groupMembers.groupTelegramId, groupTelegramId))
                .all();
            groupRoster = members.map(m => m.displayName).filter((name): name is string => !!name);
        }

        const aiServerUrl = process.env.AI_SERVER_URL || 'http://127.0.0.1:8000/parse';
        const aiResponse = await axios.post(aiServerUrl, {
            text,
            chat_event: telegramMessage || {},
            group_roster: groupRoster
        });

        const intentData = aiResponse.data;
        const sessionId = crypto.randomUUID();

        console.log('🤖 [AI Parser Response]:\n', JSON.stringify(intentData, null, 2));

        switch (intentData.intent) {

            // ── DYNAMIC LIVE BALANCE CHECK ──
            case 'BALANCE_CHECK': {
                const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
                if (!sender) {
                    return res.json({ status: 'error', reason: 'You must register before checking your balance.' });
                }
                const currency = sender.assetCode || 'ZAR';

                // Look up all completed transactions for this user in SQLite
                const completedTxs = await db.select()
                    .from(transactions)
                    .where(and(
                        eq(transactions.userId, sender.id),
                        eq(transactions.status, 'COMPLETED')
                    )).all();

                let totalSpent = 0;
                for (const tx of completedTxs) {
                    if (tx.debitAmount && tx.assetScale) {
                        totalSpent += Number(tx.debitAmount) / Math.pow(10, tx.assetScale);
                    }
                }

                const startingBalance = 5000.00; // Simulated starting budget
                const currentBalance = startingBalance - totalSpent;

                return res.json({
                    status: 'error', // Returning status 'error' displays this text directly in Telegram as a message bubble
                    reason: `ℹ️ <b>Live Balance Check</b>\n\n` +
                        `👤 <b>User:</b> ${sender.displayName}\n` +
                        `🏦 <b>Wallet:</b> <code>${sender.walletAddress}</code>\n` +
                        `💵 <b>Starting Budget:</b> ${startingBalance.toFixed(2)} ${currency}\n` +
                        `💸 <b>Total Spent:</b> ${totalSpent.toFixed(2)} ${currency}\n` +
                        `🎯 <b>Available Balance:</b> <b>${currentBalance.toFixed(2)} ${currency}</b>`
                });
            }

            // ── GROUP FUND INTENT ──
            case 'GROUP_FUND': {
                return res.json({
                    status: 'error',
                    reason: '👥 <b>Group Funding / Bill Splitting:</b>\n\nGroup bill pooling is currently in view-only mode. To execute, please send individual payments to members one-by-one!'
                });
            }

            case 'CLARIFY': {
                return res.json({
                    status: 'needs_clarification',
                    sessionId,
                    clarifications: [
                        {
                            field: 'recipient',
                            question: '🤔 I could not quite read that. Who would you like to pay, and how much?',
                            suggestions: []
                        }
                    ]
                });
            }

            case 'PAYMENT':
            case 'PAYMENT_MULTIPLE': {
                const extractedTransactions = intentData.transactions || [];
                if (extractedTransactions.length === 0) {
                    return res.json({ status: 'error', reason: 'Could not detect any transaction details.' });
                }

                // FETCH sender profile to read their native wallet currency (e.g. ZAR or USD) [1]
                const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
                const senderCurrency = sender?.assetCode || 'ZAR'; // Fallback to ZAR if database column is empty [1]

                const sessionQueue: QueuedTransaction[] = [];

                for (const tx of extractedTransactions) {
                    const recipientQuery = tx.recipients?.[0]?.trim();
                    const amount = tx.amount;

                    if (!recipientQuery || !amount || amount <= 0) continue;

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
                            if (!matchedUser) {
                                matchedUser = await db.select().from(users).where(eq(users.displayName, recipientQuery)).get();
                            }
                        }
                    }

                    if (matchedUser && matchedUser.walletAddress) {
                        // RESOLVE "DEFAULT" CURRENCY: If the AI returned "DEFAULT", fall back to sender's wallet currency [1]
                        const isDefault = tx.target_currency === 'DEFAULT' || !tx.target_currency;
                        const finalCurrency = isDefault ? senderCurrency : tx.target_currency;

                        // Set paymentType: If final currency is different from sender's wallet, use FIXED_RECEIVE [1]
                        const isForeign = finalCurrency !== senderCurrency;
                        const paymentType = isForeign ? 'FIXED_RECEIVE' : 'FIXED_SEND';

                        sessionQueue.push({
                            amount,
                            currency: finalCurrency,
                            recipientWallet: matchedUser.walletAddress,
                            recipientName: matchedUser.displayName || 'Registered User',
                            paymentType
                        });
                    }
                }

                if (sessionQueue.length === 0) {
                    return res.json({
                        status: 'error',
                        reason: 'Could not resolve any registered recipients in the system.'
                    });
                }

                activeSessions.set(sessionId, {
                    transactions: sessionQueue,
                    currentIndex: 0,
                    telegramUserId: telegramUserId.toString()
                });

                const firstTx = sessionQueue[0];
                const prefix = sessionQueue.length > 1 ? `[1/${sessionQueue.length}] ` : '';

                return res.json({
                    status: 'ok',
                    sessionId,
                    payment: {
                        amountDisplay: firstTx.amount.toFixed(2),
                        currency: firstTx.currency,
                        recipientDisplay: `${prefix}${firstTx.recipientName}`,
                        recipientWallet: firstTx.recipientWallet
                    }
                });
            }

            default: {
                return res.json({
                    status: 'error',
                    reason: 'I was unable to understand your request.'
                });
            }
        }

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

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /bot/authorizePayment (FIXED TYPE ERRORS ON currentTx METADATA) [1]
// ─────────────────────────────────────────────────────────────────────────────
router.post('/authorizePayment', async (req, res) => {
    const { telegramUserId, sessionId } = req.body;

    try {
        const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
        if (!sender || !sender.walletAddress) {
            return res.status(404).json({ error: 'Sender not registered.' });
        }

        const session = activeSessions.get(sessionId);
        if (!session || !session.transactions[session.currentIndex]) {
            return res.status(400).json({ error: 'Session expired or invalid.' });
        }

        // GRAB transaction details from currentTx [1]
        const currentTx = session.transactions[session.currentIndex];

        const client = await getClient();

        const senderWallet = await client.walletAddress.get({ url: normalizeWalletAddress(sender.walletAddress) });
        const receiverWallet = await client.walletAddress.get({ url: normalizeWalletAddress(currentTx.recipientWallet) }); // FIXED reference to currentTx [1]

        const incomingGrant = await client.grant.request(
            { url: receiverWallet.authServer },
            { access_token: { access: [{ type: 'incoming-payment', actions: ['create', 'read'] }] } }
        );

        if (isPendingGrant(incomingGrant) || !incomingGrant.access_token) {
            throw new Error('Expected non-interactive incoming payment grant');
        }

        let incomingPayment;
        let quote;

        if (currentTx.paymentType === 'FIXED_RECEIVE') { // FIXED reference to currentTx [1]
            const scaleMultiplier = Math.pow(10, receiverWallet.assetScale);
            const amountInScale = Math.round(currentTx.amount * scaleMultiplier).toString(); // FIXED reference to currentTx [1]

            incomingPayment = await client.incomingPayment.create(
                { url: receiverWallet.resourceServer, accessToken: incomingGrant.access_token.value },
                {
                    walletAddress: receiverWallet.id,
                    incomingAmount: { value: amountInScale, assetCode: receiverWallet.assetCode, assetScale: receiverWallet.assetScale }
                }
            );

            const quoteGrant = await client.grant.request(
                { url: senderWallet.authServer },
                { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } }
            );

            if (isPendingGrant(quoteGrant) || !quoteGrant.access_token) {
                throw new Error('Expected non-interactive quote grant');
            }

            quote = await client.quote.create(
                { url: senderWallet.resourceServer, accessToken: quoteGrant.access_token.value },
                {
                    walletAddress: senderWallet.id,
                    receiveAmount: incomingPayment.incomingAmount,
                    receiver: incomingPayment.id,
                    method: 'ilp'
                }
            );
        } else {
            const scaleMultiplier = Math.pow(10, senderWallet.assetScale);
            const amountInScale = Math.round(currentTx.amount * scaleMultiplier).toString(); // FIXED reference to currentTx [1]

            incomingPayment = await client.incomingPayment.create(
                { url: receiverWallet.resourceServer, accessToken: incomingGrant.access_token.value },
                { walletAddress: receiverWallet.id }
            );

            const quoteGrant = await client.grant.request(
                { url: senderWallet.authServer },
                { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } }
            );

            if (isPendingGrant(quoteGrant) || !quoteGrant.access_token) {
                throw new Error('Expected non-interactive quote grant');
            }

            quote = await client.quote.create(
                { url: senderWallet.resourceServer, accessToken: quoteGrant.access_token.value },
                {
                    walletAddress: senderWallet.id,
                    debitAmount: { value: amountInScale, assetCode: senderWallet.assetCode, assetScale: senderWallet.assetScale },
                    receiver: incomingPayment.id,
                    method: 'ilp'
                }
            );
        }

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
                paymentType: currentTx.paymentType, // FIXED reference to currentTx [1]
                senderWalletAddress: senderWallet.id,
                receiverWalletAddress: receiverWallet.id,
                debitAmount: quote.debitAmount.value,
                assetCode: senderWallet.assetCode,
                assetScale: senderWallet.assetScale,
                incomingPaymentUrl: incomingPayment.id,
                quoteUrl: quote.id,

                grantContinueUri: outgoingGrant.continue.uri,
                grantContinueToken: outgoingGrant.continue.access_token.value,
                grantInteractNonce: interactNonce,

                userId: sender.id,
                createdAt: now,
                updatedAt: now
            });

            // Map txId to parent sessionId [1]
            txToSessionMap.set(txId, sessionId);

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

// 6. POST /bot/buildPayment
router.post('/buildPayment', async (req, res) => {
    const { telegramUserId, recipient, amount, paymentType } = req.body;

    try {
        let recipientWallet = '';
        let recipientName = 'External Wallet';

        const client = await getClient();

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
            recipientWallet = recipient.value.trim();
            try {
                const resolvedWallet = await client.walletAddress.get({ url: recipientWallet });
                recipientName = `External (${resolvedWallet.id.split('/').pop()})`;
            } catch (e) {
                return res.json({ status: 'error', reason: `Invalid Open Payments wallet address pointer.` });
            }
        }

        const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
        if (!sender) {
            return res.status(404).json({ error: 'Sender not registered.' });
        }

        const senderWallet = await client.walletAddress.get({ url: normalizeWalletAddress(sender.walletAddress!) });
        const receiverWallet = await client.walletAddress.get({ url: normalizeWalletAddress(recipientWallet) });

        const currency = (paymentType === 'FIXED_SEND') ? senderWallet.assetCode : receiverWallet.assetCode;

        const sessionId = crypto.randomUUID();

        activeSessions.set(sessionId, {
            transactions: [{
                amount: parseFloat(amount),
                currency,
                recipientWallet,
                recipientName,
                paymentType: paymentType as 'FIXED_SEND' | 'FIXED_RECEIVE'
            }],
            currentIndex: 0,
            telegramUserId: telegramUserId.toString()
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

// 7. POST /bot/confirmPayment
router.post('/confirmPayment', async (req, res) => {
    const { telegramUserId, sessionId } = req.body;

    try {
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.status(400).json({ error: 'Payment session expired or not found.' });
        }
        return res.json({ ok: true });
    } catch (error) {
        console.error('confirmPayment failed:', error);
        return res.status(500).json({ error: 'Failed to confirm payment session.' });
    }
});

// 8. POST /bot/finalizePayment
router.post('/finalizePayment', async (req, res) => {
    const { telegramUserId, transactionId } = req.body;

    try {
        const tx = await db.select().from(transactions).where(eq(transactions.id, transactionId)).get();

        if (!tx) {
            return res.json({ status: 'FAILED', detail: 'Transaction not found.' });
        }

        if (tx.status === 'COMPLETED') {
            return res.json({ status: 'COMPLETED' });
        }

        if (tx.status === 'FAILED') {
            return res.json({ status: 'FAILED', detail: tx.errorMessage || 'Ledger transfer failed.' });
        }

        return res.json({
            status: 'FAILED',
            detail: 'Authorization not detected on the ledger yet. Please ensure you have approved the payment in your wallet.'
        });

    } catch (error: any) {
        console.error('finalizePayment failed:', error);
        return res.json({ status: 'FAILED', detail: error.message || 'Verification failed.' });
    }
});

function normalizeWalletAddress(url: string): string {
    const trimmed = url.trim();
    if (trimmed.startsWith('$')) {
        return 'https://' + trimmed.substring(1);
    }
    return trimmed;
}

export default router;