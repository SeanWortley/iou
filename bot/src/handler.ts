import {
  authorizePayment,
  buildPayment,
  checkUser,
  confirmPayment,
  finalizePayment,
  joinGroup,
  processPlainText,
  processRegistration,
  type ChatContext,
  type ClarificationField,
  type ParseResult,
  type PaymentObject,
  type RecipientType,
} from "./backendClient";

// ─────────────────────────────────────────────────────────────────────────────
// Conversation state machine
//
// Registration:   awaiting_contact → awaiting_wallet_address → idle
//                 (always happens in a DM)
//
// Payments are executed by a custodial client wallet on the user's behalf, so
// we never collect a private key or a payment password — registration just ties
// a Telegram user to their wallet address.
//
// Groups ("money groups"):
//   • bot added → posts a welcome telling people to /join
//   • /join     → registered users are enrolled in the roster; others get a
//                 deep-link button that opens a DM and runs /start (carrying the
//                 group id, so they're enrolled once setup finishes).
//   • /iou … in a group is a TRIGGER: the bot resolves the sender, parses with
//     group context, then bounces the whole confirm → approve tail into the
//     sender's DM. On success it announces the payment back in the group.
//
// Payment tail (DM): ParseResult ──(clarify loop)──► awaiting_confirmation
//   ──Confirm──► confirmPayment → authorizePayment → awaiting_approval
//   ──"I've approved"──► finalizePayment → idle
// ─────────────────────────────────────────────────────────────────────────────

type UserStep =
  | "awaiting_contact"
  | "awaiting_wallet_address"
  | "idle"
  | "awaiting_manual_recipient_type"
  | "awaiting_manual_recipient"
  | "awaiting_manual_amount"
  | "awaiting_manual_paytype"
  | "awaiting_clarification"
  | "awaiting_confirmation"
  | "awaiting_approval";

type UserState = {
  step: UserStep;
  // registration
  contact?: string;
  walletAddress?: string;
  pendingGroupId?: string; // enrol in this group once registration finishes
  // manual payment builder
  recipientType?: RecipientType;
  manualRecipient?: string;
  manualAmount?: string;
  // payment session (shared by both paths)
  sessionId?: string;
  payment?: PaymentObject;
  clarifications?: ClarificationField[];
  transactionId?: string;
  originGroupChatId?: number; // group this payment was triggered from (for the public "paid" post)
};

const userState = new Map<number, UserState>();

function getState(userId: number): UserState {
  let state = userState.get(userId);
  if (!state) {
    state = { step: "idle" };
    userState.set(userId, state);
  }
  return state;
}

function isRegistrationStep(step: UserStep): boolean {
  return step === "awaiting_contact" || step === "awaiting_wallet_address";
}

function clearPaymentSession(state: UserState): void {
  delete state.recipientType;
  delete state.manualRecipient;
  delete state.manualAmount;
  delete state.sessionId;
  delete state.payment;
  delete state.clarifications;
  delete state.transactionId;
  delete state.originGroupChatId;
}

// A display handle for a Telegram user: a real @mention if they have a username,
// otherwise just their first name.
function mention(from: any): string {
  return from?.username ? `@${from.username}` : (from?.first_name ?? "there");
}

// Deep link that opens the bot's DM and fires `/start join_<groupId>`.
function deepLink(groupId: string): string {
  const botUsername = process.env.BOT_USERNAME ?? "";
  return `https://t.me/${botUsername}?start=join_${groupId}`;
}

function setupButton(groupId: string, text = "▶ Set me up") {
  return { inline_keyboard: [[{ text, url: deepLink(groupId) }]] };
}

function paymentContext(ctx: any): ChatContext {
  return { chatId: ctx.chat?.id, chatType: ctx.chat?.type };
}

async function isRegistered(userId: number): Promise<boolean> {
  try {
    return (await checkUser({ telegramUserId: userId })).registered;
  } catch (error) {
    console.error("checkUser failed", error);
    return false; // fail open to registration rather than blocking the user
  }
}

// Generic "send a message" — either a reply in the current chat, or a DM to a
// specific user. Lets the same render logic deliver to a group OR a private chat.
type Send = (text: string, other?: any) => Promise<any>;
const replySend = (ctx: any): Send => (t, o) => ctx.reply(t, o);
const dmSend = (ctx: any, chatId: number): Send => (t, o) => ctx.api.sendMessage(chatId, t, o);

function formatPayment(p: PaymentObject): string {
  const lines = [
    "Please confirm this payment:",
    "",
    `💸 Amount:    ${p.amountDisplay} ${p.currency}`,
    `👤 Recipient: ${p.recipientDisplay}`,
  ];
  if (p.recipientWallet) lines.push(`🔗 Wallet:    ${p.recipientWallet}`);
  if (p.note) lines.push(`📝 Note:      ${p.note}`);
  return lines.join("\n");
}

const confirmKeyboard = {
  inline_keyboard: [
    [
      { text: "✅ Confirm", callback_data: "confirm_payment" },
      { text: "❌ Cancel", callback_data: "cancel_payment" },
    ],
  ],
};

const recipientTypeKeyboard = {
  inline_keyboard: [
    [
      { text: "📱 Phone", callback_data: "recip_phone" },
      { text: "💬 Username", callback_data: "recip_username" },
      { text: "🏦 Wallet", callback_data: "recip_wallet" },
    ],
  ],
};

const payTypeKeyboard = {
  inline_keyboard: [
    [{ text: "💸 Send exact amount (fixed send)", callback_data: "paytype_send" }],
    [{ text: "🎯 Recipient gets exact amount (fixed receive)", callback_data: "paytype_receive" }],
  ],
};

// Send the user's text to the NL parser and render whatever comes back via `send`.
async function runPlainText(
  ctx: any,
  state: UserState,
  userId: number,
  text: string,
  context: ChatContext,
  send: Send
): Promise<void> {
  let result: ParseResult;
  try {
    result = await processPlainText({
      telegramUserId: userId,
      text,
      context,
      telegramMessage: ctx.message
    });

    if (result.status === "error" && (result.reason.includes("📊") || result.reason.includes("👥") || result.reason.includes("ℹ️"))) {
      const targetChatId = state.originGroupChatId || ctx.chat?.id;

      // FIXED: Explicitly passing parse_mode: 'HTML' to the Telegram API [1]
      await ctx.api.sendMessage(targetChatId, result.reason, { parse_mode: 'HTML' });

      clearPaymentSession(state);
      state.step = "idle";
      return; // Exit early so no DM is sent! [1]
    }

    if (state.originGroupChatId && ctx.chat?.type !== 'private') {
      await ctx.reply(`📩 ${mention(ctx.from)}, I've sent you a DM to confirm this payment.`);
    }
    // Standard payment flows continue to render normally
    await renderParseResult(state, send, result);
  } catch (error) {
    console.error("processPlainText failed", error);
    await send("I couldn't reach the payment service. Please try again in a moment.");
    return;
  }
}


async function renderParseResult(state: UserState, send: Send, result: ParseResult): Promise<void> {
  if (result.status === "error") {
    clearPaymentSession(state);
    state.step = "idle";

    // Check if it is a formatted card (Balance Check or Splitwise card) [1]
    if (result.reason.includes("📊") || result.reason.includes("ℹ️") || result.reason.includes("👥")) {
      // FIXED: Passing parse_mode: 'HTML' to the custom send wrapper [1]
      await send(result.reason, { parse_mode: 'HTML' });
    } else {
      // FIXED: Passing parse_mode: 'HTML' to the fallback error template [1]
      await send(`I couldn't read that: ${result.reason}\n\nTry rephrasing your payment.`, { parse_mode: 'HTML' });
    }
    return;
  }


  state.sessionId = result.sessionId;

  if (result.status === "needs_clarification") {
    state.clarifications = result.clarifications;
    state.step = "awaiting_clarification";
    const next = result.clarifications[0];
    // Reset any half-built manual fields; each pathway repopulates what it knows.
    delete state.recipientType;
    delete state.manualRecipient;
    delete state.manualAmount;

    // Intent: the AI couldn't tell what the user wants → offer actions as buttons.
    if (next?.field === "intent") {
      await send(next?.question ?? "What would you like to do?", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💸 Make a payment", callback_data: "clarify_pay" }],
            [{ text: "💰 Check balance", callback_data: "clarify_balance" }],
            [{ text: "✖️ Never mind", callback_data: "cancel_payment" }],
          ],
        },
      });
      return;
    }

    // Currency mismatch: the stated currency matches neither wallet. Offer the two
    // wallet currencies as inline buttons — sender's currency → fixed-send, the
    // recipient's → fixed-receive. Stash wallet + amount so the tap can rebuild.
    if (next?.field === "currency" && result.payment?.recipientWallet) {
      const sugg = next.suggestions ?? [];
      state.recipientType = "wallet";
      state.manualRecipient = result.payment.recipientWallet;
      state.manualAmount = result.payment.amountDisplay;
      // One option when both wallets share a currency, two when they differ.
      const rows =
        sugg.length === 1
          ? [[{ text: `✅ Pay in ${sugg[0]}`, callback_data: "currency_send" }]]
          : [
              [{ text: `💸 Send in ${sugg[0]}`, callback_data: "currency_send" }],
              [{ text: `🎯 They receive ${sugg[1]}`, callback_data: "currency_receive" }],
            ];
      rows.push([{ text: "❌ Cancel", callback_data: "cancel_payment" }]);
      await send(next.question ?? "Which currency should I use?", {
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    // Amount: recipient known, amount missing → remember the wallet, ask the number.
    if (next?.field === "amount" && result.payment?.recipientWallet) {
      state.recipientType = "wallet";
      state.manualRecipient = result.payment.recipientWallet;
      await send(next?.question ?? "How much? (numbers only, e.g. 50)", {
        reply_markup: { force_reply: true },
      });
      return;
    }

    // Recipient (default): amount may be known; ask who, offering roster suggestions.
    if (result.payment?.amountDisplay) state.manualAmount = result.payment.amountDisplay;
    const reply_markup = next?.suggestions?.length
      ? { keyboard: next.suggestions.map((s) => [{ text: s }]), resize_keyboard: true, one_time_keyboard: true }
      : { force_reply: true };
    await send(next?.question ?? "Who would you like to pay?", { reply_markup });
    return;
  }

  // status === "ok"
  state.payment = result.payment;
  state.clarifications = undefined;
  state.step = "awaiting_confirmation";
  await send(formatPayment(result.payment), { reply_markup: confirmKeyboard });
}

// Finish a clarification by handing the resolved recipient + amount to the
// existing buildPayment route, then render its Confirm / Cancel card.
async function completeViaBuild(
  ctx: any,
  state: UserState,
  userId: number,
  recipient: { type: RecipientType; value: string },
  amount: string,
): Promise<void> {
  let result: ParseResult;
  try {
    result = await buildPayment({ telegramUserId: userId, recipient, amount, paymentType: "FIXED_SEND" });
  } catch (error) {
    console.error("buildPayment (clarify) failed", error);
    await ctx.reply("Couldn't build the payment. Please try again.");
    return;
  }
  await renderParseResult(state, replySend(ctx), result);
}

// Manual builder: recipient captured (typed or shared) → ask for the amount.
async function captureManualRecipient(ctx: any, state: UserState, value: string): Promise<void> {
  state.manualRecipient = value.trim();
  state.step = "awaiting_manual_amount";
  await ctx.reply("💸 How much? Enter the amount (numbers only, e.g. 50 or 50.00):", {
    reply_markup: { force_reply: true },
  });
}

// ── Bot added to / removed from a group ──────────────────────────────────────
export async function handleChatMemberUpdate(ctx: any): Promise<void> {
  const update = ctx.myChatMember;
  if (!update) return;
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  const chatType = ctx.chat?.type;

  const joined =
    (newStatus === "member" || newStatus === "administrator") &&
    (oldStatus === "left" || oldStatus === "kicked" || !oldStatus);

  if (joined && (chatType === "group" || chatType === "supergroup")) {
    const groupId = String(ctx.chat.id);
    await ctx.reply(
      "Hi, I'm the IOU Bot 👋\n\n" +
        "I let this group send money to each other.\n" +
        "Tap below to join this group's money pool, or set up a new account first.",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Join money group", callback_data: "join_money_group" }],
            [{ text: "✨ Sign me up", url: deepLink(groupId) }],
          ],
        },
      }
    );
  }
}

export async function handleBotMessage(ctx: any): Promise<void> {
  const msg = ctx.message as any;
  if (!msg) return;
  console.log("[message]", JSON.stringify(msg, null, 2));

  const userId = ctx.from?.id as number | undefined;
  if (!userId) return;

  const isPrivate = ctx.chat?.type === "private";
  const state = getState(userId);

  // Shared contact card. Used for registration (the user's own number) and for
  // the manual builder's phone recipient (someone else's, via attachment menu).
  if (msg.contact) {
    if (state.step === "awaiting_contact") {
      state.contact = msg.contact.phone_number;
      state.step = "awaiting_wallet_address";
      await ctx.reply("🏦 What is your wallet address (or $payment pointer)?", {
        reply_markup: { remove_keyboard: true },
      });
    } else if (state.step === "awaiting_manual_recipient" && state.recipientType === "phone") {
      await captureManualRecipient(ctx, state, msg.contact.phone_number);
    }
    return;
  }

  if (!msg.text) return;
  const text = msg.text.trim();

  // Commands. In groups commands arrive as "/iou@BotUsername" — strip the suffix.
  const entities = msg.entities ?? [];
  const commandEntity = entities.find((e: any) => e.type === "bot_command");
  const rawCommand = commandEntity
    ? text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length)
    : "";
  const command = rawCommand.split("@")[0];
  const afterCommand = commandEntity
    ? text.slice(commandEntity.offset + commandEntity.length).trim()
    : "";

  if (command === "/start") {
    const payload = afterCommand;

    if (payload.startsWith("pay_")) {
      // 1. Split the payload by underscores to get both amount and recipient [1]
      const parts = payload.slice("pay_".length).split("_");
      const amount = parts[0];
      const recipient = parts.slice(1).join("_");

      clearPaymentSession(state);
      state.manualAmount = amount;

      if (recipient) {
        const recipientType = recipient.match(/^\d+$/) ? "phone" : "username";
        const manualRecipient = recipient.match(/^\d+$/) ? recipient : `@${recipient}`;

        // 1. Alert them that we are preparing the card
        await ctx.reply(`⏳ Preparing your payment of ${amount} ZAR to ${manualRecipient}...`);

        // 2. Automatically call buildPayment in the background! [1]
        let result: ParseResult;
        try {
          result = await buildPayment({
            telegramUserId: userId,
            recipient: { type: recipientType, value: manualRecipient },
            amount: amount,
            paymentType: "FIXED_SEND", // Default to FIXED_SEND (backend resolves currency dynamically) [1]
          });
        } catch (error) {
          console.error("buildPayment failed", error);
          await ctx.reply("Couldn't prepare the payment. Please try again.");
          return;
        }

        // 3. Immediately show the final "Confirm / Cancel" card [1]
        await renderParseResult(state, replySend(ctx), result);
        return;
      }

      // Fallback: If no recipient was specified, ask for their identity type as normal [1]
      state.step = "awaiting_manual_recipient_type";
      await ctx.reply("👤 Who are you paying? Choose how to identify them:", {
        reply_markup: recipientTypeKeyboard,
      });
      return;
    }

    const groupId = payload.startsWith("join_") ? payload.slice("join_".length) : undefined;

    if (await isRegistered(userId)) {
      if (groupId) {
        try {
          await joinGroup({ telegramUserId: userId, telegramUsername: ctx.from?.username, groupTelegramId: groupId });
          await ctx.reply("✅ You're set up and now part of that money group. Just tell me what to pay.");
        } catch (error) {
          console.error("joinGroup failed", error);
          await ctx.reply("You're registered, but I couldn't add you to the group. Try /join again in the group.");
        }
      } else {
        await ctx.reply("You're already set up! Send /pay, or just tell me what you'd like to pay.");
      }
      return;
    }

    userState.set(userId, { step: "awaiting_contact", pendingGroupId: groupId });
    await ctx.reply("Welcome to IOU!\n📱 Share your contact so we can register you.", {
      reply_markup: {
        keyboard: [[{ text: "📱 Share My Number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }

  // /join — only meaningful inside a group.
  if (command === "/join") {
    if (isPrivate) {
      await ctx.reply("Use /join inside a money group to join it.");
      return;
    }
    const groupId = String(ctx.chat.id);
    if (await isRegistered(userId)) {
      try {
        await joinGroup({ telegramUserId: userId, telegramUsername: ctx.from?.username, groupTelegramId: groupId });
        await ctx.reply(`✅ ${mention(ctx.from)} joined the money group. Others can now pay you.`);
      } catch (error) {
        console.error("joinGroup failed", error);
        await ctx.reply("Couldn't add you right now — please try /join again in a moment.");
      }
    } else {
      await ctx.reply(`${mention(ctx.from)}, tap below to set up your wallet — then you'll be added to this group.`, {
        reply_markup: setupButton(groupId),
      });
    }
    return;
  }

  // /iou <text> — explicit NL payment trigger (DMs and groups).
  if (command === "/iou") {
    if (isRegistrationStep(state.step)) {
      await ctx.reply("Finish setting up your account first. Send /start to begin.");
      return;
    }

    // ── In a group: gate the sender, bounce the flow into their DM ──
    if (!isPrivate) {
      if (!afterCommand) {
        await ctx.reply("Usage: /iou pay 50 to @alice");
        return;
      }
      const groupId = String(ctx.chat.id);
      if (!(await isRegistered(userId))) {
        await ctx.reply(`${mention(ctx.from)}, set up your wallet first 👇`, { reply_markup: setupButton(groupId) });
        return;
      }
      clearPaymentSession(state);
      state.step = "idle";
      state.originGroupChatId = ctx.chat.id;
      try {
        await runPlainText(ctx, state, userId, afterCommand, paymentContext(ctx), dmSend(ctx, userId));
      } catch (error) {
        console.error("group /iou DM bounce failed", error);
        await ctx.reply(`${mention(ctx.from)}, I couldn't message you — open a chat with me first 👇`, {
          reply_markup: setupButton(groupId),
        });
      }
      return;
    }

    // ── In a DM ──
    clearPaymentSession(state);
    state.step = "idle";
    if (!afterCommand) {
      await ctx.reply(
        'Tell me what you\'d like to pay — e.g. "pay 50 to @alice". You can write in any language.',
        { reply_markup: { force_reply: true } }
      );
      return;
    }
    await runPlainText(ctx, state, userId, afterCommand, paymentContext(ctx), replySend(ctx));
    return;
  }

  if (command === "/pay") {
    if (!isPrivate) {
      await ctx.reply("Open a DM with me to use /pay, or use /iou pay … here in the group.");
      return;
    }
    if (isRegistrationStep(state.step)) {
      await ctx.reply("Finish setting up your account first. Send /start to begin.");
      return;
    }
    clearPaymentSession(state);
    state.step = "idle";
    await ctx.reply(
      'Tell me what you\'d like to do — e.g. "pay 50 to @alice" (any language) — or enter the details step by step.',
      { reply_markup: { inline_keyboard: [[{ text: "🧮 Enter details manually", callback_data: "manual_payment" }]] } }
    );
    return;
  }

  if (command) {
    if (isPrivate) await ctx.reply(`Unknown command: ${command}`);
    return;
  }

  // Non-command text. In groups the bot ignores chatter (payments need /iou).
  if (!isPrivate) return;

  // ── DM, dispatch on the current step ──
  switch (state.step) {
    // ── Registration ────────────────────────────────────────────────────────
    case "awaiting_contact": {
      // User typed a number instead of sharing the contact card
      state.contact = text;
      state.step = "awaiting_wallet_address";
      await ctx.reply("🏦 What is your wallet address (or $payment pointer)?", {
        reply_markup: { force_reply: true },
      });
      return;
    }

    case "awaiting_wallet_address": {
      state.walletAddress = text;

      // The wallet address is the last thing we need — payments are run by the
      // custodial client wallet, so there's no key or password to collect.
      try {
        await processRegistration({
          telegramUserId: userId,
          telegramUsername: ctx.from?.username,
          phoneNumber: state.contact ?? "",
          walletAddress: state.walletAddress ?? "",
        });
      } catch (error) {
        console.error("processRegistration failed", error);
        await ctx.reply("Registration failed. Please try /start again.");
        userState.delete(userId);
        return;
      }

      // If they arrived via a group deep link, enrol them in that group now.
      let joinedGroup = false;
      if (state.pendingGroupId) {
        try {
          await joinGroup({
            telegramUserId: userId,
            telegramUsername: ctx.from?.username,
            groupTelegramId: state.pendingGroupId,
          });
          joinedGroup = true;
        } catch (error) {
          console.error("joinGroup after registration failed", error);
        }
        delete state.pendingGroupId;
      }

      state.step = "idle";
      await ctx.reply(
        (joinedGroup
          ? "✅ You're all set and added to your money group!\n\n"
          : "✅ You're all set!\n\n") +
          'Just tell me what you\'d like to pay — e.g. "send R50 to Noah" — in any language.',
        { reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── Manual payment builder ──────────────────────────────────────────────
    case "awaiting_manual_recipient_type": {
      await ctx.reply("Tap one of the buttons above to choose how to identify the recipient.");
      return;
    }

    case "awaiting_manual_recipient": {
      if (!text) {
        await ctx.reply("Please send the recipient's details.");
        return;
      }
      await captureManualRecipient(ctx, state, text);
      return;
    }

    case "awaiting_manual_amount": {
      if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
        await ctx.reply("Please enter a positive number, e.g. 50 or 50.00.", {
          reply_markup: { force_reply: true },
        });
        return;
      }
      state.manualAmount = text;
      state.step = "awaiting_manual_paytype";
      await ctx.reply("How should the amount be applied?", { reply_markup: payTypeKeyboard });
      return;
    }

    case "awaiting_manual_paytype": {
      await ctx.reply("Choose fixed send or fixed receive using the buttons above.");
      return;
    }

    // ── Payment (shared tail) ───────────────────────────────────────────────
    case "awaiting_clarification": {
      const field = state.clarifications?.[0]?.field ?? "unknown";

      // Button-driven pathways — ignore stray text, nudge to the buttons.
      if (field === "currency") {
        await ctx.reply("Please tap one of the currency buttons above.");
        return;
      }
      if (field === "intent") {
        await ctx.reply("Please tap one of the buttons above.");
        return;
      }

      // Amount answer: validate, then complete with the remembered recipient.
      if (field === "amount") {
        if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
          await ctx.reply("Please enter a positive number, e.g. 50 or 50.00.", {
            reply_markup: { force_reply: true },
          });
          return;
        }
        if (!state.manualRecipient || !state.recipientType) {
          clearPaymentSession(state);
          state.step = "idle";
          await ctx.reply("Let's start over — tell me what you'd like to pay.");
          return;
        }
        await completeViaBuild(ctx, state, userId, { type: state.recipientType, value: state.manualRecipient }, text);
        return;
      }

      // Recipient answer (typed or tapped): infer how they're identified.
      const value = text.trim();
      const type: RecipientType = /^\+?\d[\d\s-]*$/.test(value)
        ? "phone"
        : value.startsWith("http") || value.startsWith("$")
          ? "wallet"
          : "username";
      if (!state.manualAmount) {
        // No amount yet either → hand off to the manual amount step.
        state.recipientType = type;
        state.manualRecipient = value;
        state.step = "awaiting_manual_amount";
        await ctx.reply("💸 How much? (numbers only, e.g. 50):", { reply_markup: { force_reply: true } });
        return;
      }
      await completeViaBuild(ctx, state, userId, { type, value }, state.manualAmount);
      return;
    }

    case "awaiting_confirmation":
      await ctx.reply("Use the Confirm or Cancel buttons above.");
      return;

    case "awaiting_approval":
      await ctx.reply('Approve in your wallet, then tap "✅ I\'ve approved".');
      return;

    // ── Idle: in a DM, any plain text is a payment instruction ──────────────
    case "idle":
    default: {
      await runPlainText(ctx, state, userId, text, paymentContext(ctx), replySend(ctx));
      return;
    }
  }
}

export async function handleCallbackQuery(ctx: any): Promise<void> {
  const callbackData = ctx.callbackQuery?.data as string | undefined;
  const userId = ctx.from?.id as number | undefined;
  if (!callbackData || !userId) return;

  if (callbackData === "join_money_group") {
    const groupId = String(ctx.chat?.id ?? "");
    if (!groupId) {
      await ctx.answerCallbackQuery("Couldn't identify the group. Please try again.");
      return;
    }
    if (!(await isRegistered(userId))) {
      await ctx.answerCallbackQuery("You need to register first!");
      await ctx.reply(
        `${mention(ctx.from)}, you need to set up an account before joining the money group. Tap below to get started.`,
        { reply_markup: { inline_keyboard: [[{ text: "✨ Sign me up", url: deepLink(groupId) }]] } }
      );
      return;
    }
    try {
      await joinGroup({ telegramUserId: userId, telegramUsername: ctx.from?.username, groupTelegramId: groupId });
      await ctx.answerCallbackQuery("You're in!");
      await ctx.reply(`✅ ${mention(ctx.from)} joined the money group!`);
    } catch (error) {
      console.error("joinGroup failed", error);
      await ctx.answerCallbackQuery("Couldn't add you right now — please try again.");
    }
    return;
  }

  const state = userState.get(userId);
  if (!state) {
    await ctx.answerCallbackQuery("Session expired — send /pay to start over.");
    return;
  }

  if (callbackData === "cancel_payment") {
    clearPaymentSession(state);
    state.step = "idle";
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.reply("Payment cancelled. Send a new instruction whenever you're ready.");
    return;
  }

  // Intent clarification: route the chosen action.
  if (callbackData === "clarify_pay") {
    clearPaymentSession(state);
    state.step = "idle";
    await ctx.answerCallbackQuery();
    await ctx.reply('Tell me what you\'d like to pay — e.g. "pay 50 to @alice".', {
      reply_markup: { force_reply: true },
    });
    return;
  }
  if (callbackData === "clarify_balance") {
    await ctx.answerCallbackQuery();
    await ctx.reply("💰 Balance checking isn't available yet — coming soon!");
    return;
  }

  // Currency clarification choice → fixed-send (sender's currency) or
  // fixed-receive (recipient's). buildPayment derives the currency from the type.
  if (callbackData === "currency_send" || callbackData === "currency_receive") {
    if (state.step !== "awaiting_clarification" || !state.manualRecipient || !state.manualAmount) {
      await ctx.answerCallbackQuery("Start again with /pay.");
      return;
    }
    await ctx.answerCallbackQuery();
    const paymentType = callbackData === "currency_send" ? "FIXED_SEND" : "FIXED_RECEIVE";
    let result: ParseResult;
    try {
      result = await buildPayment({
        telegramUserId: userId,
        recipient: { type: "wallet", value: state.manualRecipient },
        amount: state.manualAmount,
        paymentType,
      });
    } catch (error) {
      console.error("buildPayment (currency) failed", error);
      await ctx.reply("Couldn't build the payment. Please try again.");
      return;
    }
    await renderParseResult(state, replySend(ctx), result);
    return;
  }

  // ── Manual builder entry + steps ──────────────────────────────────────────
  if (callbackData === "manual_payment") {
    if (isRegistrationStep(state.step)) {
      await ctx.answerCallbackQuery("Finish setup first — send /start.");
      return;
    }
    clearPaymentSession(state);
    state.step = "awaiting_manual_recipient_type";
    await ctx.answerCallbackQuery();
    await ctx.reply("👤 Who are you paying? Choose how to identify them:", {
      reply_markup: recipientTypeKeyboard,
    });
    return;
  }

  if (callbackData === "recip_phone" || callbackData === "recip_username" || callbackData === "recip_wallet") {
    if (state.step !== "awaiting_manual_recipient_type") {
      await ctx.answerCallbackQuery("Start again with /pay.");
      return;
    }
    state.recipientType =
      callbackData === "recip_phone" ? "phone" : callbackData === "recip_username" ? "username" : "wallet";
    state.step = "awaiting_manual_recipient";
    await ctx.answerCallbackQuery();
    const prompt =
      state.recipientType === "phone"
        ? "📱 Enter the recipient's phone number (or share their contact card):"
        : state.recipientType === "username"
          ? "💬 Enter the recipient's Telegram @username:"
          : "🏦 Paste the recipient's wallet address or $payment pointer:";
    await ctx.reply(prompt, { reply_markup: { force_reply: true } });
    return;
  }

  if (callbackData === "paytype_send" || callbackData === "paytype_receive") {
    if (
      state.step !== "awaiting_manual_paytype" ||
      !state.recipientType ||
      !state.manualRecipient ||
      !state.manualAmount
    ) {
      await ctx.answerCallbackQuery("Start again with /pay.");
      return;
    }
    await ctx.answerCallbackQuery();
    const paymentType = callbackData === "paytype_send" ? "FIXED_SEND" : "FIXED_RECEIVE";
    let result: ParseResult;
    try {
      result = await buildPayment({
        telegramUserId: userId,
        recipient: { type: state.recipientType, value: state.manualRecipient },
        amount: state.manualAmount,
        paymentType,
      });
    } catch (error) {
      console.error("buildPayment failed", error);
      await ctx.reply("Couldn't build the payment. Please try /pay again.");
      return;
    }
    await renderParseResult(state, replySend(ctx), result);
    return;
  }

  // ── Shared payment tail ───────────────────────────────────────────────────
  if (callbackData === "confirm_payment") {
    if (state.step !== "awaiting_confirmation" || !state.sessionId) {
      await ctx.answerCallbackQuery("Nothing to confirm.");
      return;
    }
    try {
      await confirmPayment({ telegramUserId: userId, sessionId: state.sessionId });
    } catch (error) {
      console.error("confirmPayment failed", error);
      await ctx.answerCallbackQuery("Failed");
      await ctx.reply("Couldn't confirm the payment. Please try again.");
      return;
    }

    // No password needed — the custodial client wallet authorizes the payment and
    // hands back the wallet approval link for the sender to grant.
    let auth: { interactUrl: string; transactionId: string };
    try {
      auth = await authorizePayment({ telegramUserId: userId, sessionId: state.sessionId });
    } catch (error) {
      console.error("authorizePayment failed", error);
      state.step = "awaiting_confirmation";
      await ctx.answerCallbackQuery("Failed");
      await ctx.reply("Couldn't start the payment. Confirm again to retry.", {
        reply_markup: confirmKeyboard,
      });
      return;
    }

    state.transactionId = auth.transactionId;
    state.step = "awaiting_approval";
    await ctx.answerCallbackQuery("Confirmed");
    await ctx.reply("Almost there — approve the payment in your wallet, then tap the button below.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔐 Approve in wallet", url: auth.interactUrl }],
          [{ text: "✅ I've approved", callback_data: "approved_payment" }],
          [{ text: "❌ Cancel", callback_data: "cancel_payment" }],
        ],
      },
    });
    return;
  }

  if (callbackData === "approved_payment") {
    if (state.step !== "awaiting_approval" || !state.transactionId) {
      await ctx.answerCallbackQuery("Nothing to finalize.");
      return;
    }
    await ctx.answerCallbackQuery("Checking…");
    let outcome: { status: "COMPLETED" | "FAILED"; detail?: string };
    try {
      outcome = await finalizePayment({ telegramUserId: userId, transactionId: state.transactionId });
    } catch (error) {
      console.error("finalizePayment failed", error);
      await ctx.reply('Couldn\'t finalize yet. If you\'ve approved in your wallet, tap "✅ I\'ve approved" again.');
      return;
    }

    // Capture before clearing — needed for the public group announcement.
    const groupId = state.originGroupChatId;
    const payment = state.payment;
    const payer = mention(ctx.from);

    clearPaymentSession(state);
    state.step = "idle";

    if (outcome.status === "COMPLETED") {
      await ctx.reply("✅ Payment sent successfully!");
      if (groupId && payment) {
        try {
          await ctx.api.sendMessage(
            groupId,
            `💸 ${payer} paid ${payment.recipientDisplay} ${payment.amountDisplay} ${payment.currency} ✅`
          );
        } catch (error) {
          console.error("group announcement failed", error);
        }
      }
    } else {
      await ctx.reply(`❌ Payment failed${outcome.detail ? `: ${outcome.detail}` : ""}. Send a new instruction to try again.`);
    }
    return;
  }
}

export async function handleInlineQuery(ctx: any): Promise<void> {
  const query = ctx.inlineQuery?.query?.trim() as string | undefined;
  if (!query) return;

  // Split query by spaces (e.g. "@ksrnoa 50" or "50")
  const parts = query.split(/\s+/);

  let recipient = "";
  let amountStr = "";

  if (parts.length >= 2) {
    recipient = parts[0]; // e.g., "@ksrnoa" [1]
    amountStr = parts[1]; // e.g., "50"
  } else {
    amountStr = parts[0]; // e.g., "50"
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) return;

  const botUsername = process.env.BOT_USERNAME || 'open_payments_iou_bot';

  // Format the deep-link payload: remove '@' or special symbols for deep-link compatibility [1]
  const cleanRecipient = recipient.replace(/[^a-zA-Z0-9_]/g, "");
  const startPayload = cleanRecipient ? `pay_${amount}_${cleanRecipient}` : `pay_${amount}`; // e.g. "pay_50_ksrnoa" [1]

  await ctx.answerInlineQuery([
    {
      type: "article",
      id: `pay_${amount}_${Date.now()}`,
      title: recipient ? `💸 Send ${amount.toFixed(2)} ZAR to ${recipient}` : `💸 Send ${amount.toFixed(2)} ZAR`,
      description: recipient
          ? `Instant R${amount.toFixed(2)} payment card to ${recipient}.`
          : `Send a payment card for ${amount.toFixed(2)} ZAR.`,
      input_message_content: {
        message_text: recipient
            ? `💸 <b>Payment request to ${recipient}</b>\n\n<b>Amount:</b> ${amount.toFixed(2)} ZAR\n\nTap below to securely authorize and execute this payment.`
            : `💸 <b>Payment request</b>\n\n<b>Amount:</b> ${amount.toFixed(2)} ZAR\n\nTap below to securely authorize and execute this payment.`,
        parse_mode: "HTML"
      },
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔐 Authorize & Pay", url: `https://t.me/${botUsername}?start=${startPayload}` }]
        ]
      }
    }
  ]);
}
