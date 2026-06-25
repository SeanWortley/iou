import { Router } from 'express';
import { db } from '../db';
import { transactions, users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { getClient } from '../lib/openPayments';
import { bot } from '../index';
import { Grant } from '@interledger/open-payments';

const router = Router();

router.get('/callback', async (req, res) => {
    const { interact_ref, nonce } = req.query;

    if (!interact_ref || !nonce) {
        return res.status(400).send("Missing required callback parameters.");
    }

    try {
        // 1. Find the transaction by matching the nonce
        const tx = await db.select().from(transactions).where(eq(transactions.grantInteractNonce, nonce as string)).get();
        if (!tx) {
            return res.status(404).send("Transaction not found for this authorization session.");
        }

        // 2. Load the sender profile to get their wallet address and telegramId
        const sender = await db.select().from(users).where(eq(users.id, tx.userId!)).get();
        if (!sender) {
            return res.status(404).send("Sender user profile not found.");
        }

        const client = await getClient();

        const finalGrant = (await client.grant.continue(
            { url: tx.grantContinueUri!, accessToken: tx.grantContinueToken! },
            { interact_ref: interact_ref as string }
        )) as Grant;


        if (!finalGrant.access_token) {
            throw new Error('Access token is missing from completed grant continuation.');
        }

        const senderWallet = await client.walletAddress.get({ url: sender.walletAddress! });

        // 5. Create the Outgoing Payment to transfer the funds [1]
        const outgoingPayment = await client.outgoingPayment.create(
            { url: senderWallet.resourceServer, accessToken: finalGrant.access_token.value },
            { walletAddress: senderWallet.id, quoteId: tx.quoteUrl! }
        );

        // 6. Update transaction status in SQLite to COMPLETED
        await db.update(transactions)
            .set({
                status: 'COMPLETED',
                outgoingPaymentUrl: outgoingPayment.id,
                updatedAt: new Date()
            })
            .where(eq(transactions.id, tx.id));

        // 7. Send success notification directly to the user's private Telegram chat [1]
        const friendlyAmount = (Number(tx.debitAmount) / 100).toFixed(2);
        await bot.api.sendMessage(
            sender.telegramId,
            `🎉 *Payment Successful!*\n\nYou have successfully sent *${friendlyAmount} ${tx.assetCode}*.\n\nThank you for using BotPay!`,
            { parse_mode: 'Markdown' }
        );

        // 8. Redirect browser back to your Telegram Bot interface [1]
        const botUsername = process.env.BOT_USERNAME || 'YOUR_BOT_USERNAME';
        return res.redirect(`https://t.me/${botUsername}`);

    } catch (error: any) {
        console.error('[callback] payment execution failed:', error);

        // Update transaction status to FAILED in SQLite and notify the user
        try {
            const tx = await db.select().from(transactions).where(eq(transactions.grantInteractNonce, nonce as string)).get();
            if (tx) {
                await db.update(transactions)
                    .set({
                        status: 'FAILED',
                        errorMessage: error.message || 'Payment execution failed.',
                        updatedAt: new Date()
                    })
                    .where(eq(transactions.id, tx.id));

                const sender = await db.select().from(users).where(eq(users.id, tx.userId!)).get();
                if (sender) {
                    await bot.api.sendMessage(
                        sender.telegramId,
                        `Payment Failed!*\n\nYour transaction could not be completed.\nReason: _${error.message || 'Unknown error'}_`,
                        { parse_mode: 'Markdown' }
                    );
                }
            }
        } catch (dbError) {
            console.error('[callback] failed to update transaction status to FAILED', dbError);
        }

        return res.status(500).send(`Payment failed. ${error.message}`);
    }
});

export { router as callbackRouter };