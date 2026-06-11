import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id:           text('id').primaryKey(),
  displayName:  text('display_name').notNull(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatar:       text('avatar'),              // base64 data URL
  walletAddress: text('wallet_address'),     // set after signup
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull(),
});

export type User    = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const transactions = sqliteTable('transactions', {
  id:                    text('id').primaryKey(),         // crypto.randomUUID()

  // PENDING → AWAITING_GRANT → COMPLETED | FAILED
  status:                text('status').notNull(),

  // FIXED_SEND: sender specifies debitAmount
  // FIXED_RECEIVE: receiver specifies incomingAmount
  paymentType:           text('payment_type').notNull(),

  // Canonical https:// wallet address URLs
  senderWalletAddress:   text('sender_wallet_address').notNull(),
  receiverWalletAddress: text('receiver_wallet_address').notNull(),

  // Amounts in smallest asset unit (e.g. cents for USD); strings to avoid float drift
  debitAmount:           text('debit_amount'),            // what the sender pays
  receiveAmount:         text('receive_amount'),          // what the receiver gets
  assetCode:             text('asset_code').notNull(),    // sender's currency, e.g. USD
  assetScale:            integer('asset_scale').notNull(),// sender's scale, e.g. 2 (cents)
  receiveAssetCode:      text('receive_asset_code'),      // receiver's currency (may differ)
  receiveAssetScale:     integer('receive_asset_scale'),  // receiver's scale

  // Open Payments resource URLs — full canonical URLs returned by the SDK
  incomingPaymentUrl:    text('incoming_payment_url'),
  quoteUrl:              text('quote_url'),
  outgoingPaymentUrl:    text('outgoing_payment_url'),

  // GNAP grant continuation — persisted so the /api/callback handler can resume
  grantContinueUri:      text('grant_continue_uri'),
  grantContinueToken:    text('grant_continue_token'),
  grantInteractNonce:    text('grant_interact_nonce'),

  userId:                text('user_id').references(() => users.id),

  errorMessage:          text('error_message'),
  createdAt:             integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:             integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type Transaction      = typeof transactions.$inferSelect;
export type NewTransaction   = typeof transactions.$inferInsert;
