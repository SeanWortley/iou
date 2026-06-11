import './styles.css';
import { isLoggedIn } from './auth';
import { api, User } from './api';
import { renderHomeView }    from './views/homeView';
import { renderLoginView }   from './views/loginView';
import { renderSignupView }  from './views/signupView';
import { renderProfileView } from './views/profileView';
import { renderHistoryView } from './views/historyView';
import { renderQuoteView }   from './views/quoteView';
import { renderConsentView } from './views/consentView';
import { renderStatusView }        from './views/statusView';
import { renderPublicProfileView } from './views/publicProfileView';
import type { QuoteResponse } from './api';

const view    = document.getElementById('view')!;
const nav     = document.getElementById('main-nav')!;
const navLinks = nav.querySelectorAll<HTMLAnchorElement>('.nav-link');

// ─── State ────────────────────────────────────────────────────────────────────

let pendingQuote: QuoteResponse | null = null;
let cachedUser:   User | null          = null;

// ─── Nav helpers ──────────────────────────────────────────────────────────────

function updateNav(route: string): void {
  nav.hidden = !isLoggedIn();
  navLinks.forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });
}

// ─── Remit sub-views ──────────────────────────────────────────────────────────

function showConsent(): void {
  if (!pendingQuote) { window.location.hash = '#/remit'; return; }
  renderConsentView(view, pendingQuote, () => {
    if (cachedUser) showRemit(cachedUser);
  });
}

function showStatus(id: string): void {
  renderStatusView(view, id);
}

async function showRemit(user: User): Promise<void> {
  renderQuoteView(view, user, (res: QuoteResponse) => {
    pendingQuote = res;
    showConsent();
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function route(): Promise<void> {
  // GNAP callback: ?id=<uuid> takes priority over hash.
  // Strip the query string immediately so subsequent hashchange events don't re-enter this branch.
  const params   = new URLSearchParams(window.location.search);
  const returnId = params.get('id');
  if (returnId) {
    // Use a distinct hash so any subsequent nav-link click changes the hash
    // and triggers hashchange. Preserving the old hash (e.g. #/remit) would
    // mean clicking "New Payment" → #/remit produces no hashchange event.
    history.replaceState({}, '', window.location.pathname + '#/status');
    updateNav('');
    showStatus(returnId);
    return;
  }

  const hash  = window.location.hash || '#/';
  const path  = hash.slice(1); // e.g. '/remit'

  const segment = path.split('/')[1] ?? '';
  updateNav(segment);

  // Public routes
  if (path === '/' || path === '') {
    renderHomeView(view);
    return;
  }
  if (path === '/login') {
    renderLoginView(view);
    return;
  }
  if (path === '/signup') {
    renderSignupView(view);
    return;
  }

  // Protected routes
  if (!isLoggedIn()) {
    window.location.hash = '#/login';
    return;
  }

  // Fetch user once per session (cache until logout)
  if (!cachedUser) {
    try {
      cachedUser = await api.auth.me();
    } catch {
      window.location.hash = '#/login';
      return;
    }
  }

  // Sentinel set after a GNAP callback so the status view was already rendered.
  // If the user lands here via browser back/forward without a live status view, go home.
  if (path === '/status') {
    window.location.hash = '#/';
    return;
  }

  if (path === '/remit') {
    pendingQuote = null;
    await showRemit(cachedUser);
    return;
  }
  if (path === '/history') {
    await renderHistoryView(view);
    return;
  }
  if (path === '/profile') {
    await renderProfileView(view);
    return;
  }
  if (path.startsWith('/user/')) {
    const userId = path.slice('/user/'.length);
    await renderPublicProfileView(view, userId);
    return;
  }

  // Fallback
  window.location.hash = '#/';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('hashchange', () => {
  cachedUser = null; // re-fetch user on navigation so profile updates reflect
  route();
});

route();
