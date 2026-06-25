type RegistrationPayload = {
  telegramUserId: number;
  phoneNumber: string;
  walletKey: string;
  password: string;
};

type PlainTextPayload = {
  telegramUserId: number;
  text: string;
};

type PaymentDetailsPayload = {
  telegramUserId: number;
  text: string;
};

type ConfirmPaymentPayload = {
  telegramUserId: number;
  confirmationText: string;
};

const BACKEND_BASE_URL = process.env.BOT_BACKEND_URL ?? "http://localhost:3001";

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Backend call failed ${path}: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function processRegistration(payload: RegistrationPayload): Promise<void> {
  try {
    await postJson("/bot/processRegistration", payload);
  } catch (error) {
    console.error("processRegistration failed", error);
    throw error;
  }
}

export async function processPlainText(payload: PlainTextPayload): Promise<void> {
  try {
    await postJson("/bot/processPlainText", payload);
  } catch (error) {
    console.error("processPlainText failed", error);
    throw error;
  }
}

export async function validatePaymentDetails(payload: PaymentDetailsPayload): Promise<{ valid: boolean; reason?: string }> {
  try {
    return await postJson<{ valid: boolean; reason?: string }>("/bot/validatePaymentDetails", payload);
  } catch (error) {
    console.error("validatePaymentDetails failed", error);
    throw error;
  }
}

export async function confirmPayment(payload: ConfirmPaymentPayload): Promise<void> {
  try {
    await postJson("/bot/confirmPayment", payload);
  } catch (error) {
    console.error("confirmPayment failed", error);
    throw error;
  }
}
