// ─────────────────────────────────────────────────────────────────────────────
// Backend contract ("leaky endpoints")
//
// The bot owns NONE of the intelligence below — it only shuttles data between
// Telegram and the backend. Every function here is a thin POST wrapper around an
// endpoint a teammate implements. The TYPES are the real contract: as long as the
// backend returns these shapes, the bot's conversation flow (handler.ts) works.
//
// Division of labour (confirmed with the team):
//   1. Bot sends the user's RAW text to the backend.
//   2. Backend: text → JSON, validates against the DB (recipient has an IOU
//      account, currency known, …), and constructs a PaymentObject.
//   3. Backend returns that object — plus, for anything it could not infer with
//      confidence, a list of `clarifications` the bot must ask the user.
//   4. Bot shows the object for confirmation / asks the clarifying questions.
//   5. On confirmation the Open Payments flow begins (authorize → approve link).
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_BASE_URL = process.env.BOT_BACKEND_URL ?? "http://localhost:3001";

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Backend call failed ${path}: ${response.status}`);
  }

  return (await response.json()) as T;
}

// ── Shared shapes ────────────────────────────────────────────────────────────

/** The payment the backend inferred from the user's text and validated against the DB. */
export type PaymentObject = {
  /** Human-readable amount, already formatted to the currency's scale, e.g. "50.00". */
  amountDisplay: string;
  /** ISO-ish currency / asset code, e.g. "USD", "ZAR". */
  currency: string;
  /** Friendly recipient label to show the user, e.g. "Alice (@alice)". */
  recipientDisplay: string;
  /** Resolved recipient wallet address, if the backend wants the bot to echo it. */
  recipientWallet?: string;
  /** Optional free-text note / reference the AI extracted. */
  note?: string;
};

/** One field the backend was NOT confident about and wants the user to clarify. */
export type ClarificationField = {
  /** Machine name of the uncertain field, e.g. "recipient" | "amount" | "currency". */
  field: string;
  /** The question to show the user verbatim, e.g. "Did you mean @alice or @alicia?". */
  question: string;
  /** Optional suggested answers; the bot can render these as quick-reply buttons. */
  suggestions?: string[];
};

/**
 * Response to processPlainText / clarifyPayment. The backend drives the loop:
 *   - "needs_clarification": ask the user, then call clarifyPayment with the answer.
 *   - "ok": the PaymentObject is complete — show it for Confirm / Cancel.
 *   - "error": nothing usable was parsed; show `reason` and let the user retry.
 * `sessionId` ties a multi-turn parse together so the backend keeps context.
 */
export type ParseResult =
  | { status: "ok"; sessionId: string; payment: PaymentObject }
  | {
      status: "needs_clarification";
      sessionId: string;
      payment?: Partial<PaymentObject>;
      clarifications: ClarificationField[];
    }
  | { status: "error"; reason: string };

// ── Endpoints ────────────────────────────────────────────────────────────────

export type RegistrationPayload = {
  telegramUserId: number;
  telegramUsername?: string;
  phoneNumber: string;
  walletAddress: string;
  privateKey: string;
  password: string;
};

/** POST /bot/processRegistration — encrypt the key with the password and store the user. */
export async function processRegistration(payload: RegistrationPayload): Promise<{ ok: true }> {
  return postJson("/bot/processRegistration", payload);
}

/** Where a message came from. In a group, the backend uses chatId to pull that
 *  group's roster (groupMembers) and hand it to the AI parser, so a plain first
 *  name like "jason" can be resolved to a registered member of THAT group. */
export type ChatContext = { chatId: number; chatType: string };

/** POST /bot/processPlainText — RAW text in, constructed PaymentObject (or clarifications) out.
 *  `context` lets the backend scope recipient resolution to the originating group. */
export async function processPlainText(payload: {
  telegramUserId: number;
  text: string;
  context?: ChatContext;
}): Promise<ParseResult> {
  return postJson<ParseResult>("/bot/processPlainText", payload);
}

/** POST /bot/checkUser — has this Telegram user finished registration (wallet set up)? */
export async function checkUser(payload: {
  telegramUserId: number;
}): Promise<{ registered: boolean }> {
  return postJson("/bot/checkUser", payload);
}

/** POST /bot/joinGroup — enrol a REGISTERED user in a group's roster (groupMembers).
 *  Only registered users are added, so they're always payable once on the roster. */
export async function joinGroup(payload: {
  telegramUserId: number;
  telegramUsername?: string;
  groupTelegramId: string;
}): Promise<{ ok: true }> {
  return postJson("/bot/joinGroup", payload);
}

/** How a recipient is identified in the manual builder. "wallet" = out-of-ecosystem. */
export type RecipientType = "phone" | "username" | "wallet";

/**
 * POST /bot/buildPayment — the manual (non-NL) path. The bot collected the
 * structured fields itself via the wizard, so there's no text to parse. The
 * backend still resolves the recipient (DB lookup for phone/username, raw
 * Open Payments wallet resolution for "wallet") and quotes it, returning the
 * SAME ParseResult shape as processPlainText — so the conversation rejoins the
 * normal clarify → confirm → authorize flow.
 */
export async function buildPayment(payload: {
  telegramUserId: number;
  recipient: { type: RecipientType; value: string };
  amount: string;
  paymentType: "FIXED_SEND" | "FIXED_RECEIVE";
}): Promise<ParseResult> {
  return postJson<ParseResult>("/bot/buildPayment", payload);
}

/** POST /bot/clarifyPayment — the user's answer to one uncertain field; backend re-parses. */
export async function clarifyPayment(payload: {
  telegramUserId: number;
  sessionId: string;
  field: string;
  answer: string;
}): Promise<ParseResult> {
  return postJson<ParseResult>("/bot/clarifyPayment", payload);
}

/** POST /bot/confirmPayment — user confirmed the interpretation is correct (no money yet). */
export async function confirmPayment(payload: {
  telegramUserId: number;
  sessionId: string;
}): Promise<{ ok: true }> {
  return postJson("/bot/confirmPayment", payload);
}

/**
 * POST /bot/authorizePayment — the Open Payments flow begins here.
 * The backend decrypts the user's key with `password`, runs the quote, requests
 * the interactive outgoing-payment grant, and returns the wallet approval link.
 */
export async function authorizePayment(payload: {
  telegramUserId: number;
  sessionId: string;
  password: string;
}): Promise<{ interactUrl: string; transactionId: string }> {
  return postJson("/bot/authorizePayment", payload);
}

/**
 * POST /bot/finalizePayment — called after the user approves in their wallet.
 * The backend continues the grant and creates the outgoing payment.
 */
export async function finalizePayment(payload: {
  telegramUserId: number;
  transactionId: string;
}): Promise<{ status: "COMPLETED" | "FAILED"; detail?: string }> {
  return postJson("/bot/finalizePayment", payload);
}
