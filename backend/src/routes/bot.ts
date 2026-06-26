import { Router } from 'express';
import { db } from '../db';
import {users, transactions, groupMembers} from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { getClient } from '../lib/openPayments';
import { randomUUID } from 'crypto';
import {isPendingGrant} from "@interledger/open-payments";
import axios from "axios";

const router = Router();

/**
 * 1. CHECK USER STATUS
 *
 */
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

/**
 * 2. INITIATE PAYMENT
 * This is where we run the Open Payments flow, generate a quote,
 * and get the Interactive Grant redirection URL.
 */
router.post('/initiate-payment', async (req, res) => {
    const { senderTelegramId, recipientPhoneNumber, amount, currency } = req.body;

    try {
        const sender = await db.select().from(users).where(eq(users.telegramId, senderTelegramId.toString())).get();
        const receiver = await db.select().from(users).where(eq(users.phoneNumber, recipientPhoneNumber)).get();

        if (!sender || !sender.walletAddress) {
            return res.status(400).json({ error: "Sender profile or wallet is not registered." });
        }
        if (!receiver || !receiver.walletAddress) {
            return res.status(400).json({ error: "Receiver profile or wallet is not registered." });
        }

        const client = await getClient();

        const senderWallet = await client.walletAddress.get({ url: sender.walletAddress });
        const receiverWallet = await client.walletAddress.get({ url: receiver.walletAddress });

        const incomingGrant = await client.grant.request(
            { url: receiverWallet.authServer },
            { access_token: { access: [{ type: 'incoming-payment', actions: ['create', 'read'] }] } }
        );

        if (isPendingGrant(incomingGrant)) {
            throw new Error('Expected non-interactive incoming payment grant');
        }

        if (!incomingGrant.access_token) {
            throw new Error('Access token is missing from incoming payment grant');
        }

        const scaleMultiplier = Math.pow(10, receiverWallet.assetScale);
        const amountInScale = Math.round(amount * scaleMultiplier).toString();

        const incomingPayment = await client.incomingPayment.create(
            { url: receiverWallet.resourceServer, accessToken: incomingGrant.access_token.value },

            {
                walletAddress: receiverWallet.id,
                incomingAmount: {
                    value: amountInScale,
                    assetCode: receiverWallet.assetCode,
                    assetScale: receiverWallet.assetScale
                }
            }
        );


        const quoteGrant = await client.grant.request(
            { url: senderWallet.authServer },
            { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } }
        );

        if (isPendingGrant(quoteGrant)) {
            throw new Error('Expected non-interactive quote grant');
        }

        if (!quoteGrant.access_token) {
            throw new Error('Access token is missing from quote grant');
        }

        const quote = await client.quote.create(
            { url: senderWallet.resourceServer, accessToken: quoteGrant.access_token.value },
            {
                walletAddress: senderWallet.id,
                receiveAmount: incomingPayment.incomingAmount,
                receiver: incomingPayment.id,
                method: 'ilp'
            }
        );

        const interactNonce = randomUUID();
        const callbackUrl = `${process.env.BACKEND_URL}/api/callback`;

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
            const txId = randomUUID();
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
                success: true,
                interactUrl: outgoingGrant.interact.redirect,
                txId
            });
        }

        throw new Error("Unable to retrieve interactive authorization URL");
    } catch (error: any) {
        console.error('[bot-router] initiate-payment error:', error);
        return res.status(500).json({ error: error.message || 'Payment initiation failed.' });
    }
});

/**
 * 3. AI PARSER GLUE ROUTE
 * Receives the raw message from the bot, forwards it to the AI teammate's server,
 * parses the intent, resolves the recipient's wallet, and returns verified details.
 */
router.post('/parse-message', async (req, res) => {
    const { text, telegram_object } = req.body;

    try {
        // TODO: ADD VALID AI_SERVER_URL
        const aiServerUrl = process.env.AI_SERVER_URL || 'http://localhost:8000/parse';

        const aiResponse = await axios.post(aiServerUrl, {
            text,
            telegram_object
        });

        const intentData = aiResponse.data;

        // Handle a Payment Intent
        if (intentData.intent === 'PAYMENT' && intentData.recipient) {
            const recipientQuery = intentData.recipient.trim();
            const isGroup = telegram_object?.chat?.type === 'group' || telegram_object?.chat?.type === 'supergroup';
            const groupTelegramId = telegram_object?.chat?.id?.toString();

            let matchedUser = null;

            // Search Strategy A: If in a Group Chat, search only inside that group's members
            if (isGroup && groupTelegramId) {
                const result = await db.select({
                    id: users.id,
                    displayName: users.displayName,
                    phoneNumber: users.phoneNumber,
                    walletAddress: users.walletAddress,
                })
                    .from(users)
                    .innerJoin(groupMembers, eq(users.id, groupMembers.userId))
                    .where(and(
                        eq(groupMembers.groupTelegramId, groupTelegramId),
                        eq(users.displayName, recipientQuery)
                    )).get();

                if (result) matchedUser = result;
            }

            // Search Strategy B: If not found in group or is a 1-1 Private Chat, search globally
            if (!matchedUser) {
                if (recipientQuery.startsWith('@')) {
                    // Match by @username
                    matchedUser = await db.select().from(users).where(eq(users.telegramUsername, recipientQuery)).get();
                } else {
                    // Match by Phone Number
                    matchedUser = await db.select().from(users).where(eq(users.phoneNumber, recipientQuery)).get();
                    if (!matchedUser) {
                        // Fallback: Match by Display Name globally
                        matchedUser = await db.select().from(users).where(eq(users.displayName, recipientQuery)).get();
                    }
                }
            }

            // Respond with the verified recipient's wallet pointer
            if (matchedUser && matchedUser.walletAddress) {
                return res.json({
                    success: true,
                    intent: 'PAYMENT',
                    amount: intentData.amount,
                    currency: intentData.currency || 'ZAR',
                    recipient: {
                        id: matchedUser.id,
                        displayName: matchedUser.displayName,
                        phoneNumber: matchedUser.phoneNumber,
                        walletAddress: matchedUser.walletAddress
                    }
                });
            } else {
                // AI parsed the recipient, but they aren't registered in UCT BotPay yet
                return res.json({
                    success: false,
                    intent: 'PAYMENT',
                    error: `I parsed a payment intent, but I couldn't find a registered BotPay user named "${recipientQuery}".`
                });
            }
        }

        // Handle non-payment intents (e.g., BALANCE_CHECK or UNKNOWN)
        return res.json({
            success: true,
            intent: intentData.intent,
            rawAiResponse: intentData
        });

    } catch (error: any) {
        console.error('[bot-router] AI parsing failed:', error);
        return res.status(500).json({ error: 'Failed to process message with the AI layer.' });
    }
});

export default router;