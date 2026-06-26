import {
  authorizePayment,
  buildPayment,
  checkUser,
  clarifyPayment,
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
// Registration:   awaiting_contact → awaiting_wallet_address → awaiting_wallet_key
//                 → awaiting_password_setup → idle   (always happens in a DM)
//
// Groups ("money groups"):
//   • bot added → posts a welcome telling people to /join
//   • /join     → registered users are enrolled in the roster; others get a
//                 deep-link button that opens a DM and runs /start (carrying the
//                 group id, so they're enrolled once setup finishes).
//   • /iou … in a group is a TRIGGER: the bot resolves the sender, parses with
//     group context, then bounces the whole confirm → password → approve tail
//     into the sender's DM. On success it announces the payment back in the group.
//
// Payment tail (DM): ParseResult ──(clarify loop)──► awaiting_confirmation
//   ──Confirm──► confirmPayment → awaiting_payment_password ──password──►
//   authorizePayment → awaiting_approval ──"I've approved"──► finalizePayment → idle
// ─────────────────────────────────────────────────────────────────────────────

type UserStep =
  | "awaiting_contact"
  | "awaiting_wallet_address"
  | "awaiting_wallet_key"
  | "awaiting_password_setup"
  | "idle"
  | "awaiting_manual_recipient_type"
  | "awaiting_manual_recipient"
  | "awaiting_manual_amount"
  | "awaiting_manual_paytype"
  | "awaiting_clarification"
  | "awaiting_confirmation"
  | "awaiting_payment_password"
  | "awaiting_approval";

type UserState = {
  step: UserStep;
  // registration
  contact?: string;
  walletAddress?: string;
  walletKey?: string;
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
  return (
    step === "awaiting_contact" ||
    step === "awaiting_wallet_address" ||
    step === "awaiting_wallet_key" ||
    step === "awaiting_password_setup"
  );
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
    result = await processPlainText({ telegramUserId: userId, text, context });
  } catch (error) {
    console.error("processPlainText failed", error);
    await send("I couldn't reach the payment service. Please try again in a moment.");
    return;
  }
  await renderParseResult(state, send, result);
}

// Render whatever the backend returned: either ask the next clarifying question,
// or show the finished payment object for Confirm / Cancel. Everything goes
// through `send`, so this works whether we're in a DM or bouncing into one.
async function renderParseResult(state: UserState, send: Send, result: ParseResult): Promise<void> {
  if (result.status === "error") {
    clearPaymentSession(state);
    state.step = "idle";
    await send(`I couldn't read that: ${result.reason}\n\nTry rephrasing your payment.`);
    return;
  }

  state.sessionId = result.sessionId;

  if (result.status === "needs_clarification") {
    state.clarifications = result.clarifications;
    state.step = "awaiting_clarification";
    const next = result.clarifications[0];
    const reply_markup = next?.suggestions?.length
      ? { keyboard: next.suggestions.map((s) => [{ text: s }]), resize_keyboard: true, one_time_keyboard: true }
      : { force_reply: true };
    await send(next?.question ?? "Could you clarify that?", { reply_markup });
    return;
  }

  // status === "ok"
  state.payment = result.payment;
  state.clarifications = undefined;
  state.step = "awaiting_confirmation";
  await send(formatPayment(result.payment), { reply_markup: confirmKeyboard });
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
    // Deep-link payload: "join_<groupId>" enrols the user in that group.
    const groupId = afterCommand.startsWith("join_") ? afterCommand.slice("join_".length) : undefined;

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
      await ctx.reply(`📩 ${mention(ctx.from)}, I've sent you a DM to confirm this payment.`);
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
      state.step = "awaiting_wallet_key";
      await ctx.reply("🔑 Paste your private wallet key:", { reply_markup: { force_reply: true } });
      return;
    }

    case "awaiting_wallet_key": {
      state.walletKey = text;
      state.step = "awaiting_password_setup";
      await ctx.reply("🔐 Create a password to secure your key (you'll enter it for each payment):", {
        reply_markup: { force_reply: true },
      });
      return;
    }

    case "awaiting_password_setup": {
      try {
        await processRegistration({
          telegramUserId: userId,
          telegramUsername: ctx.from?.username,
          phoneNumber: state.contact ?? "",
          walletAddress: state.walletAddress ?? "",
          privateKey: state.walletKey ?? "",
          password: text,
        });
      } catch (error) {
        console.error("processRegistration failed", error);
        await ctx.reply("Registration failed. Please try /start again.");
        userState.delete(userId);
        return;
      }
      delete state.walletKey; // don't keep the key in memory after registration

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
      let result: ParseResult;
      try {
        result = await clarifyPayment({
          telegramUserId: userId,
          sessionId: state.sessionId ?? "",
          field,
          answer: text,
        });
      } catch (error) {
        console.error("clarifyPayment failed", error);
        await ctx.reply("Something went wrong. Please try again.");
        return;
      }
      await renderParseResult(state, replySend(ctx), result);
      return;
    }

    case "awaiting_payment_password": {
      // Best-effort: remove the message so the password doesn't linger in the chat
      ctx.deleteMessage?.().catch(() => {});

      let auth: { interactUrl: string; transactionId: string };
      try {
        auth = await authorizePayment({
          telegramUserId: userId,
          sessionId: state.sessionId ?? "",
          password: text,
        });
      } catch (error) {
        console.error("authorizePayment failed", error);
        state.step = "awaiting_confirmation";
        await ctx.reply("Authorization failed (wrong password, or the payment couldn't start). Confirm again to retry.", {
          reply_markup: confirmKeyboard,
        });
        return;
      }

      state.transactionId = auth.transactionId;
      state.step = "awaiting_approval";
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
    state.step = "awaiting_payment_password";
    await ctx.answerCallbackQuery("Confirmed");
    await ctx.reply("🔐 Enter your password to authorize the payment:", {
      reply_markup: { force_reply: true },
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
