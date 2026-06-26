import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { transactions, users } from '../db/schema';
import { getClient, isFinalizedGrant } from '../lib/openPayments';
import { Bot } from 'grammy';

const bot = new Bot(process.env.BOT_TOKEN || '');
export const callbackRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/callback
//
// GNAP redirect endpoint — the user's wallet auth server redirects their
// browser here after they approve or deny the payment consent screen.
//
// On success:    ?interact_ref=...&transactionId=...
// On rejection:  ?result=grant_rejected&transactionId=...
// ─────────────────────────────────────────────────────────────────────────────
callbackRouter.get('/', async (req, res) => {
    const { interact_ref, transactionId, result } = req.query as Record<string, string>;

    if (!transactionId) {
        return res.status(400).send('Missing transactionId in callback query');
    }

    const [tx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, transactionId));

    if (!tx || tx.status !== 'AWAITING_GRANT') {
        return res.status(400).send(page('Payment not found or already processed.', false));
    }

    // 1. User declined consent at their wallet
    if (!interact_ref || result === 'grant_rejected') {
        await db
            .update(transactions)
            .set({
                status:       'FAILED',
                errorMessage: result === 'grant_rejected'
                    ? 'Payment declined — you cancelled the authorisation at your wallet.'
                    : 'Authorisation did not complete. Please try again.',
                updatedAt: new Date(),
            })
            .where(eq(transactions.id, transactionId));

        // NOTIFY: Send cancellation alert on Telegram [1]
        const sender = await db.select().from(users).where(eq(users.id, tx.userId!)).get();
        if (sender) {
            await bot.api.sendMessage(
                sender.telegramId,
                `❌ <b>Payment Cancelled!</b>\n\nYou declined the authorization request at your wallet.`,
                { parse_mode: 'HTML' } // Changed to HTML [1]
            );
        }

        return res.send(page('Payment cancelled. Return to Telegram and try again.', false));
    }

    try {
        const client = await getClient();

        const finalizedGrant = await client.grant.continue(
            { url: tx.grantContinueUri!, accessToken: tx.grantContinueToken! },
            { interact_ref }
        );

        if (!isFinalizedGrant(finalizedGrant)) {
            throw new Error('Grant continuation did not return an access token.');
        }

        const sendingWallet = await client.walletAddress.get({ url: tx.senderWalletAddress });

        const outgoingPayment = await client.outgoingPayment.create(
            {
                url:         sendingWallet.resourceServer,
                accessToken: finalizedGrant.access_token.value,
            },
            {
                walletAddress: sendingWallet.id,
                quoteId:       tx.quoteUrl!,
                metadata:      { description: 'IOU payment' },
            }
        );

        await db
            .update(transactions)
            .set({
                status:             'COMPLETED',
                outgoingPaymentUrl: outgoingPayment.id,
                updatedAt:          new Date(),
            })
            .where(eq(transactions.id, transactionId));

        const sender = await db.select().from(users).where(eq(users.id, tx.userId!)).get();
        if (sender) {
            const friendlyAmount = (Number(tx.debitAmount) / Math.pow(10, tx.assetScale)).toFixed(2);
            await bot.api.sendMessage(
                sender.telegramId,
                `🎉 <b>Payment Successful!</b>\n\nYou have successfully sent <b>${friendlyAmount} ${tx.assetCode}</b>.\n\nThank you for using BotPay!`,
                { parse_mode: 'HTML' }
            );
        }

        res.send(page('Payment sent! Return to Telegram.', true));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[callback] Payment failed:', message);

        await db
            .update(transactions)
            .set({ status: 'FAILED', errorMessage: message, updatedAt: new Date() })
            .where(eq(transactions.id, transactionId));

        const sender = await db.select().from(users).where(eq(users.id, tx.userId!)).get();
        if (sender) {
            // 🛡️ SAFELY CLEAN ERROR MESSAGE: Strips out tags to prevent HTML parsing crashes [1]
            const cleanErrorMessage = message
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            await bot.api.sendMessage(
                sender.telegramId,
                `❌ <b>Payment Failed!</b>\n\nYour transaction could not be completed.\n\nReason: <i>${cleanErrorMessage}</i>`,
                { parse_mode: 'HTML' } // Changed to HTML to prevent crashes [1]
            );
        }

        res.send(page(`Payment failed: ${message}`, false));
    }
});

function page(message: string, success: boolean): string {
    const colour = success ? '#22c55e' : '#ef4444';
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IOU</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f172a;color:#f8fafc}
.box{text-align:center;padding:2rem}.icon{font-size:3rem}
p{font-size:1.1rem;color:#94a3b8}h2{color:${colour}}</style></head>
<body><div class="box"><div class="icon">${success ? '✓' : '✗'}</div>
<h2>${message}</h2><p>You can close this tab and return to Telegram.</p>
</div></body></html>`;
}