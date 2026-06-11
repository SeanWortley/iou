import { api, PublicProfile, SharedTransaction } from '../api';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('');
}

function formatAmount(tx: SharedTransaction): string {
  const val    = tx.debitAmount ?? tx.receiveAmount ?? '0';
  const scale  = tx.assetScale ?? 2;
  const amount = (Number(val) / Math.pow(10, scale)).toFixed(scale);
  return `${amount} ${tx.assetCode}`;
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatStatus(status: string): string {
  const labels: Record<string, string> = {
    COMPLETED:      'Completed',
    FAILED:         'Failed',
    PENDING:        'Pending',
    AWAITING_GRANT: 'Awaiting',
  };
  return labels[status] ?? status;
}

function formatPointer(url: string): string {
  if (url.startsWith('$')) return url;
  return url.replace(/^https?:\/\//, '$');
}

export async function renderPublicProfileView(container: HTMLElement, userId: string): Promise<void> {
  container.innerHTML = `<div class="card"><p class="muted">Loading profile…</p></div>`;

  let data: PublicProfile;
  try {
    data = await api.users.getProfile(userId);
  } catch {
    container.innerHTML = `<div class="card"><p class="error-msg">User not found.</p></div>`;
    return;
  }

  const { user, sharedTransactions } = data;

  const avatarEl = user.avatar
    ? `<img class="pub-profile-avatar" src="${user.avatar}" alt="${user.displayName}" />`
    : `<div class="pub-profile-avatar pub-profile-avatar-placeholder">${initials(user.displayName)}</div>`;

  const walletDisplay = user.walletAddress ? formatPointer(user.walletAddress) : 'No wallet set';

  const txRows = sharedTransactions.map(tx => `
    <tr>
      <td class="history-date-cell">${formatDate(tx.createdAt)}</td>
      <td class="history-amount-cell">${formatAmount(tx)}</td>
      <td><span class="status-badge status-${tx.status.toLowerCase()}">${formatStatus(tx.status)}</span></td>
    </tr>
  `).join('');

  const txSection = sharedTransactions.length === 0
    ? `<p class="muted" style="padding: 0.5rem 0;">No shared transactions yet.</p>`
    : `<div class="history-table-wrap">
        <table class="history-table">
          <thead>
            <tr><th>Date</th><th>Amount</th><th>Status</th></tr>
          </thead>
          <tbody>${txRows}</tbody>
        </table>
      </div>`;

  const sendBtn = user.walletAddress
    ? `<a href="#/remit" class="btn btn-africa-primary" style="width:100%;">Send Money →</a>`
    : '';

  container.innerHTML = `
    <div class="pub-profile-page">
      <div class="card history-card pub-profile-card">
        <button class="btn btn-secondary pub-profile-back" id="pub-back-btn" style="align-self:flex-start;font-size:0.8125rem;padding:0.35rem 0.75rem;">← Back</button>
        <div class="pub-profile-header">
          ${avatarEl}
          <div class="pub-profile-info">
            <h2 class="pub-profile-name">${user.displayName}</h2>
            <p class="muted" style="font-size:0.8125rem;word-break:break-all;">${walletDisplay}</p>
          </div>
        </div>
        ${sendBtn}
      </div>
      <div class="card history-card">
        <h3 class="pub-profile-tx-title">Shared transactions</h3>
        ${txSection}
      </div>
    </div>
  `;

  container.querySelector('#pub-back-btn')!.addEventListener('click', () => history.back());
}
