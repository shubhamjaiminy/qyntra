/**
 * Qyntra Cloud ingest API, called by the CLI from customers' CI.
 *
 *   GET  /v1/ping       token check, for `qyntra doctor`
 *   POST /v1/runs       one run's results, idempotent on runId
 *   GET  /v1/history    recent runs as run-history entries, for cloud.history
 *   POST /v1/outcomes   what happened after a release
 *
 * Authentication is a project token (Authorization: Bearer qy_live_…).
 * The server enforces the project's upload level as well as the CLI:
 * a payload richer than the project allows is refused, not trimmed, so a
 * misconfigured CI job cannot quietly send more than the customer chose.
 */

import { OUTCOME_RESULTS, OUTCOME_SEVERITIES } from '../scripts/lib/release-outcomes';
import { UPLOAD_LEVELS, type UploadLevel, type UploadPayload } from '../scripts/lib/cloud-upload';
import type { RunHistoryEntry } from '../scripts/lib/run-history';
import type { Org, Project, Store } from './db';
import { HttpError, jsonResponse, type Request, type Response, type Router } from './http';
import { limitProblem } from './plans';
import { RateLimiter, sha256 } from './security';

export interface ApiContext {
  store: Store;
  baseUrl: string;
  /** Called after a run is stored: alerts, PR comments. */
  onRun?: (event: { org: Org; project: Project; runId: string; payload: UploadPayload; url: string }) => void | Promise<void>;
}

const LEVEL_RANK: Record<UploadLevel, number> = { metrics: 0, standard: 1, full: 2 };

const limiters = new WeakMap<Store, RateLimiter>();

export function authenticateToken(context: ApiContext, request: Request): Project & { org: Org } {
  const header = String(request.headers.authorization ?? '');
  const token = /^Bearer\s+(qy_live_[A-Za-z0-9_-]+)$/.exec(header)?.[1];

  if (!token) {
    throw new HttpError(401, 'Missing or malformed token. Send Authorization: Bearer qy_live_… from QYNTRA_TOKEN.');
  }

  const hash = sha256(token);

  let limiter = limiters.get(context.store);
  if (!limiter) limiters.set(context.store, (limiter = new RateLimiter(240, 60_000)));

  if (!limiter.take(hash)) {
    throw new HttpError(429, 'Too many requests for this token; retry in a minute.');
  }

  const project = context.store.projectForToken(hash);

  if (!project) {
    throw new HttpError(401, 'Token not recognised or revoked. Create a new one in Project settings.');
  }

  return project;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, max = 500) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/** Validate an upload. Throws 400/422 with a message the CLI prints. */
export function validatePayload(body: Record<string, unknown>, project: Project): UploadPayload {
  if (body.payloadVersion !== 1) {
    throw new HttpError(400, `Unsupported payloadVersion ${String(body.payloadVersion)}; update Qyntra.`);
  }

  const level = body.level as UploadLevel;

  if (!UPLOAD_LEVELS.includes(level)) {
    throw new HttpError(400, `level must be one of: ${UPLOAD_LEVELS.join(', ')}`);
  }

  const allowed = (UPLOAD_LEVELS as readonly string[]).includes(project.uploadLevel) ? (project.uploadLevel as UploadLevel) : 'standard';

  if (LEVEL_RANK[level] > LEVEL_RANK[allowed]) {
    throw new HttpError(
      422,
      `This project accepts uploads up to "${allowed}", but the CLI sent "${level}". Lower cloud.upload in .qyntra/config.json, or raise the project's level in its settings.`
    );
  }

  const decision = body.decision as Record<string, unknown> | undefined;

  if (!decision || typeof decision.verdict !== 'string' || !isNumber(decision.qualityScore) || typeof decision.execution !== 'object') {
    throw new HttpError(400, 'decision.verdict, decision.qualityScore and decision.execution are required.');
  }

  const execution = decision.execution as Record<string, unknown>;

  for (const key of ['total', 'passed', 'failed', 'skipped']) {
    if (!isNumber(execution[key])) throw new HttpError(400, `decision.execution.${key} must be a number.`);
  }

  if (typeof body.runId !== 'string' || body.runId === '' || body.runId.length > 200) {
    throw new HttpError(400, 'runId is required (at most 200 characters).');
  }

  // Fields beyond the declared level must not be there at all.
  if (level === 'metrics' && (body.tests || body.source || body.reasons)) {
    throw new HttpError(422, 'A "metrics" upload must not contain tests, source or reasons.');
  }

  if (level !== 'full' && (body.diagnoses || body.repairs)) {
    throw new HttpError(422, `A "${level}" upload must not contain diagnoses or repairs.`);
  }

  return body as unknown as UploadPayload;
}

function ingestRun(context: ApiContext, request: Request): Response {
  const project = authenticateToken(context, request);
  const payload = validatePayload(request.body, project);

  const problem = limitProblem(project.org.plan, { runsThisMonth: context.store.runsThisMonth(project.org.id) }, 'run');
  if (problem) throw new HttpError(402, problem);

  const tests = (Array.isArray(payload.tests) ? payload.tests : [])
    .slice(0, 5_000)
    .filter((test) => typeof test?.name === 'string' && ['passed', 'failed', 'skipped'].includes(test.status))
    .map((test) => ({
      name: test.name.slice(0, 300),
      status: test.status,
      category: text(test.category, 80),
      severity: text(test.severity, 20),
      productDefect: test.productDefect,
      testDefect: test.testDefect,
    }));

  const { decision } = payload;

  const stored = context.store.upsertRun(project.id, {
    runKey: payload.runId,
    commit: text(payload.source?.commit, 64),
    branch: text(payload.source?.branch, 200),
    pullRequest: isNumber(payload.source?.pullRequest) ? payload.source!.pullRequest : undefined,
    verdict: decision.verdict.slice(0, 40),
    qualityScore: Math.round(decision.qualityScore),
    confidence: text(decision.confidence, 20) ?? 'Unknown',
    total: decision.execution.total,
    passed: decision.execution.passed,
    failed: decision.execution.failed,
    skipped: decision.execution.skipped,
    riskLevel: text(decision.risk?.level, 20),
    aiProvider: text(payload.aiProvider, 100),
    level: payload.level,
    decidedAt: text(payload.decidedAt, 40),
    payload: JSON.stringify(payload),
    tests,
  });

  const url = `${context.baseUrl}/o/${project.org.slug}/p/${project.slug}/runs/${stored.id}`;

  void Promise.resolve(context.onRun?.({ org: project.org, project, runId: stored.id, payload, url })).catch(() => undefined);

  return jsonResponse({ ok: true, run: stored.id, created: stored.created, url }, stored.created ? 201 : 200);
}

/** Recent runs in the CLI's run-history shape, oldest first. */
export function historyEntries(store: Store, projectId: string, options: { branch?: string; limit?: number } = {}): RunHistoryEntry[] {
  return store
    .runs(projectId, options)
    .reverse()
    .map((run) => {
      const payload = JSON.parse(run.payload) as UploadPayload;

      return {
        runId: run.run_key,
        timestamp: run.decided_at ?? run.received_at,
        git: { ...(run.commit_sha ? { commit: run.commit_sha } : {}), ...(run.branch ? { branch: run.branch } : {}) },
        execution: { total: run.total, passed: run.passed, failed: run.failed, skipped: run.skipped },
        verdict: run.verdict,
        qualityScore: run.quality_score,
        risk: { level: run.risk_level ?? 'UNKNOWN', score: payload.decision?.risk?.score ?? 0 },
        tests: store.runTests(run.id).map((test) => ({ test: test.name, status: test.status as 'passed' | 'failed' | 'skipped' })),
      };
    });
}

function history(context: ApiContext, request: Request): Response {
  const project = authenticateToken(context, request);
  const branch = request.url.searchParams.get('branch') ?? undefined;
  const limit = Number(request.url.searchParams.get('limit') ?? 50);

  return jsonResponse({ version: 1, runs: historyEntries(context.store, project.id, { branch, limit: Number.isFinite(limit) ? limit : 50 }) });
}

function recordOutcome(context: ApiContext, request: Request): Response {
  const project = authenticateToken(context, request);
  const { commit, result, severity, area, occurredAt } = request.body as Record<string, unknown>;

  if (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(commit)) {
    throw new HttpError(400, 'commit must be a git SHA (7 to 64 hex characters).');
  }

  if (!(OUTCOME_RESULTS as readonly unknown[]).includes(result)) {
    throw new HttpError(400, `result must be one of: ${OUTCOME_RESULTS.join(', ')}`);
  }

  if (severity !== undefined && !(OUTCOME_SEVERITIES as readonly unknown[]).includes(severity)) {
    throw new HttpError(400, `severity must be one of: ${OUTCOME_SEVERITIES.join(', ')}`);
  }

  const when = typeof occurredAt === 'string' && !Number.isNaN(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : new Date().toISOString();

  context.store.upsertOutcome(project.id, {
    commit: commit.toLowerCase(),
    result: result as string,
    severity: severity as string | undefined,
    area: text(area, 100),
    source: 'cli',
    occurredAt: when,
  });

  return jsonResponse({ ok: true }, 201);
}

export function apiRoutes(router: Router, context: ApiContext): void {
  router.get('/v1/ping', (request) => {
    const project = authenticateToken(context, request);
    return jsonResponse({ ok: true, org: project.org.slug, project: project.slug, uploadLevel: project.uploadLevel, plan: project.org.plan });
  });

  router.post('/v1/runs', (request) => ingestRun(context, request));
  router.get('/v1/history', (request) => history(context, request));
  router.post('/v1/outcomes', (request) => recordOutcome(context, request));
}
