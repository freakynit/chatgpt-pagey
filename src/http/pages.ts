const PAGEY_TOKEN_URL = "https://pagey.site/dashboard/api-tokens";

const BASE_CSS = `
  :root {
    color-scheme: light dark;
    --ink: #141a10;
    --muted: #5a6354;
    --paper: #fbfbf4;
    --card: #ffffff;
    --line: #e2e3d8;
    --lime: #d6fa73;
    --lime-strong: #c4ef4f;
    --danger: #b42318;
    --danger-bg: #fef3f2;
    --radius: 18px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #f4f6ec;
      --muted: #a7b09a;
      --paper: #0e130b;
      --card: #151b11;
      --line: #2a3324;
      --lime: #d6fa73;
      --lime-strong: #e4ff9c;
      --danger: #ffb4ab;
      --danger-bg: #2a1412;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background:
      radial-gradient(900px 480px at 85% -10%, color-mix(in srgb, var(--lime) 28%, transparent), transparent 70%),
      var(--paper);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; }
  .wrap { width: min(920px, calc(100% - 40px)); margin: 0 auto; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 26px 0; }
  .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 750; letter-spacing: -0.02em; text-decoration: none; }
  .brand-mark {
    display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px;
    background: var(--lime); color: #141a10; font-weight: 900; font-size: 17px;
    box-shadow: inset 0 0 0 1px rgba(20, 26, 16, 0.12);
  }
  .topbar-link { color: var(--muted); font-size: 14px; text-decoration: none; }
  .topbar-link:hover { color: var(--ink); }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: 0 24px 70px rgba(20, 26, 16, 0.08); padding: clamp(24px, 5vw, 44px);
  }
  h1 { margin: 0 0 10px; font-size: clamp(30px, 5vw, 46px); line-height: 1.05; letter-spacing: -0.045em; }
  h2 { margin: 0 0 12px; font-size: 22px; letter-spacing: -0.02em; }
  p { margin: 0 0 16px; }
  .lead { color: var(--muted); font-size: 17px; max-width: 62ch; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 8px; margin-bottom: 18px;
    padding: 6px 11px; border: 1px solid var(--line); border-radius: 999px;
    background: color-mix(in srgb, var(--lime) 18%, transparent);
    color: var(--ink); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #4d7c0f; box-shadow: 0 0 0 3px color-mix(in srgb, var(--lime) 45%, transparent); }
  .error {
    margin: 0 0 20px; padding: 13px 15px; border-radius: 12px;
    background: var(--danger-bg); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
    font-size: 14px;
  }
  .field { margin: 20px 0 8px; }
  label { display: block; font-weight: 700; font-size: 14px; margin-bottom: 7px; }
  input[type="password"], input[type="text"] {
    width: 100%; padding: 14px 15px; border: 1px solid var(--line); border-radius: 12px;
    background: var(--paper); color: var(--ink); font: inherit; font-size: 15px;
  }
  input:focus { outline: 3px solid color-mix(in srgb, var(--lime) 55%, transparent); border-color: color-mix(in srgb, var(--ink) 25%, transparent); }
  .hint { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 26px; }
  .button {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 48px; padding: 0 20px; border: 1px solid #141a10; border-radius: 12px;
    background: var(--lime); color: #141a10; font: inherit; font-weight: 800;
    text-decoration: none; cursor: pointer; box-shadow: 0 6px 0 #141a10;
    transform: translateY(-2px);
  }
  .button:hover { background: var(--lime-strong); }
  .button:active { transform: translateY(2px); box-shadow: 0 1px 0 #141a10; }
  .quiet { color: var(--muted); font-size: 14px; text-decoration: none; }
  .quiet:hover { text-decoration: underline; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 26px; }
  .tile { border: 1px solid var(--line); border-radius: 14px; padding: 18px; background: color-mix(in srgb, var(--card) 88%, var(--paper)); }
  .tile strong { display: block; margin-bottom: 4px; }
  .tile span { color: var(--muted); font-size: 14px; }
  code, pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }
  pre {
    overflow-x: auto; margin: 12px 0 0; padding: 15px 16px; border-radius: 12px;
    background: #141a10; color: #f4f6ec; border: 1px solid #2a3324;
  }
  .steps { margin: 18px 0 0; padding-left: 22px; }
  .steps li { margin: 0 0 10px; }
  .divider { height: 1px; background: var(--line); margin: 30px 0; }
  .footer { color: var(--muted); font-size: 13px; padding: 26px 0 44px; text-align: center; }
  .footer a { color: inherit; }
  .muted { color: var(--muted); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--lime) 35%, transparent); font-size: 12px; font-weight: 700; }
  @media (max-width: 560px) {
    .wrap { width: min(100% - 24px, 920px); }
    .card { border-radius: 14px; }
    .button { width: 100%; }
    .actions { gap: 10px; }
  }
`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, body: string, footer = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)}</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <a class="brand" href="/"><span class="brand-mark">P</span><span>Pagey <span class="muted">for ChatGPT</span></span></a>
      <a class="topbar-link" href="https://pagey.site" rel="noreferrer">pagey.site ↗</a>
    </header>
    ${body}
    ${footer}
  </div>
</body>
</html>`;
}

export interface AuthorizePageInput {
  clientName: string;
  redirectHost: string;
  hiddenFields: Array<[string, string]>;
  csrf: string;
  error?: string;
  cancelUrl?: string;
}

export function renderAuthorizePage(input: AuthorizePageInput): string {
  const hidden = input.hiddenFields
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `      <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n");
  const error = input.error ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>` : "";
  const cancel = input.cancelUrl
    ? `<a class="quiet" href="${escapeHtml(input.cancelUrl)}">Cancel</a>`
    : `<a class="quiet" href="https://pagey.site" rel="noreferrer">Cancel</a>`;

  return layout(
    "Connect Pagey to ChatGPT",
    `<main class="card">
      <div class="eyebrow"><span class="dot"></span> Secure account connection</div>
      <h1>Connect Pagey</h1>
      <p class="lead"><strong>${escapeHtml(input.clientName)}</strong> wants to publish and manage static sites in your Pagey account. It will return to <code>${escapeHtml(input.redirectHost)}</code> when you are done.</p>
      ${error}
      <form method="post" action="/authorize" autocomplete="off">
${hidden}
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
        <div class="field">
          <label for="pagey_token">Pagey API token</label>
          <input id="pagey_token" name="pagey_token" type="password" inputmode="text" spellcheck="false"
                 autocapitalize="none" autocomplete="off" placeholder="Paste your token" required>
          <p class="hint">Create a token at <a href="${PAGEY_TOKEN_URL}" target="_blank" rel="noreferrer">pagey.site/dashboard/api-tokens</a>. Label it “ChatGPT”. This is not your password.</p>
        </div>
        <div class="actions">
          <button class="button" type="submit">Connect Pagey</button>
          ${cancel}
        </div>
      </form>
      <div class="divider"></div>
      <p class="hint">Your token is stored encrypted on this server and sent only to Pagey’s API. It grants full access to your Pagey account, so create a dedicated token and revoke it when you no longer need this connection.</p>
    </main>`,
    `<footer class="footer">Independent community integration. Pagey sets the hosting terms and limits. <a href="https://pagey.site/terms" rel="noreferrer">Pagey terms</a> · <a href="/terms">Connector terms</a> · <a href="/privacy">Privacy</a></footer>`,
  );
}

export function renderMessagePage(
  title: string,
  message: string,
  options: { status?: number; link?: { href: string; label: string } } = {},
): string {
  const link = options.link
    ? `<div class="actions"><a class="button" href="${escapeHtml(options.link.href)}">${escapeHtml(options.link.label)}</a></div>`
    : "";
  return layout(
    title,
    `<main class="card">
      <div class="eyebrow"><span class="dot"></span> Pagey for ChatGPT</div>
      <h1>${escapeHtml(title)}</h1>
      <p class="lead">${escapeHtml(message)}</p>
      ${link}
    </main>`,
    `<footer class="footer">Pagey hosting is operated by Pagey. This connector is an independent community integration.</footer>`,
  );
}

export function renderLandingPage(input: { baseUrl: string; repoUrl: string }): string {
  const mcpUrl = `${input.baseUrl.replace(/\/$/, "")}/mcp`;
  return layout(
    "Pagey for ChatGPT — publish a website from a conversation",
    `<main class="card">
      <div class="eyebrow"><span class="dot"></span> Free static hosting · no total-site cap</div>
      <h1>ChatGPT writes it.<br>Pagey hosts it.</h1>
      <p class="lead">Turn a conversation into a real website. Ask ChatGPT to build a page, then publish it to a live <code>*.pagey.site</code> address without leaving the chat. Free, no credit card, and no cap on the number of sites you own.</p>
      <div class="actions">
        <a class="button" href="#connect">Connect it to ChatGPT</a>
        <a class="quiet" href="${escapeHtml(input.repoUrl)}" rel="noreferrer">View the source ↗</a>
      </div>

      <div class="grid">
        <div class="tile"><strong>Build in the chat</strong><span>ChatGPT writes the HTML, CSS, and assets. No local build step or deploy pipeline.</span></div>
        <div class="tile"><strong>Free and uncapped</strong><span>Registered Pagey accounts can create 25 new sites per day and keep as many as they want.</span></div>
        <div class="tile"><strong>Keep the same link</strong><span>Update an existing site in place. The URL stays the same; old files are replaced.</span></div>
        <div class="tile"><strong>More than a page</strong><span>Analytics, password protection, custom subdomains, contact forms, and maintenance mode.</span></div>
      </div>

      <div class="divider"></div>

      <section id="connect">
        <h2>Connect in about a minute</h2>
        <ol class="steps">
          <li>In ChatGPT, open <strong>Plugins</strong> → <strong>Add custom MCP server</strong>.</li>
          <li>Name it <strong>Pagey</strong> and use this URL:<pre>${escapeHtml(mcpUrl)}</pre></li>
          <li>Choose <strong>OAuth</strong> for authentication, then create the plugin.</li>
          <li>When ChatGPT opens the Pagey sign-in page, paste an API token from <a href="${PAGEY_TOKEN_URL}" rel="noreferrer">your Pagey dashboard</a>.</li>
          <li>Start a chat: <em>“Build a one-page portfolio for a photographer and publish it to Pagey.”</em></li>
        </ol>
      </section>

      <div class="divider"></div>

      <section>
        <h2>What you can ask for</h2>
        <pre>Build a landing page for my indie SaaS and publish it.

Update the hero copy on my portfolio site. Keep the URL.

Publish a three-page site with index.html, styles.css, and about.html.

Create a waitlist form, embed it in my landing page, and publish.

How many people visited my site this week?</pre>
      </section>

      <div class="divider"></div>

      <section>
        <h2>Honest limits</h2>
        <p class="lead">“Unlimited” means no cap on total sites, not unrestricted resources. Registered accounts can create <strong>25 new sites per UTC day</strong>; updating a site does not use that allowance. Each upload is limited to <strong>1,000 files / 50 MiB</strong>. Pagey also applies request and upload rate limits. Hosted sites are static: no Node.js, PHP, or server-side code. Use Pagey’s hosted form backend for contact forms.</p>
      </section>
    </main>`,
    `<footer class="footer">This server is an independent open-source connector for <a href="https://pagey.site" rel="noreferrer">Pagey</a>. Pagey is operated separately and sets its own terms, limits, and content policies. <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="${escapeHtml(input.repoUrl)}" rel="noreferrer">GitHub</a></footer>`,
  );
}

export function renderTermsPage(input: { repoUrl: string }): string {
  return layout(
    "Terms — Pagey for ChatGPT",
    `<main class="card">
      <div class="eyebrow"><span class="dot"></span> Terms</div>
      <h1>Terms</h1>
      <p class="lead">Pagey for ChatGPT is open-source software. It is provided as-is, under the MIT License, without warranty.</p>
      <h2>Your responsibility</h2>
      <p>You are responsible for the content you publish and for the Pagey API token you connect. Only publish content you own or have the right to publish. Do not use the connector for malware, phishing, spam, harassment, or other unlawful content.</p>
      <h2>Pagey’s terms</h2>
      <p>The connector uploads content to Pagey. Pagey operates the hosting service and sets its own terms, usage limits, content policies, and takedown process. Nothing in this connector changes those terms. Read <a href="https://pagey.site/terms" rel="noreferrer">Pagey’s terms</a> and <a href="https://pagey.site/privacy" rel="noreferrer">privacy policy</a>.</p>
      <h2>Availability</h2>
      <p>This is a community integration. The hosted endpoint and the self-hosted software may change or be unavailable without notice. Pagey’s API limits and allowances apply.</p>
      <h2>Source and license</h2>
      <p>The source is available at <a href="${escapeHtml(input.repoUrl)}" rel="noreferrer">${escapeHtml(input.repoUrl)}</a> under the MIT License. The software is provided “as is”, without warranty of any kind.</p>
    </main>`,
    `<footer class="footer"><a href="/">Home</a> · <a href="/privacy">Privacy</a> · <a href="https://pagey.site/terms" rel="noreferrer">Pagey terms</a></footer>`,
  );
}

export function renderPrivacyPage(input: { repoUrl: string }): string {
  return layout(
    "Privacy — Pagey for ChatGPT",
    `<main class="card">
      <div class="eyebrow"><span class="dot"></span> Privacy</div>
      <h1>Privacy</h1>
      <p class="lead">This connector exists to publish and manage sites in your Pagey account. It collects as little as possible.</p>
      <h2>What is stored</h2>
      <p>When you connect, the Pagey API token you paste is encrypted at rest with AES-256-GCM. The connector also stores your Pagey user ID, email address, account tier, and the ID of the last site you published. OAuth access and refresh tokens are stored only as SHA-256 hashes.</p>
      <h2>What is sent where</h2>
      <p>Site content, settings, and API requests go from ChatGPT to this connector, then to Pagey’s API at <code>pagey.site</code>. Nothing is sent to analytics, advertising, or other third parties. The connector does not log request bodies, API tokens, or OAuth tokens.</p>
      <h2>Retention and removal</h2>
      <p>Connection records remain until the Pagey token is revoked or the operator deletes the record. Removing the plugin from ChatGPT stops new requests but does not automatically delete the stored connection. Revoke the “ChatGPT” token in your Pagey dashboard to cut off access immediately.</p>
      <h2>Contact</h2>
      <p>This is an independent open-source project. Report privacy concerns or request deletion through the repository: <a href="${escapeHtml(input.repoUrl)}" rel="noreferrer">${escapeHtml(input.repoUrl)}</a>.</p>
    </main>`,
    `<footer class="footer"><a href="/">Home</a> · <a href="/terms">Terms</a> · <a href="https://pagey.site/privacy" rel="noreferrer">Pagey privacy policy</a></footer>`,
  );
}
