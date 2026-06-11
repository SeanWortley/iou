# Role & Objective

You are an expert Principal Software Architect specializing in TypeScript, Node.js, and web standards. Your task is to design a clean, highly extensible, and production-grade boilerplate/template repository for an Open Payments Hackathon. 

The goal of this repository is to serve as a frictionless launchpad for students and hackers. It must be a monorepo-style setup (Frontend and Backend in separate folders within one repo) that implements a minimal, bare-bones **Remittance System** utilizing the official `@interledger/open-payments` SDK. 

Keep the architecture completely flat, explicit, and easy to modify, avoiding over-engineering, microservices, or complex background workers.

---

## Project Identity & Name Ideas
Please use the following project identity for the configuration and documentation:
*   **Project Title:** **OpenRemit**
*   **Tagline:** A bare-bones, Open Payments remittance template for hackers.

---

## High-Level Architecture & Tech Stack

### 1. Root & Repository Structure
A single git repository containing two primary directories. Keep the build tooling universal and zero-config where possible.
*   `/backend`: Node.js, TypeScript, Express, SQLite.
*   `/frontend`: A lightweight SPA (e.g., Vite + TypeScript or minimal React/Vue—specify the simplest path for a hacker to tweak UI).
*   `README.md`: High-level overview, quickstart instructions, and explicit architectural maps designed to be read easily by LLMs/AI coding assistants.

### 2. Backend Stack (`/backend`)
*   **Runtime/Language:** Node.js with TypeScript (`ts-node-dev` or `tsx` for fast watch-mode execution).
*   **Framework:** Express.js (simple, explicit routing; no heavy framework abstractions like NestJS).
*   **Database & ORM:** SQLite for zero-setup local storage. Use a lightweight, explicit ORM or query builder like **Prisma** or **Drizzle ORM** (pick whichever yields fewer files and cleaner schema files for a beginner).
*   **Core Dependency:** `@interledger/open-payments`.
*   **Concurrency:** No Redis or complex message brokers. Use simple async/await execution loops or basic in-memory intervals if background polling (e.g., for continuous payment tracking) is strictly necessary.

### 3. Frontend Stack (`/frontend`)
*   **Tooling:** Vite + TypeScript.
*   **UI Componentry:** Keep it incredibly simple. Standard HTML/CSS or basic Tailwind via CDN/Vite plugin so students don't get lost in complex UI state management frameworks.

---

## Core Domain Features (The MVP Remittance Flow)
The template must demonstrate the fundamental mechanics of the Open Payments API within a basic Send/Receive workflow:
1.  **Wallet Address Resolution:** Resolving an Open Payments wallet address (Payment Pointer) to fetch the grant endpoints and account capabilities. Including clear translation from shorthand addresses like `$ilp.interledger-test.dev/usdtest` to the full URI.
2.  **Fixed-Send Payment Flow:** User specifies an exact amount of currency they want to *send* from their wallet to a recipient.
3.  **Fixed-Receive Payment Flow:** User specifies an exact amount of currency the recipient must *receive* (useful for exact invoice matching).
4.  **Quote & Grant Lifecycle:** Explicitly show how to request a quote, request an incoming/outgoing payment grant, and finalize the payment.
5. **Auth Flow:** If the recipient's wallet requires user authorization, demonstrate how to handle the consent flow, including redirecting the user to the interact URL and handling the callback.

---

## Execution Requirements for the Planning Stage

Please generate the architectural plan and breakdown covering the following sections:

### 1. File Tree Design
Provide a complete, visual directory structure of the repository. Ensure it highlights exactly where the database schema, Open Payments client setup, API routes, and Frontend views live.

### 2. Database Schema Design
Define the minimal database tables required for this MVP (e.g., a `Users` table, a `Transactions/Remittances` table to track status like `PENDING`, `COMPLETED`, `FAILED`, and fields for storing the Quote/Grant details).

### 3. Step-by-Step API Endpoint Matrix
Map out the essential Express routes needed to handle the frontend requests and orchestrate the Open Payments lifecycle:
*   `POST /api/remit/quote` (Resolve pointers, request quote)
*   `POST /api/remit/consent` (Create incoming/outgoing grants, return the interact ref URL for user authorization if required)
*   `POST /api/remit/execute` (Finalize and commit the payment after authorization)

### 4. Open Payments Client Module Layout
Outline how the `@interledger/open-payments` client should be initialized as a singleton module, including how it handles the required cryptographic keys/certificates.

### 5. AI-Ready Documentation Template (`README.md` spec)
Draft a succinct, high-context markdown guide to be placed in the repository root. This guide should include:
*   A "Context for AI Assistants" section that explains the project layout so when a student pastes it into ChatGPT/Claude/Cursor, the AI immediately understands how to add features without breaking the core structure.
*   One-line startup scripts (e.g., using `npm-run-all` or simple concurrent scripts from the root directory).

Please ensure you check `example.ts` for a reference implementation of the Open Payments client usage and flow from another project. You don't need to implement the SSE workflow, the example is just useful to ensure the code structure and client usage is correct.

### 6. Optional: Theming & Branding Suggestions
Provide a simple CSS file or Tailwind configuration that gives the frontend a clean, modern look without overwhelming students with design decisions. Include suggestions for how to easily customize the branding (e.g., colors, logos) in a way that doesn't require deep CSS knowledge.