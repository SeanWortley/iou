import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}\nCopy backend/.env.example → backend/.env and fill in your values.`);
  return val;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  backendUrl: process.env.BACKEND_URL ?? 'http://localhost:3001',

  telegram: {
  },

  op: {
    walletAddress: required('OP_WALLET_ADDRESS'),
    keyId: required('OP_KEY_ID'),
    privateKeyPath: required('OP_PRIVATE_KEY_PATH'),
  },

  db: {
    path: process.env.DB_PATH ?? './iou.db',
  },
};
