import { isLoggedIn } from '../auth';

export function renderHomeView(container: HTMLElement): void {
  if (isLoggedIn()) {
    renderDashboardHome(container);
  } else {
    renderPublicHome(container);
  }
}

function renderDashboardHome(container: HTMLElement): void {
  container.innerHTML = `
    <div class="home-logged-in">
      <div class="home-hero-band">
        <h1 class="home-hero-title">Send money home.</h1>
        <h1 class="home-hero-title home-hero-title-warm">Wherever home is.</h1>
        <p class="home-hero-body">
          Move money across borders and beyond in seconds.</br>
          Live exchange rates, no hidden fees, built on open standards.
        </p>
        <div class="home-hero-cta-row">
          <a href="#/remit"   class="btn btn-africa-primary">Send money →</a>
          <a href="#/history" class="btn btn-secondary">View history</a>
        </div>
      </div>

      <div class="home-pillars">
        <div class="home-pillar">
          <span class="home-pillar-icon">⚡</span>
          <div>
            <div class="home-pillar-label">Instant settlement</div>
            <div class="home-pillar-text">Real-time transfer; Your family gets the money now.</div>
          </div>
        </div>
        <div class="home-pillar">
          <span class="home-pillar-icon">💱</span>
          <div>
            <div class="home-pillar-label">Fair exchange rates</div>
            <div class="home-pillar-text">Live FX quotes before you commit. ZAR, KES, NGN, GHS and more.</div>
          </div>
        </div>
        <div class="home-pillar">
          <span class="home-pillar-icon">🔓</span>
          <div>
            <div class="home-pillar-label">Open by design</div>
            <div class="home-pillar-text">Built on the Interledger Open Payments standard</div>
          </div>
        </div>
      </div>

      <div class="home-proverb-band">
        <p class="home-proverb">"People lie, money tells the truth."</p>
        <p class="home-proverb-attr">— Unknown </p>
      </div>
    </div>
  `;
}

function renderPublicHome(container: HTMLElement): void {
  container.innerHTML = `
    <div class="card hero">
      <div class="hero-africa-tag">🌍 Pan-African remittances</div>
      <h1>Send money home</h1>
      <p class="hero-sub">
        Fast, fair, and open — powered by the Interledger Protocol.
        Live exchange rates across Africa and beyond.
      </p>
      <div class="hero-actions">
        <a href="#/signup" class="btn btn-primary">Create account</a>
        <a href="#/login"  class="btn btn-secondary">Log in</a>
      </div>
      <div class="hero-features">
        <div class="feature">
          <span class="feature-icon">⚡</span>
          <span>Real-time transfers</span>
        </div>
        <div class="feature">
          <span class="feature-icon">💱</span>
          <span>Live FX rates</span>
        </div>
        <div class="feature">
          <span class="feature-icon">🌍</span>
          <span>Pan-African reach</span>
        </div>
      </div>
    </div>
  `;
}
