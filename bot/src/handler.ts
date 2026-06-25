import {
  confirmPayment,
  processPlainText,
  processRegistration,
  validatePaymentDetails,
} from "./backendClient";

type UserStep =
  | "awaiting_contact"
  | "awaiting_wallet_key"
  | "awaiting_password"
  | "awaiting_payment_details"
  | "awaiting_payment_confirmation";

type UserState = {
  step: UserStep;
  contact?: string;
  walletKey?: string;
  password?: string;
  pendingPaymentText?: string;
};

const userState = new Map<number, UserState>();

export async function handleBotMessage(ctx: any): Promise<void> {
  const msg = ctx.message as any;
  if (!msg) return;

  const userId = ctx.from?.id as number | undefined;
  if (!userId) return;

  if (msg.contact) {
    const state = userState.get(userId);
    if (state?.step === "awaiting_contact") {
      state.contact = msg.contact.phone_number;
      state.step = "awaiting_wallet_key";
      userState.set(userId, state);

      await ctx.reply("🔑 What is your private wallet key?", {
        reply_markup: {
          force_reply: true,
        },
      });
    }
    return;
  }

  if (!msg.text) return;

  const text = msg.text.trim();
  const entities = msg.entities ?? [];
  const commandEntity = entities.find((entity: any) => entity.type === "bot_command");
  const command = commandEntity
    ? text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length)
    : "";

  if (command === "/start") {
    userState.set(userId, { step: "awaiting_contact" });
    await ctx.reply(
      "Welcome to IOU!\n📱 Please share your contact so we can register you for our platform.",
      {
        reply_markup: {
          keyboard: [[{ text: "📱 Share My Number", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
    return;
  }

  if (command === "/pay") {
    userState.set(userId, {
      ...(userState.get(userId) ?? { step: "awaiting_payment_details" as UserStep }),
      step: "awaiting_payment_details",
    });
    await ctx.reply("Send payment details in plain text (for example: 'pay 50 USD to @alice').", {
      reply_markup: {
        force_reply: true,
      },
    });
    return;
  }

  if (command) {
    await ctx.reply(`Unknown command: ${command}`);
    return;
  }

  const state = userState.get(userId);
  if (!state) {
    await ctx.reply("Type /start to begin or /pay to initiate a payment flow.");
    return;
  }

  switch (state.step) {
    case "awaiting_contact": {
      state.contact = text;
      state.step = "awaiting_wallet_key";
      userState.set(userId, state);

      await ctx.reply("🔑 What is your private wallet key?", {
        reply_markup: {
          force_reply: true,
        },
      });
      break;
    }

    case "awaiting_wallet_key": {
      state.walletKey = text;
      state.step = "awaiting_password";
      userState.set(userId, state);

      await ctx.reply("🔐 Create a password to secure your wallet key:", {
        reply_markup: {
          force_reply: true,
        },
      });
      break;
    }

    case "awaiting_password": {
      state.password = text;
      userState.set(userId, state);

      try {
        await processRegistration({
          telegramUserId: userId,
          phoneNumber: state.contact ?? "",
          walletKey: state.walletKey ?? "",
          password: state.password ?? "",
        });
      } catch (error) {
        console.error("processRegistration failed", error);
        await ctx.reply("Registration failed. Please try /start again.");
        userState.delete(userId);
        return;
      }

      await ctx.reply(
        "Setup complete.\n\nUse /pay when you're ready to validate and confirm a payment.",
        {
          reply_markup: {
            remove_keyboard: true,
          },
        }
      );
      break;
    }

    case "awaiting_payment_details": {
      try {
        await processPlainText({
          telegramUserId: userId,
          text,
        });
      } catch (error) {
        console.error("processPlainText failed", error);
        await ctx.reply("Could not parse payment details. Please try again.");
        return;
      }

      let validation: { valid: boolean; reason?: string };
      try {
        validation = await validatePaymentDetails({
          telegramUserId: userId,
          text,
        });
      } catch (error) {
        console.error("validatePaymentDetails failed", error);
        await ctx.reply("Validation failed. Please try again.");
        return;
      }

      if (!validation.valid) {
        await ctx.reply(`Payment details invalid: ${validation.reason ?? "unknown reason"}`);
        return;
      }

      state.pendingPaymentText = text;
      state.step = "awaiting_payment_confirmation";
      userState.set(userId, state);

      await ctx.reply("Payment details look valid. Confirm payment?", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Confirm", callback_data: "confirm_payment" },
              { text: "❌ Cancel", callback_data: "cancel_payment" },
            ],
          ],
        },
      });
      break;
    }

    case "awaiting_payment_confirmation": {
      await ctx.reply("Use the Confirm/Cancel buttons shown above.");
      break;
    }

    default:
      await ctx.reply("Type /start to begin again.");
      userState.delete(userId);
  }
}

export async function handleCallbackQuery(ctx: any): Promise<void> {
  const callbackData = ctx.callbackQuery?.data as string | undefined;
  const userId = ctx.from?.id as number | undefined;
  if (!callbackData || !userId) return;

  const state = userState.get(userId);
  if (!state) {
    await ctx.answerCallbackQuery("Session expired");
    return;
  }

  if (callbackData === "cancel_payment") {
    state.step = "awaiting_payment_details";
    delete state.pendingPaymentText;
    userState.set(userId, state);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.reply("Payment cancelled. Send new payment details to continue.");
    return;
  }

  if (callbackData === "confirm_payment") {
    try {
      await confirmPayment({
        telegramUserId: userId,
        confirmationText: state.pendingPaymentText ?? "",
      });
    } catch (error) {
      console.error("confirmPayment failed", error);
      await ctx.answerCallbackQuery("Failed");
      await ctx.reply("Payment confirmation failed. Please try /pay again.");
      state.step = "awaiting_payment_details";
      delete state.pendingPaymentText;
      userState.set(userId, state);
      return;
    }

    await ctx.answerCallbackQuery("Confirmed");
    await ctx.reply("Payment confirmed successfully.");
    state.step = "awaiting_payment_details";
    delete state.pendingPaymentText;
    userState.set(userId, state);
  }
}
