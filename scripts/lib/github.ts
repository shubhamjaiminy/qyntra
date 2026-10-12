/**
 * The release decision as a pull request comment, from GitHub Actions.
 *
 * Uses the job's own GITHUB_TOKEN — no GitHub App to install. Passing
 * the token into the step's environment is the opt-in. One comment per
 * pull request, updated on every run (found by a hidden marker), so a
 * busy PR does not collect a comment per push.
 */

export const COMMENT_MARKER = '<!-- qyntra-release-decision -->';

export interface PullRequestTarget {
  token: string;
  repository: string;
  pullRequest: number;
  api: string;
}

export function pullRequestTarget(env: NodeJS.ProcessEnv, pullRequest: number | undefined): PullRequestTarget | undefined {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY || !pullRequest || env.QYNTRA_PR_COMMENT === '0') {
    return undefined;
  }

  return { token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY, pullRequest, api: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '') };
}

async function github(target: PullRequestTarget, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${target.api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${target.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'qyntra-cli',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Create or update Qyntra's comment. Resolves to a message; never throws. */
export async function upsertComment(target: PullRequestTarget, markdown: string): Promise<{ ok: boolean; message: string }> {
  const body = `${COMMENT_MARKER}\n${markdown}`;
  const base = `/repos/${target.repository}/issues/${target.pullRequest}/comments`;

  try {
    const listed = await github(target, 'GET', `${base}?per_page=100`);

    if (!listed.ok) {
      return { ok: false, message: `GitHub refused to list comments (HTTP ${listed.status}). Give the job "pull-requests: write" permission.` };
    }

    const existing = ((await listed.json()) as { id: number; body?: string }[]).find((comment) => comment.body?.includes(COMMENT_MARKER));

    const response = existing
      ? await github(target, 'PATCH', `/repos/${target.repository}/issues/comments/${existing.id}`, { body })
      : await github(target, 'POST', base, { body });

    return response.ok
      ? { ok: true, message: `${existing ? 'Updated' : 'Posted'} the decision on PR #${target.pullRequest}` }
      : { ok: false, message: `GitHub refused the comment (HTTP ${response.status}). Give the job "pull-requests: write" permission.` };
  } catch (error) {
    return { ok: false, message: `Could not reach GitHub: ${(error as Error)?.message ?? error}` };
  }
}
