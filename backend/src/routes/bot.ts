import { Router } from 'express';
import { db } from '../db';
import {users, groupMembers, transactions, iouBalances} from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getClient } from '../lib/openPayments';
import { isPendingGrant } from '@interledger/open-payments';
import axios from 'axios';
import crypto from 'crypto';
import { Bot } from 'grammy';

// Create an incoming payment + quote purely to read the converted amounts for the
// confirmation card (what the sender pays vs. what the recipient receives). This
// mirrors the quote in authorizePayment, but its result is display-only —
// authorizePayment still quotes for real at pay time, so this never touches the
// money path.
async function quoteAmounts(
    client: any,
    senderWallet: any,
    receiverWallet: any,
    amount: number,
    paymentType: 'FIXED_SEND' | 'FIXED_RECEIVE',
) {
    const incomingGrant = await client.grant.request(
        { url: receiverWallet.authServer },
        { access_token: { access: [{ type: 'incoming-payment', actions: ['create', 'read'] }] } },
    );
    if (isPendingGrant(incomingGrant) || !incomingGrant.access_token) {
        throw new Error('Expected non-interactive incoming payment grant');
    }

    let incomingPayment;
    if (paymentType === 'FIXED_RECEIVE') {
        const value = Math.round(amount * Math.pow(10, receiverWallet.assetScale)).toString();
        incomingPayment = await client.incomingPayment.create(
            { url: receiverWallet.resourceServer, accessToken: incomingGrant.access_token.value },
            { walletAddress: receiverWallet.id, incomingAmount: { value, assetCode: receiverWallet.assetCode, assetScale: receiverWallet.assetScale } },
        );
    } else {
        incomingPayment = await client.incomingPayment.create(
            { url: receiverWallet.resourceServer, accessToken: incomingGrant.access_token.value },
            { walletAddress: receiverWallet.id },
        );
    }

    const quoteGrant = await client.grant.request(
        { url: senderWallet.authServer },
        { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } },
    );
    if (isPendingGrant(quoteGrant) || !quoteGrant.access_token) {
        throw new Error('Expected non-interactive quote grant');
    }

    const quote = paymentType === 'FIXED_RECEIVE'
        ? await client.quote.create(
            { url: senderWallet.resourceServer, accessToken: quoteGrant.access_token.value },
            { walletAddress: senderWallet.id, receiveAmount: incomingPayment.incomingAmount, receiver: incomingPayment.id, method: 'ilp' },
        )
        : await client.quote.create(
            { url: senderWallet.resourceServer, accessToken: quoteGrant.access_token.value },
            {
                walletAddress: senderWallet.id,
                debitAmount: { value: Math.round(amount * Math.pow(10, senderWallet.assetScale)).toString(), assetCode: senderWallet.assetCode, assetScale: senderWallet.assetScale },
                receiver: incomingPayment.id,
                method: 'ilp',
            },
        );

    return { debitAmount: quote.debitAmount, receiveAmount: quote.receiveAmount };
}

// Format an Open Payments Amount { value, assetScale } as a human string.
function fmtAmount(a: { value: string; assetScale: number }): string {
    return (Number(a.value) / Math.pow(10, a.assetScale)).toFixed(2);
}

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

// Resolve an AI-extracted recipient string to a registered user — group roster
// (by display name) first, then global username / phone / display name. Shared by
// the payment loop and the clarification fallback so both resolve identically.
async function resolveRecipient(
    recipientQuery: string | undefined,
    isGroup: boolean,
    groupTelegramId: string | undefined,
) {
    const query = recipientQuery?.trim();
    if (!query) return null;

    let matched: any = null;
    if (isGroup && groupTelegramId) {
        matched = await db.select({
                id: users.id,
                displayName: users.displayName,
                walletAddress: users.walletAddress,
            })
            .from(users)
            .innerJoin(groupMembers, eq(users.id, groupMembers.userId))
            .where(and(
                eq(groupMembers.groupTelegramId, groupTelegramId),
                eq(users.displayName, query),
            )).get();
    }
    if (!matched) matched = await db.select().from(users).where(eq(users.telegramUsername, query)).get();
    if (!matched) matched = await db.select().from(users).where(eq(users.phoneNumber, query)).get();
    if (!matched) matched = await db.select().from(users).where(eq(users.displayName, query)).get();
    return matched ?? null;
}

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

// 3. POST /bot/processPlainText (With multi-payment queue and dynamic network currency resolution) [1]
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


        if (text.toLowerCase().includes('settle')) {
            const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
            if (!sender) {
                return res.json({ status: 'error', reason: 'You must register first using /start.' });
            }

            const parts = text.split(/\s+/);
            const recipientQuery = parts.find(p => p.startsWith('@') || p.match(/^[a-zA-Z]+$/) && !p.toLowerCase().includes('settle') && !p.toLowerCase().includes('up') && !p.toLowerCase().includes('with'));

            if (!recipientQuery) {
                return res.json({ status: 'error', reason: 'Please specify who you want to settle with, e.g. <i>"settle with @seanwortley"</i>.' });
            }

            let matchedUser = null;
            const cleanQuery = recipientQuery.trim();
            if (cleanQuery.startsWith('@')) {
                matchedUser = await db.select().from(users).where(eq(users.telegramUsername, cleanQuery)).get();
            } else {
                matchedUser = await db.select().from(users).where(eq(users.displayName, cleanQuery)).get();
            }

            if (!matchedUser || !matchedUser.walletAddress) {
                return res.json({ status: 'error', reason: `Could not find a registered user named "${recipientQuery}".` });
            }

            const balance = await db.select().from(iouBalances).where(and(
                eq(iouBalances.debtorId, sender.id),
                eq(iouBalances.creditorId, matchedUser.id)
            )).get();

            if (!balance || Number(balance.amount) <= 0) {
                return res.json({ status: 'error', reason: `🎉 <b>All Clear!</b>\n\nYou do not owe any outstanding debts to ${matchedUser.displayName}.` });
            }

            const debtAmountDecimal = Number(balance.amount) / 100;
            const sessionId = crypto.randomUUID();

            activeSessions.set(sessionId, {
                transactions: [{
                    amount: debtAmountDecimal,
                    currency: balance.currency,
                    recipientWallet: matchedUser.walletAddress,
                    recipientName: `Settle: ${matchedUser.displayName}`,
                    paymentType: 'FIXED_SEND'
                }],
                currentIndex: 0,
                telegramUserId: telegramUserId.toString()
            });

            return res.json({
                status: 'ok',
                sessionId,
                payment: {
                    amountDisplay: debtAmountDecimal.toFixed(2),
                    currency: balance.currency,
                    recipientDisplay: `settle: ${matchedUser.displayName}`,
                    recipientWallet: matchedUser.walletAddress
                }
            });
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
        const isDirectIOU = text.toLowerCase().includes('i owe') || text.toLowerCase().includes('skuld');
        if (isDirectIOU && intentData.intent === 'PAYMENT') {
            intentData.intent = 'GROUP_FUND';
        }

        switch (intentData.intent) {

            case 'BALANCE_CHECK': {
                const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
                if (!sender) {
                    return res.json({
                        status: 'error',
                        reason: '❌ <b>Balance Check Failed:</b>\n\nYou need to register your profile first using /start.'
                    });
                }

                const currency = sender.assetCode || 'ZAR';
                // const startingBalance = 5000.00; // Simulated starting budget

                // 1. Query SQLite for completed transactions to calculate wallet spend
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

                // const currentBalance = startingBalance - totalSpent;

                // 2. Query SQLite iouBalances for outstanding Splitwise debts [1]
                const myDebts = await db.select({
                    amount: iouBalances.amount,
                    currency: iouBalances.currency,
                    creditorName: users.displayName // Selected as creditorName [1]
                })
                    .from(iouBalances)
                    .innerJoin(users, eq(iouBalances.creditorId, users.id))
                    .where(eq(iouBalances.debtorId, sender.id)).all();

                let debtLines = '';
                if (myDebts.length > 0) {
                    const lines = myDebts.map(d => `• You owe <b>${d.creditorName}</b>: <b>${(Number(d.amount) / 100).toFixed(2)} ${d.currency}</b>`);
                    debtLines = `\n\n📋 <b>Outstanding IOUs:</b>\n${lines.join('\n')}`;
                } else {
                    debtLines = `\n\n📋 <b>Outstanding IOUs:</b>\n🎉 <i>Good news! You currently do not owe anyone.</i>`;
                }

                return res.json({
                    status: 'error', // Displays directly in a chat bubble
                    reason: `ℹ️ <b>Live Balance Check</b>\n\n` +
                        `👤 <b>User:</b> ${sender.displayName}\n` +
                        `🏦 <b>Wallet:</b> <code>${sender.walletAddress}</code>\n` +
                        // `💵 <b>Starting Budget:</b> ${startingBalance.toFixed(2)} ${currency}\n` +
                        // `💸 <b>Total Spent:</b> ${totalSpent.toFixed(2)} ${currency}\n` +
                        // `🎯 <b>Available Balance:</b> <b>${currentBalance.toFixed(2)} ${currency}</b>` +
                        debtLines // Append the calculated debts! [1]
                });
            }

            // Inside case 'GROUP_FUND' (around line 200)
            case 'GROUP_FUND': {
                const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
                if (!sender) return res.status(400).json({ error: 'Sender not registered.' });

                const groupTelegramId = context?.chatId?.toString();
                const extractedTx = intentData.transactions?.[0];

                const splitAmount = extractedTx?.amount || 0;

                if (splitAmount <= 0) {
                    return res.json({ status: 'error', reason: 'Please specify a valid payment amount.' });
                }

                const client = await getClient();

                // 1. RESOLVE SENDER WALLET DYNAMICALLY TO GET THEIR CURRENCY [1]
                const senderWallet = await client.walletAddress.get({ url: normalizeWalletAddress(sender.walletAddress) });
                const senderCurrency = senderWallet.assetCode; // This is guaranteed to be 'ZAR' or 'EUR'! [1]

                // 2. INTERCEPT DEFAULT FLAG: Replace "DEFAULT" with the sender's dynamic wallet currency [1]
                const isDefault = extractedTx?.target_currency === 'DEFAULT' || !extractedTx?.target_currency;
                const currency = isDefault ? senderCurrency : extractedTx.target_currency;

                // Set the split scale based on the resolved currency scale
                const scaleMultiplier = Math.pow(10, senderWallet.assetScale); // Dynamic scale mapping [1]
                const amountInScale = Math.round(splitAmount * scaleMultiplier).toString();

                // ── PATHWAY A: DIRECT IOU ("I owe Fed R50") ── [1]
                const isDirectIOU = text.toLowerCase().includes('i owe') || text.toLowerCase().includes('skuld');

                if (isDirectIOU && extractedTx?.recipients?.length === 1) {
                    const recipientQuery = extractedTx.recipients[0].trim();

                    const creditor = await db.select().from(users).where(eq(users.telegramUsername, recipientQuery)).get();
                    if (!creditor) {
                        return res.json({ status: 'error', reason: `Could not find a registered user named "${recipientQuery}".` });
                    }

                    // Save the direct debt in SQLite: SENDER (You) owes CREDITOR (Fed) in the resolved currency! [1]
                    const existing = await db.select().from(iouBalances).where(and(
                        eq(iouBalances.debtorId, sender.id),
                        eq(iouBalances.creditorId, creditor.id)
                    )).get();

                    if (existing) {
                        const newAmount = (Number(existing.amount) + Number(amountInScale)).toString();
                        await db.update(iouBalances).set({ amount: newAmount }).where(eq(iouBalances.id, existing.id));
                    } else {
                        await db.insert(iouBalances).values({
                            id: crypto.randomUUID(),
                            groupId: groupTelegramId || 'private_chat',
                            debtorId: sender.id,
                            creditorId: creditor.id,
                            amount: amountInScale,
                            currency: currency // Now safely saved as 'ZAR' or 'EUR' instead of 'DEFAULT'! [1]
                        });
                    }

                    return res.json({
                        status: 'error',
                        reason: `📝 <b>IOU Recorded!</b>\n\n` +
                            `👤 <b>Debtor:</b> You (${sender.displayName})\n` +
                            `👤 <b>Creditor:</b> ${creditor.displayName}\n` +
                            `💵 <b>Amount Owed:</b> <b>${splitAmount.toFixed(2)} ${currency}</b>\n\n` +
                            `Type /balance to see your updated balances!`
                    });
                }

                // ── PATHWAY B: GROUP BILL SPLIT ("split R300 dinner") ── [1]
                if (!isGroup || !groupTelegramId) {
                    return res.json({ status: 'error', reason: 'You can only split group bills inside a group chat!' });
                }

                const members = await db.select({ id: users.id, displayName: users.displayName })
                    .from(users)
                    .innerJoin(groupMembers, eq(users.id, groupMembers.userId))
                    .where(eq(groupMembers.groupTelegramId, groupTelegramId)).all();

                if (members.length <= 1) {
                    return res.json({ status: 'error', reason: 'Not enough registered members in this group to split.' });
                }

                const totalMembers = members.length;
                const totalBill = splitAmount * totalMembers;

                for (const member of members) {
                    if (member.id !== sender.id) {
                        const existing = await db.select().from(iouBalances).where(and(
                            eq(iouBalances.groupId, groupTelegramId),
                            eq(iouBalances.debtorId, member.id),
                            eq(iouBalances.creditorId, sender.id)
                        )).get();

                        if (existing) {
                            const newAmount = (Number(existing.amount) + Number(amountInScale)).toString();
                            await db.update(iouBalances).set({ amount: newAmount }).where(eq(iouBalances.id, existing.id));
                        } else {
                            await db.insert(iouBalances).values({
                                id: crypto.randomUUID(),
                                groupId: groupTelegramId,
                                debtorId: member.id,
                                creditorId: sender.id,
                                amount: amountInScale,
                                currency: currency // Saved dynamically [1]
                            });
                        }
                    }
                }

                return res.json({
                    status: 'error',
                    reason: `📊 <b>IOU Split Successful!</b>\n\n` +
                        `💸 <b>Total Bill:</b> ${totalBill.toFixed(2)} ${currency}\n` +
                        `👥 <b>Split between:</b> ${totalMembers} members\n` +
                        `🎯 <b>Each pays:</b> <b>${splitAmount.toFixed(2)} ${currency}</b> to ${sender.displayName}\n\n` +
                        `Type /balance to see your updated balances!`
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

                // 1. RESOLVE SENDER PROFILE [1]
                const sender = await db.select().from(users).where(eq(users.telegramId, telegramUserId.toString())).get();
                if (!sender || !sender.walletAddress) {
                    return res.json({ status: 'error', reason: 'Sender not registered.' });
                }

                const client = await getClient();

                // 2. DYNAMICALLY RESOLVE SENDER WALLET FROM THE NETWORK [1]
                const senderWallet = await client.walletAddress.get({ url: normalizeWalletAddress(sender.walletAddress) });
                const senderCurrency = senderWallet.assetCode; // Guaranteed to be "EUR" or "ZAR" based on active network [1]

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
                        // 3. DYNAMICALLY RESOLVE RECEIVER WALLET FROM NETWORK [1]
                        const receiverWallet = await client.walletAddress.get({ url: normalizeWalletAddress(matchedUser.walletAddress) });

                        // 4. RESOLVE DEFAULT FLAG: If AI says "DEFAULT", use sender's native wallet currency [1]
                        const isDefault = tx.target_currency === 'DEFAULT' || !tx.target_currency;
                        const finalCurrency = isDefault ? senderCurrency : tx.target_currency;

                        // 5. CHOOSE PAYMENT TYPE DYNAMICALLY [1]
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

                // Quote the first (shown) payment so the card shows both sides.
                let debit: any, receive: any;
                try {
                    const firstReceiver = await client.walletAddress.get({ url: normalizeWalletAddress(firstTx.recipientWallet) });
                    const q = await quoteAmounts(client, senderWallet, firstReceiver, firstTx.amount, firstTx.paymentType);
                    debit = q.debitAmount;
                    receive = q.receiveAmount;
                } catch (e) {
                    console.error('processPlainText display quote failed, falling back to single amount:', e);
                }

                return res.json({
                    status: 'ok',
                    sessionId,
                    payment: {
                        amountDisplay: firstTx.amount.toFixed(2),
                        currency: firstTx.currency,
                        recipientDisplay: `${prefix}${firstTx.recipientName}`,
                        recipientWallet: firstTx.recipientWallet,
                        ...(debit && receive ? {
                            debitDisplay: fmtAmount(debit), debitCurrency: debit.assetCode,
                            receiveDisplay: fmtAmount(receive), receiveCurrency: receive.assetCode,
                        } : {}),
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
            const normalizedPhone = normalizePhoneNumber(recipient.value.trim());
            const matchedUser = await db.select().from(users).where(eq(users.phoneNumber, normalizedPhone)).get();

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

        // Quote up front so the confirmation card can show both sides.
        let debit: any, receive: any;
        try {
            const q = await quoteAmounts(client, senderWallet, receiverWallet, parseFloat(amount), paymentType);
            debit = q.debitAmount;
            receive = q.receiveAmount;
        } catch (e) {
            console.error('buildPayment display quote failed, falling back to single amount:', e);
        }

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
                recipientWallet,
                ...(debit && receive ? {
                    debitDisplay: fmtAmount(debit), debitCurrency: debit.assetCode,
                    receiveDisplay: fmtAmount(receive), receiveCurrency: receive.assetCode,
                } : {}),
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

// Helper to automatically convert local SA phone numbers (060...) to international format (2760...) [1]
function normalizePhoneNumber(phone: string): string {
    // Remove any spaces, dashes, or brackets
    let cleaned = phone.replace(/[^0-9+]/g, '').trim();

    // Strip leading "+" if present (e.g. +2760... -> 2760...)
    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }

    // If it starts with a local "0" and is 10 digits long, replace "0" with "27" [1]
    if (cleaned.startsWith('0') && cleaned.length === 10) {
        cleaned = '27' + cleaned.substring(1);
    }

    return cleaned;
}


/**
 * 9. POST /bot/group-settle
 * Resolves all outstanding debts in a group and maps them to Telegram IDs [1].
 */
router.post('/group-settle', async (req, res) => {
    const { groupTelegramId } = req.body;

    try {
        if (!groupTelegramId) {
            return res.status(400).json({ error: 'Missing groupTelegramId.' });
        }

        // 1. Fetch all active debts in this group [1]
        const rawDebts = await db.select()
            .from(iouBalances)
            .where(eq(iouBalances.groupId, groupTelegramId.toString())).all();

        const formattedDebts = [];

        // 2. Loop and resolve BOTH debtor and creditor Telegram details from users table [1]
        for (const d of rawDebts) {
            const debtor = await db.select().from(users).where(eq(users.id, d.debtorId)).get();
            const creditor = await db.select().from(users).where(eq(users.id, d.creditorId)).get();

            if (debtor && creditor && Number(d.amount) > 0) {
                formattedDebts.push({
                    id: d.id,
                    amountDecimal: Number(d.amount) / 100,
                    currency: d.currency,
                    debtorTelegramId: debtor.telegramId,
                    debtorName: debtor.displayName,
                    creditorName: creditor.displayName,
                    creditorUsername: creditor.telegramUsername ? creditor.telegramUsername.substring(1) : creditor.displayName, // strip leading '@' [1]
                });
            }
        }

        return res.json({ success: true, debts: formattedDebts });
    } catch (error) {
        console.error('group-settle failed:', error);
        return res.status(500).json({ error: 'Failed to fetch group debts.' });
    }
});

export default router;