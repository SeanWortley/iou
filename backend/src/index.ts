import { config } from './config';
import express from 'express';
import cors from 'cors';
import { Bot, webhookCallback } from "grammy";
import { db } from './db';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';
import { getClient } from './lib/openPayments';
import crypto from 'crypto';

import { remitRouter } from './routes/remit';
import { callbackRouter } from './routes/callback';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { requestsRouter } from './routes/requests';
import { newsRouter } from './routes/news';
import { errorHandler } from './middleware/errorHandler';
import { seedNews } from './lib/seedNews';

import botRouter from './routes/bot';

const app = express();

// Middleware
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const bot = new Bot(process.env.BOT_TOKEN || '');

// Start command
bot.command('start', async (ctx) => {
  await ctx.reply("Welcome to BotPay! Please share your phone number to get started.", {
    reply_markup: {
      keyboard: [[{ text: "Share Phone Number", request_contact: true }]],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  });
});

// Handle contact sharing
bot.on('message:contact', async (ctx) => {

  const contact = ctx.message.contact;
  const phoneNumber = contact.phone_number;
  const telegramId = ctx.from.id.toString();
  const displayName = ctx.from.first_name || 'User';

  const telegramUsername = ctx.from.username ? `@${ctx.from.username}` : null;

  try {
    const existingUser = await db.select().from(users).where(eq(users.telegramId, telegramId)).get();

    if (existingUser) {
      await db.update(users).set({
        phoneNumber,
        telegramUsername
      }).where(eq(users.telegramId, telegramId));
    } else {
      await db.insert(users).values({
        id: crypto.randomUUID(),
        telegramId,
        telegramUsername,
        phoneNumber,
        displayName,
        createdAt: new Date()
      });
    }

    await ctx.reply(`Thank you! Your phone number ${phoneNumber} is linked. Now, please set up your Open Payments wallet address by typing:\n\n/linkwallet <wallet_address>`);
  } catch (error) {
    console.error("DB Register Error:", error);
    await ctx.reply("Something went wrong saving your contact info. Please try again.");
  }
});

bot.command('linkwallet', async (ctx) => {
  const walletAddress = ctx.match?.trim();

  if (!walletAddress) {
    return ctx.reply("Please provide your wallet address. Format:\n/linkwallet https://ilp.interledger-test.dev/yourname");
  }

  if (!ctx.from) {
    return ctx.reply("Unable to verify user details. Please try again.");
  }

  const telegramId = ctx.from.id.toString();

  try {
    await ctx.reply("Verifying your wallet address on the Interledger network...");

    const client = await getClient();
    const verifiedWallet = await client.walletAddress.get({ url: walletAddress });

    const existingUser = await db.select().from(users).where(eq(users.telegramId, telegramId)).get();
    if (!existingUser) {
      return ctx.reply("Please share your contact number using /start before linking a wallet.");
    }

    await db.update(users)
        .set({ walletAddress: verifiedWallet.id })
        .where(eq(users.telegramId, telegramId));

    await ctx.reply(`Success! Your payment wallet has been verified and linked:\n\n${verifiedWallet.id}`);
  } catch (error) {
    console.error("Open Payments Verification Error:", error);
    await ctx.reply("Could not resolve that wallet pointer. Please make sure it is a valid Open Payments wallet address.");
  }
});

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'openremit-backend' });
});

// Bot Webhook Route
// To comment out if want to test
app.post('/api/bot-webhook', webhookCallback(bot, 'express'));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/news', newsRouter);
app.use('/api/remit', remitRouter);
app.use('/api/callback', callbackRouter);
app.use('/api/bot', botRouter);

app.use(errorHandler);

seedNews().catch((err) => console.error('[seed] News seed failed:', err));

app.listen(config.port, () => {
  console.log(`\n  OpenRemit backend with Bot Support → http://localhost:${config.port}\n`);
});

// bot.start();
// console.log("Polling mode activated: Bot is listening directly to Telegram!");

export { bot };