import express from "express";
import { Bot, webhookCallback } from "grammy";
import { handleBotMessage, handleCallbackQuery } from "./handler";

const PORT = Number(process.env.PORT) || 3000;
const app = express();

const token = process.env.BOT_TOKEN ?? "";
if (!token) console.warn("BOT_TOKEN not set — bot will be created with empty token.");

const bot = new Bot(token);

bot.on("message:text", handleBotMessage);
bot.on("message:contact", handleBotMessage);
bot.on("callback_query", handleCallbackQuery);

app.use(express.json());
app.post("/webhook", webhookCallback(bot, "express"));

app.listen(PORT, (err?: any) => {
  if (err) console.error(err);
  console.log("Server listening on PORT", PORT);
});

export default app;
