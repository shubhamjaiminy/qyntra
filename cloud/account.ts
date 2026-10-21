/**
 * Account self-service and the operator console.
 *
 *   /forgot, /reset          password reset by email link (1 hour, single use)
 *   /account                 name, password, sign out everywhere, delete account
 *   /o/:org/members/:u/role  owners change roles
 *   /admin                   operator console: every org, set plan by hand
 *
 * The operator console is for whoever runs this Qyntra Cloud, listed in
 * QYNTRA_CLOUD_ADMINS (comma-separated emails). It is how a pilot gets a
 * free Team plan, or an Enterprise customer is billed by invoice.
 */

import { ROLES, type Role, type Store } from './db';
import { emailConfigured, sendEmail } from './email';
import { field, html, htmlResponse, HttpError, redirect, type Request, type Router } from './http';
import { PLANS } from './plans';
import { hashPassword, passwordProblem, randomSecret, RateLimiter, sessionCookie, sha256, verifyPassword } from './security';
import { csrfField, layout } from './views';
import { guards } from './web';

interface AccountContext {
  store: Store;
  secret: string;
  baseUrl: string;
  secure: boolean;
}

export function isOperator(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.QYNTRA_CLOUD_ADMINS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

const SAME_ANSWER = 'If an account exists for that email, a reset link is on its way. It works once, for one hour.';

export function accountRoutes(router: Router, context: AccountContext): void {
  const forgotLimiter = new RateLimiter(5, 60 * 60_000);

  // ------------------------------------------------
  // PASSWORD RESET
  // ------------------------------------------------

  router.get('/forgot', (request) =>
    htmlResponse(
      layout(
        { title: 'Reset your password', flash: request.url.searchParams.get('ok') ? { kind: 'ok', text: SAME_ANSWER } : undefined },
        html`<div class="card" style="max-width:460px;margin:2rem auto"><h1>Reset your password</h1>
        ${context.secure && !emailConfigured()
          ? html`<p>Password reset by email is not configured on this server. Ask your Qyntra administrator.</p>`
          : html`<form method="post" action="/forgot"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email">
            <p><button type="submit">Send reset link</button></p></form>`}
        <p class="small"><a href="/login">Back to log in</a></p></div>`
      )
    )
  );

  router.post('/forgot', async (request) => {
    guards.checkForm(context, request);
    if (!forgotLimiter.take(request.ip)) throw new HttpError(429, 'Too many reset requests. Try again in an hour.');
    const user = context.store.userByEmail(field(request, 'email', 200).toLowerCase());

    // The same answer whether or not the account exists.
    if (user) {
      const token = randomSecret(32);
      context.store.createPasswordReset(user.id, sha256(token));
      await sendEmail(
        {
          to: user.email,
          subject: 'Reset your Qyntra password',
          text: `Someone asked to reset the password for ${user.email}.\n\nReset it here (works once, for one hour):\n${context.baseUrl}/reset?token=${token}\n\nIf it was not you, ignore this email; your password is unchanged.`,
        },
        context.secure
      );
    }

    return redirect('/forgot?ok=1');
  });

  const resetForm = (token: string, error?: string) =>
    htmlResponse(
      layout(
        { title: 'Choose a new password', flash: error ? { kind: 'error', text: error } : undefined },
        html`<div class="card" style="max-width:460px;margin:2rem auto"><h1>Choose a new password</h1>
        <form method="post" action="/reset"><input type="hidden" name="token" value="${token}">
          <label for="password">New password</label><input id="password" name="password" type="password" required minlength="10" autocomplete="new-password">
          <p><button type="submit">Save and log in</button></p></form></div>`
      ),
      error ? 422 : 200
    );

  router.get('/reset', (request) => {
    const token = request.url.searchParams.get('token') ?? '';
    if (!context.store.usePasswordReset(sha256(token), true)) {
      return redirect(`/login?error=${encodeURIComponent('That reset link has expired or was already used.')}`);
    }
    return resetForm(token);
  });

  router.post('/reset', (request) => {
    guards.checkForm(context, request);
    const token = field(request, 'token', 200);
    const password = typeof request.body.password === 'string' ? request.body.password : '';
    const userId = context.store.usePasswordReset(sha256(token), true);
    const user = userId ? context.store.userById(userId) : undefined;

    if (!user) return redirect(`/login?error=${encodeURIComponent('That reset link has expired or was already used.')}`);

    const problem = passwordProblem(password, user.email);
    if (problem) return resetForm(token, problem);

    context.store.usePasswordReset(sha256(token));
    context.store.setPassword(user.id, hashPassword(password));
    // A reset ends every other session: the old password may be why.
    context.store.deleteSessionsForUser(user.id);

    return redirect(`/login?ok=${encodeURIComponent('Password changed. Log in with the new one.')}`);
  });

  // ------------------------------------------------
  // ACCOUNT
  // ------------------------------------------------

  router.get('/account', (request) => {
    const session = guards.requireSession(context, request);
    const orgs = context.store.orgsForUser(session.user.id);

    return guards.page(
      context,
      request,
      'Your account',
      html`<h1>Your account</h1>
      <div class="card"><h2 style="margin-top:0">Profile</h2>
        <form method="post" action="/account/name">${csrfField(session.csrf)}
          <label for="name">Name</label><input id="name" name="name" type="text" value="${session.user.name}" required>
          <p class="small muted">Email: ${session.user.email}</p><p><button type="submit">Save</button></p></form></div>
      <div class="card"><h2 style="margin-top:0">Password</h2>
        <form method="post" action="/account/password">${csrfField(session.csrf)}
          <label for="current">Current password</label><input id="current" name="current" type="password" required autocomplete="current-password">
          <label for="password">New password</label><input id="password" name="password" type="password" required minlength="10" autocomplete="new-password">
          <p class="small muted">Changing it signs you out everywhere else.</p><p><button type="submit">Change password</button></p></form></div>
      <div class="card"><h2 style="margin-top:0">Sessions</h2>
        <form method="post" action="/account/sessions">${csrfField(session.csrf)}<button class="secondary" type="submit">Sign out of every device</button></form></div>
      <div class="card"><h2 style="margin-top:0">Organizations</h2>
        <ul>${orgs.map((org) => html`<li><a href="/o/${org.slug}">${org.name}</a> — ${org.role}</li>`)}</ul></div>
      <div class="card"><h2 style="margin-top:0">Delete your account</h2>
        <p>Organizations where you are the only member are deleted with it, including all their data.</p>
        <form method="post" action="/account/delete">${csrfField(session.csrf)}
          <label for="confirm">Type your email to confirm</label><input id="confirm" name="confirm" type="email">
          <p><button class="danger" type="submit">Delete my account</button></p></form></div>`,
      { session, orgSlug: orgs[0]?.slug }
    );
  });

  router.post('/account/name', (request) => {
    const session = guards.requireSession(context, request);
    guards.checkForm(context, request, session);
    const name = field(request, 'name', 100);
    if (name) context.store.renameUser(session.user.id, name);
    return redirect(`/account?ok=${encodeURIComponent('Saved.')}`);
  });

  router.post('/account/password', (request) => {
    const session = guards.requireSession(context, request);
    guards.checkForm(context, request, session);

    const current = typeof request.body.current === 'string' ? request.body.current : '';
    const password = typeof request.body.password === 'string' ? request.body.password : '';

    if (!verifyPassword(current, context.store.passwordHash(session.user.id) ?? '')) {
      return redirect(`/account?error=${encodeURIComponent('The current password is not right.')}`);
    }

    const problem = passwordProblem(password, session.user.email);
    if (problem) return redirect(`/account?error=${encodeURIComponent(problem)}`);

    context.store.setPassword(session.user.id, hashPassword(password));
    context.store.deleteSessionsForUser(session.user.id);

    // Keep this device signed in with a fresh session.
    const fresh = randomSecret(32);
    context.store.createSession(sha256(fresh), session.user.id, new Date(Date.now() + 30 * 86_400_000).toISOString());
    return redirect(`/account?ok=${encodeURIComponent('Password changed. Other devices were signed out.')}`, { 'set-cookie': sessionCookie(fresh, context.secure) });
  });

  router.post('/account/sessions', (request) => {
    const session = guards.requireSession(context, request);
    guards.checkForm(context, request, session);
    context.store.deleteSessionsForUser(session.user.id);
    return redirect(`/login?ok=${encodeURIComponent('Signed out of every device.')}`, { 'set-cookie': sessionCookie('', context.secure, 0) });
  });

  router.post('/account/delete', (request) => {
    const session = guards.requireSession(context, request);
    guards.checkForm(context, request, session);

    if (field(request, 'confirm', 200).toLowerCase() !== session.user.email.toLowerCase()) {
      return redirect(`/account?error=${encodeURIComponent('The email did not match; nothing was deleted.')}`);
    }

    const result = context.store.deleteUser(session.user.id);
    if (!result.ok) return redirect(`/account?error=${encodeURIComponent(result.reason)}`);

    return redirect(`/?ok=${encodeURIComponent('Your account was deleted.')}`, { 'set-cookie': sessionCookie('', context.secure, 0) });
  });

  // ------------------------------------------------
  // ROLES
  // ------------------------------------------------

  router.post('/o/:org/members/:user/role', (request) => {
    const { session, org } = guards.requireOrg(context, request, 'owner');
    guards.checkForm(context, request, session);

    const role = (ROLES as readonly string[]).includes(field(request, 'role')) ? (field(request, 'role') as Role) : undefined;
    const member = context.store.members(org.id).find((candidate) => candidate.id === request.params.user);

    if (!role || !member) throw new HttpError(400, 'Unknown member or role.');

    const owners = context.store.members(org.id).filter((candidate) => candidate.role === 'owner');
    if (member.role === 'owner' && role !== 'owner' && owners.length === 1) {
      return redirect(`/o/${org.slug}/members?error=${encodeURIComponent('An organization needs at least one owner.')}`);
    }

    context.store.setRole(org.id, member.id, role);
    context.store.audit(org.id, session.user.email, 'member.role', `${member.email} → ${role}`);
    return redirect(`/o/${org.slug}/members?ok=${encodeURIComponent(`${member.email} is now ${role}.`)}`);
  });

  // ------------------------------------------------
  // OPERATOR CONSOLE
  // ------------------------------------------------

  const requireOperator = (request: Request) => {
    const session = guards.requireSession(context, request);
    if (!isOperator(session.user.email)) throw new HttpError(404, 'Not found.');
    return session;
  };

  router.get('/admin', (request) => {
    const session = requireOperator(request);
    const orgs = context.store.allOrgs();

    return guards.page(
      context,
      request,
      'Operator console',
      html`<h1>Operator console</h1>
      <p class="muted">${orgs.length} organization(s) · ${orgs.filter((org) => org.plan !== 'free').length} on a paid or granted plan · ${orgs.reduce((total, org) => total + org.runsThisMonth, 0)} runs this month</p>
      <table><thead><tr><th>Organization</th><th>Created</th><th>Projects</th><th>Members</th><th>Runs this month</th><th>Plan</th><th>Design partner</th></tr></thead><tbody>
      ${orgs.map(
        (org) => html`<tr><td>${org.name}<div class="small muted">${org.slug}</div></td><td>${org.createdAt.slice(0, 10)}</td><td>${org.projects}</td><td>${org.members}</td><td>${org.runsThisMonth}</td>
          <td><form class="inline" method="post" action="/admin/orgs/${org.id}/plan">${csrfField(session.csrf)}
            <select name="plan">${Object.keys(PLANS).map((plan) => html`<option value="${plan}" ${plan === org.plan ? 'selected' : ''}>${PLANS[plan].name}</option>`)}</select>
            <button class="secondary" type="submit">Set</button></form></td>
          <td>${org.plan === 'partner'
            ? html`<span class="badge ok">paying</span>`
            : html`<form class="inline" method="post" action="/admin/orgs/${org.id}/offer">${csrfField(session.csrf)}
              <input type="hidden" name="offer" value="${org.offeredPlan === 'partner' ? '' : 'partner'}">
              <button class="secondary" type="submit">${org.offeredPlan === 'partner' ? 'Withdraw offer' : 'Offer'}</button></form>`}</td></tr>`
      )}</tbody></table>`,
      { session }
    );
  });

  // Puts the hidden design-partner plan on this org's billing page, where
  // its owner pays by card. Granting it free is "Set" above.
  router.post('/admin/orgs/:id/offer', (request) => {
    const session = requireOperator(request);
    guards.checkForm(context, request, session);

    const offer = field(request, 'offer');
    const org = context.store.orgById(request.params.id);
    if (!org || (offer !== '' && !PLANS[offer]?.hidden)) throw new HttpError(400, 'Unknown organization or offer.');

    context.store.offerPlan(org.id, offer || undefined);
    context.store.audit(org.id, `operator:${session.user.email}`, offer ? 'billing.plan_offered' : 'billing.offer_withdrawn', offer || 'none');

    return redirect(
      `/admin?ok=${encodeURIComponent(offer ? `${org.name} can now start the ${PLANS[offer].name} plan from its billing page.` : `Offer to ${org.name} withdrawn.`)}`
    );
  });

  router.post('/admin/orgs/:id/plan', (request) => {
    const session = requireOperator(request);
    guards.checkForm(context, request, session);

    const plan = field(request, 'plan');
    const org = context.store.orgById(request.params.id);
    if (!org || !PLANS[plan]) throw new HttpError(400, 'Unknown organization or plan.');

    context.store.setPlan(org.id, plan);
    context.store.audit(org.id, `operator:${session.user.email}`, 'billing.plan_set', plan);
    return redirect(`/admin?ok=${encodeURIComponent(`${org.name} is now on ${PLANS[plan].name}.`)}`);
  });
}
