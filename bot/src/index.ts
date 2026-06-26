import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// Load bot/.env regardless of the cwd `npm run bot` is invoked from.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import express from "express";
import { Bot, webhookCallback } from "grammy";
import { handleBotMessage, handleCallbackQuery, handleChatMemberUpdate } from "./handler";

// ─────────────────────────────────────────────────────────────────────────────
// Two ways to run the bot:
//
//   1. Long-polling (default) — no public URL needed. Telegram is polled
//      directly. Simplest for local dev / demos. Just set BOT_TOKEN.
//
//   2. Webhook (set WEBHOOK_URL) — Telegram pushes updates to a public HTTPS
//      URL. Use this with ngrok:  ngrok http 3000  →  copy the https URL into
//      WEBHOOK_URL. On boot we register <WEBHOOK_URL>/webhook with Telegram.
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const token = process.env.BOT_TOKEN ?? "";
const webhookUrl = process.env.WEBHOOK_URL?.replace(/\/+$/, ""); // strip trailing slash

if (!token) {
  console.error("✖ BOT_TOKEN is not set. Get one from @BotFather and put it in bot/.env");
  process.exit(1);
}

const bot = new Bot(token);

// handleBotMessage inspects msg.contact / msg.text itself, so one listener covers both.
bot.on("message", handleBotMessage);
bot.on("callback_query:data", handleCallbackQuery);
// Fires when the bot's own membership changes — used to welcome a new group.
bot.on("my_chat_member", handleChatMemberUpdate);

// Log (but don't crash on) errors thrown inside handlers.
bot.catch((err) => {
  console.error("Bot handler error:", err.error);
});

async function main(): Promise<void> {
  // Make sure we know who we are (and fail fast on a bad token).
  const me = await bot.api.getMe();
  // Handlers build group deep links (https://t.me/<username>?start=…) from this.
  process.env.BOT_USERNAME = me.username;

  // my_chat_member is included by default, but be explicit so the group
  // welcome reliably fires alongside messages and button taps.
  const allowedUpdates = ["message", "callback_query", "my_chat_member"] as const;

  if (webhookUrl) {
    // ── Webhook mode (ngrok / any public HTTPS host) ──────────────────────────
    const app = express();
    app.use(express.json());
    app.get("/health", (_req, res) => res.json({ ok: true, bot: me.username }));
    app.post("/webhook", webhookCallback(bot, "express"));

    app.listen(PORT, async () => {
      await bot.api.setWebhook(`${webhookUrl}/webhook`, { allowed_updates: [...allowedUpdates] });
      console.log(`✓ @${me.username} listening on :${PORT}`);
      console.log(`✓ webhook registered → ${webhookUrl}/webhook`);
    });
  } else {
    // ── Long-polling mode (no public URL needed) ──────────────────────────────
    await bot.api.deleteWebhook(); // clear any stale webhook so polling works
    await bot.start({
      allowed_updates: [...allowedUpdates],
      onStart: () => console.log(`✓ @${me.username} running (long-polling)`),
    });
  }
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
