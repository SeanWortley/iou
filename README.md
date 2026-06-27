# IOU — Conversational AI Bot on the Interledger Network

IOU is a native Telegram bot that brings social expense tracking (Splitwise-like utility) and secure peer-to-peer transfers directly into messaging chats, powered by **Open Payments (ILP)** and **Gemini Generative AI**.

Instead of downloading a separate app to track IOUs, split dinner bills, or settle debts, users can manage their entire social financial lifecycle natively inside their conversations.

---

## Key Features

*   **Zero-Password Onboarding:** Quick-start registration linking a Telegram profile directly to an Open Payments wallet pointer
*   **Group Bill Splitting (`GROUP_FUND`):** Split group expenses equally among active group members (e.g., `/iou split R240 dinner`) and record outstanding debts in SQLite
*   **Direct IOUs:** Record direct debts natively inside a group chat (e.g., `/iou I owe @seanwortley R50`)
*   **Live Balance & Debt Checks (`/balance`):** Display simulated wallet balances and outstanding debts dynamically in real-time.
*   **Frictionless Settle-Up (`/settle`):** The backend looks up the outstanding debt, generates an Open Payments checkout link for the exact amount, and clears the debt from SQLite upon successful transaction callback
*   **Inline Payment Shortcuts:** Initiate payments directly inside a private 1-1 conversation without the bot being a member of that chat (using Telegram's native Inline Queries: `@open_payments_iou_bot @ksrnoa 50`)
*   **Sequential Multi-Payments:** Process multiple payment intents (e.g., *pay Sean R50 and Danny R100*) sequentially via a queue to respect the cryptographic consent boundaries of individual receiver wallets
*   **Slang & Multi-lingual Parsing:** Powered by `gemini-2.5-flash` with structured outputs, allowing users to type commands naturally using South African languages and slang (isiXhosa, Zulu, Afrikaans, English, French)

---

## Architecture Overview

The project is structured as a TypeScript monorepo alongside a Python AI parsing microservice [1]:

```text
iou/
├── package.json               ← Workspace root config 
│
├── backend/
│   ├── src/
│   │   ├── index.ts           ← Express entry point 
│   │   ├── config.ts          ← Server environment configuration 
│   │   ├── db/
│   │   │   ├── schema.ts      ← Database tables (users, groupMembers, transactions, iouBalances) 
│   │   │   └── index.ts       ← Drizzle + SQLite connection 
│   │   ├── routes/
│   │   │   ├── bot.ts         ← Core endpoints (/checkUser, /processPlainText, /authorizePayment, etc.) [1]
│   │   │   └── callback.ts    ← Open Payments GNAP redirect callback handler 
│   │   └── lib/
│   │       └── openPayments.ts← Open Payments SDK client singleton 
│   └── drizzle.config.ts
│
├── bot/
│   ├── src/
│   │   ├── index.ts           ← Grammy Bot runner (handles webhook / long-polling)
│   │   ├── handler.ts         ← Conversation state machine & commands 
│   │   └── backendClient.ts   ← Strongly-typed fetch wrappers calling the backend 
│   └── .env
│
└── backend/src/Interpreter/
    └── parser.py              ← Python FastAPI AI server (Gemini structured intent parsing) [1]
```

---

## Developer Quick Start

To run the complete conversational payment loop locally without needing a public tunnel, you can run all three services locally using a **Tunnel-Free Localhost Setup**

### 1. Enable Inline Mode in BotFather (Required)
1. Search for `@BotFather` on Telegram and start a chat
2. Send the command **`/setinline`**, select your bot, and set a placeholder prompt (e.g., *"Enter the amount you want to pay..."*)

### 2. Configure the Backend
Create `backend/.env` [1]:
```env
PORT=3001
BACKEND_URL=http://127.0.0.1:3001
AI_SERVER_URL=http://127.0.0.1:8000/parse
OP_WALLET_ADDRESS=https://ilp.interledger-test.dev/joll
OP_KEY_ID=your-key-uuid
OP_PRIVATE_KEY_PATH=./private.key
TELEGRAM_BOT_TOKEN=
BOT_TOKEN=
BOT_USERNAME=
GEMINI_API_KEY=
```

Install backend dependencies and run SQLite migrations [1]:
```bash
cd backend
npm install
npm run db:push
```

### 3. Configure the Bot Client
Create `bot/.env` [1]:
```env
BOT_TOKEN=your-telegram-bot-token
BOT_BACKEND_URL=http://127.0.0.1:3001
```

Install bot dependencies [1]:
```bash
cd bot
npm install
```

---

## Running the Project (Platform-Specific Commands)

You will need **three terminal windows** open in parallel [1]. Choose the commands below that match your operating system:

### Terminal 1: The Python AI Server (FastAPI)

Navigate to the interpreter directory [1]:
```bash
cd backend/src/Interpreter
```

#### On Windows (PowerShell):
```powershell
# 1. Create and activate a virtual environment
python -m venv venv
.\venv\Scripts\Activate.ps1

# 2. Install Python dependencies
pip install fastapi uvicorn google-genai pydantic

# 3. Set your Gemini API Key
$env:GEMINI_API_KEY="AIzaSyYourApiKeyHere"

# 4. Start the FastAPI server on port 8000
uvicorn parser:app --port 8000
```

#### On Windows (Command Prompt - CMD):
```cmd
# 1. Create and activate a virtual environment
python -m venv venv
.\venv\Scripts\activate.bat

# 2. Install Python dependencies
pip install fastapi uvicorn google-genai pydantic

# 3. Set your Gemini API Key
set GEMINI_API_KEY=AIzaSyYourApiKeyHere

# 4. Start the FastAPI server on port 8000
uvicorn parser:app --port 8000
```

#### On macOS / 🐧 On Linux:
```bash
# Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
pip install fastapi uvicorn google-genai pydantic

# Set your Gemini API Key
export GEMINI_API_KEY="AIzaSyYourApiKeyHere"

# Start the FastAPI server on port 8000
uvicorn parser:app --port 8000
```

---

### Terminal 2: The Express Backend (Node.js)

Navigate to the backend directory [1]:
```bash
cd backend
```

#### On Windows / 🍎 On macOS / 🐧 On Linux:
```bash
npm run dev
```
*(Runs the database and routing engine locally on `http://127.0.0.1:3001`)*

---

### Terminal 3: The Telegram Bot (Grammy)

Navigate to the bot directory [1]:
```bash
cd bot
```

#### 🖥️ On Windows / 🍎 On macOS / 🐧 On Linux:
```bash
npm run dev
```
*(Runs the bot in local Long-polling mode—no public webhooks or tunnels required!)*