/**
 * Alerts: post to a project's Slack channel when a release is blocked.
 *
 * Only https://hooks.slack.com/ URLs are accepted. Letting customers
 * enter any URL would turn the server into a proxy for requests to
 * internal addresses (SSRF).
 */

import type { UploadPayload } from '../scripts/lib/cloud-upload';
import type { Org, Project, Store } from './db';
import { field, html, redirect, type Router } from './http';
import { csrfField } from './views';
import { guards } from './web';

export const ALERT_ON = ['unsafe', 'any-risk', 'never'] as const;

export function validSlackWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'hooks.slack.com' && parsed.pathname.startsWith('/services/');
  } catch {
    return false;
  }
}

export function shouldAlert(alertOn: string, verdict: string): boolean {
  if (alertOn === 'never') return false;
  if (alertOn === 'any-risk') return verdict !== 'SAFE';
  return verdict === 'UNSAFE';
}

export function slackMessage(event: { org: Org; project: Project; payload: UploadPayload; url: string }): Record<string, unknown> {
  const { payload } = event;
  const where = [payload.source?.branch, payload.source?.pullRequest ? `PR #${payload.source.pullRequest}` : '', payload.source?.commit?.slice(0, 7)].filter(Boolean).join(' · ');
  const reasons = (payload.reasons?.blocking ?? []).slice(0, 3).map((reason) => `• ${reason}`).join('\n');

  return {
    text: `Qyntra: ${event.project.name} is ${payload.decision.verdict.replace(/_/g, ' ')} (score ${payload.decision.qualityScore})${where ? ` — ${where}` : ''}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${event.project.name}* — *${payload.decision.verdict.replace(/_/g, ' ')}*, quality score ${payload.decision.qualityScore}${where ? `\n${where}` : ''}` } },
      ...(reasons ? [{ type: 'section', text: { type: 'mrkdwn', text: reasons } }] : []),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Qyntra' }, url: event.url }] },
    ],
  };
}

export function integrations(store: Store) {
  return {
    async onRun(event: { org: Org; project: Project; runId: string; payload: UploadPayload; url: string }): Promise<void> {
      const settings = store.integrations(event.project.id);

      if (!settings.slackWebhookUrl || !shouldAlert(settings.alertOn, event.payload.decision.verdict)) return;

      await fetch(settings.slackWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(slackMessage(event)),
        signal: AbortSignal.timeout(10_000),
      }).catch((error) => console.error('slack alert failed', event.project.id, String(error)));
    },
  };
}

export function integrationRoutes(router: Router, context: { store: Store; secret: string; baseUrl: string; secure: boolean }): void {
  router.get('/o/:org/p/:project/integrations', (request) => {
    const { session, org, project } = guards.requireProject(context, request);
    const settings = context.store.integrations(project.id);
    const canEdit = guards.ROLE_RANK[org.role] >= guards.ROLE_RANK.admin;

    return guards.page(
      context,
      request,
      `${project.name} alerts`,
      html`<p class="small"><a href="/o/${org.slug}">${org.name}</a> /</p><h1>${project.name}</h1>
      ${guards.tabs(org, project, 'integrations')}
      <h2>Slack</h2>
      <p>Post to a channel when a release is blocked. Create an <a href="https://api.slack.com/messaging/webhooks">incoming webhook</a> in Slack and paste its URL.</p>
      ${canEdit
        ? html`<form method="post" action="/o/${org.slug}/p/${project.slug}/integrations">${csrfField(session.csrf)}
          <label for="slack">Webhook URL</label><input id="slack" name="slack" type="text" placeholder="https://hooks.slack.com/services/…" value="${settings.slackWebhookUrl ? `${settings.slackWebhookUrl.slice(0, 38)}…` : ''}">
          <label for="alertOn">Alert when</label>
          <select id="alertOn" name="alertOn">
            <option value="unsafe" ${settings.alertOn === 'unsafe' ? 'selected' : ''}>a release is UNSAFE</option>
            <option value="any-risk" ${settings.alertOn === 'any-risk' ? 'selected' : ''}>a release is UNSAFE or SAFE WITH RISK</option>
            <option value="never" ${settings.alertOn === 'never' ? 'selected' : ''}>never</option>
          </select>
          <p class="small muted">Leave the URL unchanged to keep the current one; clear it to remove it.</p>
          <p><button type="submit">Save</button></p></form>`
        : html`<p class="muted">${settings.slackWebhookUrl ? 'Slack alerts are on.' : 'Slack alerts are off.'} Ask an admin to change them.</p>`}
      <h2>GitHub pull requests</h2>
      <p>In GitHub Actions, <code>qyntra gate</code> comments the decision on the pull request when the job has <code>pull-requests: write</code> permission and <code>GITHUB_TOKEN</code> in its environment. No app to install.</p>`,
      { session, orgSlug: org.slug }
    );
  });

  router.post('/o/:org/p/:project/integrations', (request) => {
    const { session, org, project } = guards.requireProject(context, request, 'admin');
    guards.checkForm(context, request, session);

    const current = context.store.integrations(project.id);
    const submitted = field(request, 'slack', 500);
    const alertOn = (ALERT_ON as readonly string[]).includes(field(request, 'alertOn')) ? field(request, 'alertOn') : 'unsafe';

    // The form shows a truncated URL; submitting it unchanged keeps the stored one.
    const keep = current.slackWebhookUrl && submitted.endsWith('…') && current.slackWebhookUrl.startsWith(submitted.slice(0, -1));
    const slackWebhookUrl = submitted === '' ? null : keep ? current.slackWebhookUrl! : submitted;

    if (slackWebhookUrl && !validSlackWebhook(slackWebhookUrl)) {
      return redirect(`/o/${org.slug}/p/${project.slug}/integrations?error=${encodeURIComponent('That is not a Slack incoming-webhook URL (https://hooks.slack.com/services/…).')}`);
    }

    context.store.setIntegrations(org.id, project.id, { slackWebhookUrl, alertOn });
    context.store.audit(org.id, session.user.email, 'integrations.updated', `${project.name}: slack ${slackWebhookUrl ? 'on' : 'off'}, alert on ${alertOn}`);

    return redirect(`/o/${org.slug}/p/${project.slug}/integrations?ok=${encodeURIComponent('Saved.')}`);
  });
}
