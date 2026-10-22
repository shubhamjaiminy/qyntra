/**
 * Billing through Stripe, without the Stripe SDK: Checkout to upgrade,
 * the customer portal to manage, and a signed webhook as the single
 * source of truth for an org's plan.
 *
 *   STRIPE_SECRET_KEY       sk_live_… / sk_test_…
 *   STRIPE_WEBHOOK_SECRET   whsec_… for POST /v1/stripe/webhook
 *   STRIPE_PRICE_TEAM       price id, billed per project
 *   STRIPE_PRICE_BUSINESS   price id, flat monthly
 *   STRIPE_PRICE_PARTNER    price id, flat monthly; optional. The design-partner
 *                           plan, sold only to orgs an operator offered it to
 *
 * Without the key, the billing page says billing is not configured and
 * every org stays on its current plan — a self-hosted install works.
 */

import { createHmac, timingSafeEqual } from 'crypto';

import type { Store } from './db';
import { field, html, HttpError, jsonResponse, redirect, type Request, type Router } from './http';
import { limitsFor, PLANS } from './plans';
import { csrfField } from './views';
import { guards } from './web';

interface BillingContext {
  store: Store;
  baseUrl: string;
  secret: string;
  secure: boolean;
}

const STRIPE_API = 'https://api.stripe.com/v1';

const PAID_PLANS = ['team', 'business', 'partner'] as const;
type PaidPlan = (typeof PAID_PLANS)[number];

const PRICE_ENV: Record<PaidPlan, string> = {
  team: 'STRIPE_PRICE_TEAM',
  business: 'STRIPE_PRICE_BUSINESS',
  partner: 'STRIPE_PRICE_PARTNER',
};

const priceFor = (plan: PaidPlan) => process.env[PRICE_ENV[plan]];

/**
 * The plans this org may buy: the public ones, plus a hidden plan only
 * when an operator offered it to this org.
 */
export function purchasablePlans(org: { offeredPlan?: string }): PaidPlan[] {
  return PAID_PLANS.filter((plan) => !PLANS[plan].hidden || org.offeredPlan === plan);
}

export const billingConfigured = () => !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_TEAM && !!process.env.STRIPE_PRICE_BUSINESS;

/** Stripe's form encoding, including nested keys like line_items[0][price]. */
export function stripeForm(values: Record<string, string | number>): string {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

async function stripe(path: string, values: Record<string, string | number>): Promise<Record<string, unknown>> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: stripeForm(values),
    signal: AbortSignal.timeout(15_000),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const message = (body.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
    throw new HttpError(502, `Stripe refused the request: ${message}`);
  }

  return body;
}

/**
 * Verify a Stripe webhook signature: header "t=…,v1=…", HMAC-SHA256 of
 * "t.body" with the endpoint secret, within five minutes.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, at = Date.now()): boolean {
  if (!header || !secret) return false;

  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  const signatures = header.split(',').filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));

  if (!Number.isFinite(timestamp) || Math.abs(at / 1000 - timestamp) > 300 || signatures.length === 0) return false;

  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'));

  return signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** Apply one webhook event to the store. Exported for tests. */
export function applyStripeEvent(store: Store, event: { type?: string; data?: { object?: Record<string, unknown> } }): string {
  const object = event.data?.object ?? {};
  const metadata = (object.metadata ?? {}) as Record<string, string>;

  if (event.type === 'checkout.session.completed') {
    const org = metadata.org_id ? store.orgById(metadata.org_id) : undefined;
    const plan = PAID_PLANS.find((candidate) => candidate === metadata.plan);

    if (!org || !plan) return 'ignored: no org or plan in metadata';

    store.setPlan(org.id, plan, { customerId: String(object.customer ?? ''), subscriptionId: String(object.subscription ?? '') });
    store.audit(org.id, 'stripe', 'billing.upgraded', plan);
    return `org ${org.slug} → ${plan}`;
  }

  if (event.type === 'customer.subscription.deleted' || (event.type === 'customer.subscription.updated' && ['canceled', 'unpaid', 'incomplete_expired'].includes(String(object.status)))) {
    const org = store.orgByStripeCustomer(String(object.customer ?? ''));
    if (!org) return 'ignored: unknown customer';

    store.setPlan(org.id, 'free');
    store.audit(org.id, 'stripe', 'billing.cancelled', String(object.status ?? 'deleted'));
    return `org ${org.slug} → free`;
  }

  return 'ignored';
}

export function extendWithBilling(router: Router, context: BillingContext): void {
  router.get('/o/:org/billing', (request) => {
    const { session, org } = guards.requireOrg(context, request);
    const limits = limitsFor(org.plan);
    const usage = { projects: context.store.projects(org.id).length, members: context.store.members(org.id).length, runs: context.store.runsThisMonth(org.id) };
    const owner = org.role === 'owner';

    return guards.page(
      context,
      request,
      'Billing',
      html`<h1>Billing</h1>
      <div class="grid">
        <div class="card stat"><div class="label">Plan</div><div class="value">${limits.name}</div></div>
        <div class="card stat"><div class="label">Projects</div><div class="value">${usage.projects} / ${limits.projects}</div></div>
        <div class="card stat"><div class="label">Members</div><div class="value">${usage.members} / ${limits.members}</div></div>
        <div class="card stat"><div class="label">Runs this month</div><div class="value">${usage.runs} / ${limits.runsPerMonth}</div></div>
      </div>
      ${!billingConfigured()
        ? html`<div class="card"><p>Online billing is not configured on this server. To change plan, contact your Qyntra administrator.</p></div>
          ${org.offeredPlan && PLANS[org.offeredPlan] && org.plan !== org.offeredPlan
            ? html`<div class="plans"><div class="card plan"><h2 style="margin-top:0">${PLANS[org.offeredPlan].name}</h2>
                <span class="badge ok">offered to you</span>
                <div class="price">$${PLANS[org.offeredPlan].price}<span class="small muted"> / month</span></div>
                <ul>${PLANS[org.offeredPlan].features.map((feature) => html`<li>${feature}</li>`)}</ul>
                <span class="muted small">Reply to your invitation email to pay by invoice.</span></div></div>`
            : ''}`
        : html`<div class="plans">
          ${purchasablePlans(org).map((key) => {
            const plan = PLANS[key];
            return html`<div class="card plan"><h2 style="margin-top:0">${plan.name}</h2>
              ${plan.hidden ? html`<span class="badge ok">offered to you</span>` : ''}
              <div class="price">$${plan.price}<span class="small muted">${plan.perProject ? ' / project / month' : ' / month'}</span></div>
              <ul>${plan.features.map((feature) => html`<li>${feature}</li>`)}</ul>
              ${org.plan === key
                ? html`<span class="badge ok">current plan</span>`
                : !priceFor(key)
                  ? html`<span class="muted small">Card payment is not set up for this plan. Reply to your invitation email to pay by invoice.</span>`
                  : owner
                    ? html`<form method="post" action="/o/${org.slug}/billing/checkout">${csrfField(session.csrf)}<input type="hidden" name="plan" value="${key}"><button type="submit">${plan.hidden ? 'Start' : 'Upgrade to'} ${plan.name}</button></form>`
                    : html`<span class="muted small">Ask the owner to upgrade.</span>`}</div>`;
          })}
          </div>
          ${owner && org.stripeCustomerId
            ? html`<form method="post" action="/o/${org.slug}/billing/portal">${csrfField(session.csrf)}<button class="secondary" type="submit">Manage payment method and invoices</button></form>`
            : ''}`}`,
      { session, orgSlug: org.slug }
    );
  });

  router.post('/o/:org/billing/checkout', async (request: Request) => {
    const { session, org } = guards.requireOrg(context, request, 'owner');
    guards.checkForm(context, request, session);

    if (!billingConfigured()) throw new HttpError(503, 'Billing is not configured on this server.');

    const plan = purchasablePlans(org).find((candidate) => candidate === field(request, 'plan'));
    if (!plan) throw new HttpError(400, 'Choose a plan offered on this page.');
    if (!priceFor(plan)) throw new HttpError(503, `Card payment is not set up for the ${PLANS[plan].name} plan.`);

    const quantity = plan === 'team' ? Math.max(1, context.store.projects(org.id).length) : 1;

    const checkout = await stripe('/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': priceFor(plan)!,
      'line_items[0][quantity]': quantity,
      success_url: `${context.baseUrl}/o/${org.slug}/billing?ok=${encodeURIComponent('Thank you — your plan updates in a few seconds.')}`,
      cancel_url: `${context.baseUrl}/o/${org.slug}/billing`,
      client_reference_id: org.id,
      'metadata[org_id]': org.id,
      'metadata[plan]': plan,
      'subscription_data[metadata][org_id]': org.id,
      'subscription_data[metadata][plan]': plan,
      ...(org.stripeCustomerId ? { customer: org.stripeCustomerId } : { customer_email: session.user.email }),
    });

    context.store.audit(org.id, session.user.email, 'billing.checkout', plan);
    return redirect(String(checkout.url));
  });

  router.post('/o/:org/billing/portal', async (request: Request) => {
    const { session, org } = guards.requireOrg(context, request, 'owner');
    guards.checkForm(context, request, session);

    if (!billingConfigured() || !org.stripeCustomerId) throw new HttpError(400, 'No billing account yet.');

    const portal = await stripe('/billing_portal/sessions', { customer: org.stripeCustomerId, return_url: `${context.baseUrl}/o/${org.slug}/billing` });
    return redirect(String(portal.url));
  });

  router.post('/v1/stripe/webhook', (request: Request) => {
    if (!verifyStripeSignature(request.rawBody, String(request.headers['stripe-signature'] ?? ''), process.env.STRIPE_WEBHOOK_SECRET ?? '')) {
      throw new HttpError(400, 'Invalid Stripe signature.');
    }

    let event: { type?: string; data?: { object?: Record<string, unknown> } };

    try {
      event = JSON.parse(request.rawBody);
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }

    return jsonResponse({ received: true, result: applyStripeEvent(context.store, event) });
  });
}
