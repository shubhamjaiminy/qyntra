/**
 * Talking to Qyntra Cloud from the CLI.
 *
 * Active only when all three are present: cloud.url (or
 * QYNTRA_CLOUD_URL), cloud.project, and the QYNTRA_TOKEN secret. Every
 * call has a timeout and one retry, and none of them throws: an upload
 * that fails is a warning in the CI log, never a failed job and never a
 * different release decision.
 */

import type { QyntraConfig } from './config';
import type { FeatureUploadPayload, UploadPayload } from './cloud-upload';
import type { RunHistory, RunHistoryEntry } from './run-history';

export const TOKEN_ENV = 'QYNTRA_TOKEN';

export interface CloudTarget {
  url: string;
  project: string;
  token: string;
}

export interface CloudResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  body?: T;
  error?: string;
}

/** Why the cloud is off, for doctor and `upload`, or the target. */
export function cloudTarget(config: QyntraConfig, env: NodeJS.ProcessEnv = process.env): CloudTarget | { missing: string[] } {
  const url = (env.QYNTRA_CLOUD_URL ?? config.cloud.url ?? '').replace(/\/+$/, '');
  const token = env[TOKEN_ENV] ?? '';
  const missing = [
    ...(url ? [] : ['cloud.url (or QYNTRA_CLOUD_URL)']),
    ...(config.cloud.project ? [] : ['cloud.project']),
    ...(token ? [] : [`${TOKEN_ENV}`]),
  ];

  return missing.length > 0 ? { missing } : { url, project: config.cloud.project!, token };
}

export const isTarget = (value: ReturnType<typeof cloudTarget>): value is CloudTarget => !('missing' in value);

async function call<T>(target: CloudTarget, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<CloudResult<T>> {
  let last: CloudResult<T> = { ok: false, status: 0, error: 'not attempted' };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${target.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${target.token}`,
          'user-agent': 'qyntra-cli',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const parsed = (await response.json().catch(() => undefined)) as (T & { error?: string }) | undefined;

      last = response.ok
        ? { ok: true, status: response.status, body: parsed }
        : { ok: false, status: response.status, body: parsed, error: parsed?.error ?? `HTTP ${response.status}` };

      // Only server errors are worth a second try; 4xx will repeat.
      if (response.ok || response.status < 500) return last;
    } catch (error) {
      last = { ok: false, status: 0, error: `${(error as Error)?.name === 'TimeoutError' ? 'timed out' : (error as Error)?.message ?? error}` };
    }

    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  return last;
}

export const ping = (target: CloudTarget) =>
  call<{ ok: boolean; org: string; project: string; uploadLevel: string; plan: string }>(target, 'GET', '/v1/ping', undefined, 8_000);

export const sendRun = (target: CloudTarget, payload: UploadPayload) => call<{ url: string; run: string }>(target, 'POST', '/v1/runs', payload);

export const sendFeatureReport = (target: CloudTarget, payload: FeatureUploadPayload) =>
  call<{ url: string; report: string }>(target, 'POST', '/v1/feature-reports', payload);

export const sendOutcome = (target: CloudTarget, outcome: { commit: string; result: string; severity?: string; area?: string; occurredAt: string }) =>
  call(target, 'POST', '/v1/outcomes', outcome);

export async function fetchHistory(target: CloudTarget, branch: string | undefined, limit: number): Promise<CloudResult<{ runs: RunHistoryEntry[] }>> {
  const query = new URLSearchParams({ limit: String(limit), ...(branch ? { branch } : {}) });
  return call<{ runs: RunHistoryEntry[] }>(target, 'GET', `/v1/history?${query}`);
}

/**
 * Local history plus the cloud's, one entry per run, oldest first,
 * capped. The cloud fills in what an ephemeral CI workspace forgot; a
 * local entry wins when both have the same run.
 */
export function mergeHistory(local: RunHistory, remote: RunHistoryEntry[], maxRuns: number): RunHistory {
  const byId = new Map<string, RunHistoryEntry>();

  for (const entry of remote) byId.set(entry.runId, entry);
  for (const entry of local.runs) byId.set(entry.runId, entry);

  const runs = [...byId.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-maxRuns);

  return { ...local, runs };
}
