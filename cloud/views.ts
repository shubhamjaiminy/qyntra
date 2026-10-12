/**
 * Page layout, styles and small components for Qyntra Cloud.
 *
 * Server-rendered HTML with no JavaScript: fast, works everywhere, and
 * lets the Content-Security-Policy forbid scripts entirely. Charts are
 * inline SVG built here.
 */

import { html, raw, type SafeHtml } from './http';

export const CSS = `
:root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f8fafc; --card:#fff; --brand:#4f46e5; --brand-ink:#fff;
        --ok:#15803d; --ok-bg:#dcfce7; --warn:#a16207; --warn-bg:#fef9c3; --bad:#b91c1c; --bad-bg:#fee2e2; }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
a { color: var(--brand); text-decoration: none; } a:hover { text-decoration: underline; }
header.top { background: var(--card); border-bottom: 1px solid var(--line); }
header.top .bar { max-width: 1120px; margin: 0 auto; padding: .75rem 1.25rem; display: flex; align-items: center; gap: 1.25rem; }
header.top .logo { font-weight: 800; font-size: 1.15rem; color: var(--ink); letter-spacing: -.02em; }
header.top nav { display: flex; gap: 1rem; flex: 1; } header.top nav a { color: var(--muted); } header.top nav a.on { color: var(--ink); font-weight: 600; }
main { max-width: 1120px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
h1 { font-size: 1.6rem; letter-spacing: -.02em; margin: .25rem 0 1rem; } h2 { font-size: 1.15rem; margin: 2rem 0 .75rem; }
.muted { color: var(--muted); } .small { font-size: .85rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.1rem 1.25rem; margin-bottom: 1rem; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.stat .value { font-size: 1.7rem; font-weight: 700; } .stat .label { color: var(--muted); font-size: .85rem; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: .55rem .75rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); background: #f1f5f9; }
tr:last-child td { border-bottom: 0; }
.badge { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: .78rem; font-weight: 600; white-space: nowrap; }
.badge.ok { color: var(--ok); background: var(--ok-bg); } .badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.bad { color: var(--bad); background: var(--bad-bg); } .badge.neutral { color: var(--muted); background: #f1f5f9; }
form.inline { display: inline; }
label { display: block; font-weight: 600; font-size: .9rem; margin: .75rem 0 .3rem; }
input[type=text], input[type=email], input[type=password], select { width: 100%; max-width: 420px; padding: .55rem .7rem; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; background: #fff; }
button, .button { display: inline-block; background: var(--brand); color: var(--brand-ink); border: 0; border-radius: 8px; padding: .55rem 1rem; font: inherit; font-weight: 600; cursor: pointer; }
button.secondary, .button.secondary { background: #fff; color: var(--ink); border: 1px solid #cbd5e1; }
button.danger { background: var(--bad); }
.flash { padding: .75rem 1rem; border-radius: 8px; margin-bottom: 1rem; } .flash.error { background: var(--bad-bg); color: var(--bad); } .flash.ok { background: var(--ok-bg); color: var(--ok); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
pre { background: #0f172a; color: #e2e8f0; padding: 1rem; border-radius: 8px; overflow-x: auto; }
.token { font-size: 1rem; padding: .75rem; background: #fef9c3; border-radius: 8px; word-break: break-all; }
.hero { padding: 4rem 0 2rem; text-align: center; } .hero h1 { font-size: 2.6rem; max-width: 820px; margin: 0 auto 1rem; line-height: 1.15; }
.hero p { font-size: 1.15rem; color: var(--muted); max-width: 680px; margin: 0 auto 1.5rem; }
.features { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin: 2rem 0; }
.plans { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.plan .price { font-size: 2rem; font-weight: 800; } .plan ul { padding-left: 1.1rem; }
.tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--line); margin-bottom: 1.25rem; }
.tabs a { padding: .5rem .85rem; color: var(--muted); border-bottom: 2px solid transparent; } .tabs a.on { color: var(--ink); border-color: var(--brand); font-weight: 600; }
footer { text-align: center; color: var(--muted); font-size: .85rem; padding: 2rem; }
.spark { width: 100%; height: 64px; }
`;

export interface LayoutOptions {
  title: string;
  user?: { name: string; email: string };
  orgSlug?: string;
  csrf?: string;
  flash?: { kind: 'ok' | 'error'; text: string };
  section?: 'app' | 'public';
}

export function layout(options: LayoutOptions, content: SafeHtml): SafeHtml {
  const signedIn = !!options.user;

  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title} · Qyntra</title><link rel="stylesheet" href="/static/app.css"></head>
<body>
<header class="top"><div class="bar">
  <a class="logo" href="${signedIn ? '/app' : '/'}">Qyntra</a>
  <nav>
    ${signedIn && options.orgSlug ? html`<a href="/o/${options.orgSlug}">Projects</a><a href="/o/${options.orgSlug}/members">Members</a><a href="/o/${options.orgSlug}/billing">Billing</a><a href="/o/${options.orgSlug}/audit">Audit log</a>` : ''}
    ${!signedIn ? html`<a href="/#how">How it works</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/security">Security</a>` : ''}
  </nav>
  ${signedIn
    ? html`<a class="small" href="/account">${options.user!.email}</a>
      <form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${options.csrf}"><button class="secondary" type="submit">Log out</button></form>`
    : html`<a href="/login">Log in</a> <a class="button" href="/signup">Start free</a>`}
</div></header>
<main>
${options.flash ? html`<div class="flash ${options.flash.kind}" role="status">${options.flash.text}</div>` : ''}
${content}
</main>
<footer>Qyntra — your tests run in your CI; we only see results. · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/security">Security</a></footer>
</body></html>`;
}

export function verdictBadge(verdict: string | undefined): SafeHtml {
  const kind = verdict === 'SAFE' || verdict === 'READY' ? 'ok' : verdict === 'SAFE_WITH_RISK' || verdict === 'READY_WITH_ISSUES' ? 'warn' : verdict ? 'bad' : 'neutral';
  return html`<span class="badge ${kind}">${(verdict ?? 'no runs').replace(/_/g, ' ')}</span>`;
}

export function statusBadge(status: string): SafeHtml {
  const kind = status === 'passed' ? 'ok' : status === 'failed' ? 'bad' : 'neutral';
  return html`<span class="badge ${kind}">${status}</span>`;
}

export function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="csrf" value="${token}">`;
}

export function relativeTime(iso: string | null | undefined, at = Date.now()): string {
  if (!iso) return '—';
  const seconds = Math.round((at - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) return '—';
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** Quality score over time, oldest left. Values 0–100. */
export function sparkline(values: number[]): SafeHtml {
  if (values.length < 2) {
    return html`<p class="muted small">The trend appears after two runs.</p>`;
  }

  const width = 600;
  const height = 64;
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - 4 - (Math.max(0, Math.min(100, value)) / 100) * (height - 8)).toFixed(1)}`)
    .join(' ');

  return raw(
    `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Quality score trend">` +
      `<polyline fill="none" stroke="#4f46e5" stroke-width="2" points="${points}"/></svg>`
  );
}
