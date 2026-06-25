import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id:                     text('id').primaryKey(),
  telegramId:             text('telegram_id').notNull().unique(),
  telegramUsername:       text('telegram_username').unique(), // @username — nullable, not all Telegram users set one
  displayName:            text('display_name').notNull(),
  phoneNumber:            text('phone_number').notNull().unique(),
  passwordHash:           text('password_hash').notNull(),
  walletAddress:          text('wallet_address').notNull(),

  // Cached from the wallet server-info endpoint on first payment — avoids a
  // network round-trip on every send. Null until populated after first use.
  assetCode:              text('asset_code'),    // e.g. "ZAR"
  assetScale:             integer('asset_scale'), // e.g. 2 → amounts stored in cents

  // Wrong password increments the counter; hitting the limit sets lockedUntil.
  // Both reset to 0 / null on a successful password check.
  failedPasswordAttempts: integer('failed_password_attempts').notNull().default(0),
  lockedUntil:            integer('locked_until', { mode: 'timestamp' }),

  // Interledger private key — encrypted with AES-256-GCM using a key derived
  // from the user's payment password via PBKDF2. Never stored in plaintext.
  // To decrypt: PBKDF2(password, privateKeySalt) → AES.decrypt(ciphertext, derivedKey, IV)
  // Changing the password requires re-encrypting all three of these fields.
  privateKeyEncrypted:    text('private_key_encrypted'),  // AES-256-GCM ciphertext (base64)
  privateKeyIv:           text('private_key_iv'),         // AES initialisation vector (base64)
  privateKeySalt:         text('private_key_salt'),       // PBKDF2 salt (base64)

  createdAt:              integer('created_at', { mode: 'timestamp' }).notNull(),
});

export type User    = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// Tracks which registered users the bot has seen in each group chat.
// Populated organically: every time a registered user sends a message in a group
// where the bot is present, upsert their row here.
// Used for group-chat name lookup: "send Noah R50" → search only within this group.
export const groupMembers = sqliteTable('group_members', {
  id:              text('id').primaryKey(),
  groupTelegramId: text('group_telegram_id').notNull(), // Telegram's chat ID for the group
  userId:          text('user_id').notNull().references(() => users.id),
  lastSeenAt:      integer('last_seen_at', { mode: 'timestamp' }).notNull(),
});

export type GroupMember    = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;

export const transactions = sqliteTable('transactions', {
  id:                    text('id').primaryKey(),

  // PENDING → AWAITING_GRANT → COMPLETED | FAILED
  status:                text('status').notNull(),

  // FIXED_SEND: sender specifies debitAmount
  // FIXED_RECEIVE: receiver specifies incomingAmount
  paymentType:           text('payment_type').notNull(),

  senderWalletAddress:   text('sender_wallet_address').notNull(),
  receiverWalletAddress: text('receiver_wallet_address').notNull(),

  // Amounts in smallest asset unit (e.g. cents); strings to avoid float drift
  debitAmount:           text('debit_amount'),   // what the sender pays
  receiveAmount:         text('receive_amount'),  // what the receiver gets
  assetCode:             text('asset_code').notNull(),
  assetScale:            integer('asset_scale').notNull(),
  receiveAssetCode:      text('receive_asset_code'),
  receiveAssetScale:     integer('receive_asset_scale'),

  // Open Payments resource URLs returned by the SDK
  incomingPaymentUrl:    text('incoming_payment_url'),
  quoteUrl:              text('quote_url'),
  outgoingPaymentUrl:    text('outgoing_payment_url'),

  // Quotes are time-limited; past this the transaction is effectively dead
  quoteExpiresAt:        integer('quote_expires_at', { mode: 'timestamp' }),

  // GNAP grant continuation — persisted so the /api/callback handler can resume
  grantContinueUri:      text('grant_continue_uri'),
  grantContinueToken:    text('grant_continue_token'),
  grantInteractNonce:    text('grant_interact_nonce'),

  userId:                text('user_id').references(() => users.id),
  errorMessage:          text('error_message'),
  createdAt:             integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:             integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type Transaction    = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
