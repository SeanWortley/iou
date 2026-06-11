import { createAuthenticatedClient, isPendingGrant } from '@interledger/open-payments';
import { config } from '../config';

// Singleton — one authenticated client per process lifetime.
// The client signs every request with the Ed25519 private key.
let _client: Awaited<ReturnType<typeof createAuthenticatedClient>> | null = null;

export async function getClient() {
  if (_client) return _client;
  _client = await createAuthenticatedClient({
    walletAddressUrl: config.op.walletAddress,
    keyId:            config.op.keyId,
    privateKey:       config.op.privateKeyPath, // file path — SDK reads the .pem itself
  });
  return _client;
}

// Convert shorthand "$ilp.example.com/alice" → "https://ilp.example.com/alice".
// The SDK also accepts full https:// URLs, so this is safe to call either way.
export function normaliseWalletAddress(addr: string): string {
  return addr.startsWith('$') ? `https://${addr.slice(1)}` : addr;
}

// Type guard for non-interactive (immediately finalised) grants.
// Counterpart to isPendingGrant from the SDK.
export function isFinalizedGrant(
  grant: unknown
): grant is { access_token: { value: string } } {
  const g = grant as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    typeof g?.access_token?.value === 'string' &&
    (g.access_token.value as string).length > 0 &&
    !isPendingGrant(g)
  );
}
