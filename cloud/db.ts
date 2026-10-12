/**
 * Qyntra Cloud storage.
 *
 * SQLite through Node's built-in `node:sqlite`: no dependency to
 * install, one file to back up, and fast enough for thousands of
 * customers on one machine. The schema follows docs/saas/ARCHITECTURE.md
 * so moving to Postgres is a driver change, not a redesign.
 *
 * Tenant isolation: SQLite has no row-level security, so every
 * tenant-owned query lives in this module and takes the org (or a
 * project already resolved to an org) as an argument. Nothing outside
 * this file writes SQL.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

// node:sqlite prints an ExperimentalWarning on load; it is noise in a
// server log. Other warnings still print.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(typeof warning === 'string' ? warning : warning.message).includes('SQLite is an experimental')) return;
  return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

type Database = InstanceType<typeof DatabaseSync>;

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

// --------------------------------------------------
// SCHEMA
// --------------------------------------------------

/** Append-only. Each entry runs once, in order, inside a transaction. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE memberships (
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    upload_level TEXT NOT NULL DEFAULT 'standard',
    retention_days INTEGER NOT NULL DEFAULT 395,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, slug)
  );

  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_key TEXT NOT NULL,
    commit_sha TEXT,
    branch TEXT,
    pull_request INTEGER,
    verdict TEXT NOT NULL,
    quality_score INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    total INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    skipped INTEGER NOT NULL,
    risk_level TEXT,
    ai_provider TEXT,
    level TEXT NOT NULL,
    decided_at TEXT,
    received_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (project_id, run_key)
  );
  CREATE INDEX runs_by_project_time ON runs (project_id, received_at DESC);

  CREATE TABLE run_tests (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    category TEXT,
    severity TEXT,
    product_defect INTEGER,
    test_defect INTEGER
  );
  CREATE INDEX run_tests_by_run ON run_tests (run_id);

  CREATE TABLE outcomes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    result TEXT NOT NULL,
    severity TEXT,
    area TEXT,
    source TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (project_id, commit_sha)
  );

  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX audit_by_org_time ON audit_log (org_id, at DESC);
  `,
  `
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT
  );

  CREATE TABLE feature_reports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    report_key TEXT NOT NULL,
    feature TEXT NOT NULL,
    verdict TEXT NOT NULL,
    confidence TEXT NOT NULL,
    bugs INTEGER NOT NULL,
    verified INTEGER NOT NULL,
    findings INTEGER NOT NULL,
    commit_sha TEXT,
    branch TEXT,
    received_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (project_id, report_key)
  );
  CREATE INDEX feature_reports_by_project ON feature_reports (project_id, feature, received_at DESC);
  `,
  `
  ALTER TABLE projects ADD COLUMN slack_webhook_url TEXT;
  ALTER TABLE projects ADD COLUMN alert_on TEXT NOT NULL DEFAULT 'unsafe';
  `,
  `
  CREATE TABLE password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  `,
];

export class Store {
  readonly db: Database;

  constructor(file: string) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }

    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((row) => row.version)
    );

    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;

      this.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, now());
      });
    });
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------
  // ORGS, USERS, MEMBERSHIPS
  // ------------------------------------------------

  createUserWithOrg(input: { email: string; name: string; passwordHash: string; orgName: string }): { user: User; org: Org } {
    return this.transaction(() => {
      const user: User = { id: randomUUID(), email: input.email.trim(), name: input.name.trim(), createdAt: now() };
      this.db
        .prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, user.email, user.name, input.passwordHash, user.createdAt);

      const org = this.insertOrg(input.orgName);
      this.db.prepare('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(org.id, user.id, 'owner', now());
      this.audit(org.id, user.email, 'org.created', org.name);

      return { user, org };
    });
  }

  private insertOrg(name: string): Org {
    const base = slugify(name) || 'org';
    let slug = base;

    for (let attempt = 2; this.db.prepare('SELECT 1 FROM orgs WHERE slug = ?').get(slug); attempt += 1) {
      slug = `${base}-${attempt}`;
    }

    const org: Org = { id: randomUUID(), name: name.trim(), slug, plan: 'free', createdAt: now() };
    this.db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(org.id, org.name, org.slug, org.plan, org.createdAt);
    return org;
  }

  userByEmail(email: string): (User & { passwordHash: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    return row ? { ...toUser(row), passwordHash: row.password_hash } : undefined;
  }

  userById(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  /** The orgs a user belongs to, with their role in each. */
  orgsForUser(userId: string): (Org & { role: Role })[] {
    return (
      this.db
        .prepare('SELECT o.*, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at')
        .all(userId) as unknown as (OrgRow & { role: Role })[]
    ).map((row) => ({ ...toOrg(row), role: row.role }));
  }

  /** The org, only if the user is a member — the check every page makes. */
  orgForMember(userId: string, orgSlug: string): (Org & { role: Role }) | undefined {
    const row = this.db
      .prepare('SELECT o.*, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? AND o.slug = ?')
      .get(userId, orgSlug) as (OrgRow & { role: Role }) | undefined;
    return row ? { ...toOrg(row), role: row.role } : undefined;
  }

  orgById(orgId: string): Org | undefined {
    const row = this.db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId) as OrgRow | undefined;
    return row ? toOrg(row) : undefined;
  }

  setPlan(orgId: string, plan: string, stripe?: { customerId?: string; subscriptionId?: string }): void {
    this.db
      .prepare('UPDATE orgs SET plan = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?')
      .run(plan, stripe?.customerId ?? null, stripe?.subscriptionId ?? null, orgId);
  }

  orgByStripeCustomer(customerId: string): Org | undefined {
    const row = this.db.prepare('SELECT * FROM orgs WHERE stripe_customer_id = ?').get(customerId) as OrgRow | undefined;
    return row ? toOrg(row) : undefined;
  }

  members(orgId: string): (User & { role: Role })[] {
    return (
      this.db
        .prepare('SELECT u.*, m.role FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? ORDER BY m.created_at')
        .all(orgId) as unknown as (UserRow & { role: Role })[]
    ).map((row) => ({ ...toUser(row), role: row.role }));
  }

  addMember(orgId: string, userId: string, role: Role): void {
    this.db.prepare('INSERT OR REPLACE INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(orgId, userId, role, now());
  }

  createUser(input: { email: string; name: string; passwordHash: string }): User {
    const user: User = { id: randomUUID(), email: input.email.trim(), name: input.name.trim(), createdAt: now() };
    this.db
      .prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.email, user.name, input.passwordHash, user.createdAt);
    return user;
  }

  setPassword(userId: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  }

  // ------------------------------------------------
  // SESSIONS
  // ------------------------------------------------

  createSession(idHash: string, userId: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(idHash, userId, expiresAt, now());
  }

  sessionUser(idHash: string): User | undefined {
    const row = this.db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?')
      .get(idHash, now()) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteSessionsForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // ------------------------------------------------
  // PROJECTS AND TOKENS
  // ------------------------------------------------

  createProject(orgId: string, name: string, uploadLevel = 'standard'): Project {
    const base = slugify(name) || 'project';
    let slug = base;

    for (let attempt = 2; this.db.prepare('SELECT 1 FROM projects WHERE org_id = ? AND slug = ?').get(orgId, slug); attempt += 1) {
      slug = `${base}-${attempt}`;
    }

    const project: Project = { id: randomUUID(), orgId, name: name.trim(), slug, uploadLevel, retentionDays: 395, createdAt: now() };
    this.db
      .prepare('INSERT INTO projects (id, org_id, name, slug, upload_level, retention_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, orgId, project.name, slug, uploadLevel, project.retentionDays, project.createdAt);
    return project;
  }

  projects(orgId: string): Project[] {
    return (this.db.prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at').all(orgId) as unknown as ProjectRow[]).map(toProject);
  }

  project(orgId: string, slug: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE org_id = ? AND slug = ?').get(orgId, slug) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  updateProject(orgId: string, projectId: string, changes: { uploadLevel?: string; retentionDays?: number }): void {
    this.db
      .prepare('UPDATE projects SET upload_level = COALESCE(?, upload_level), retention_days = COALESCE(?, retention_days) WHERE id = ? AND org_id = ?')
      .run(changes.uploadLevel ?? null, changes.retentionDays ?? null, projectId, orgId);
  }

  integrations(projectId: string): { slackWebhookUrl?: string; alertOn: string } {
    const row = this.db.prepare('SELECT slack_webhook_url, alert_on FROM projects WHERE id = ?').get(projectId) as
      | { slack_webhook_url: string | null; alert_on: string }
      | undefined;
    return { ...(row?.slack_webhook_url ? { slackWebhookUrl: row.slack_webhook_url } : {}), alertOn: row?.alert_on ?? 'unsafe' };
  }

  setIntegrations(orgId: string, projectId: string, changes: { slackWebhookUrl: string | null; alertOn: string }): void {
    this.db.prepare('UPDATE projects SET slack_webhook_url = ?, alert_on = ? WHERE id = ? AND org_id = ?').run(changes.slackWebhookUrl, changes.alertOn, projectId, orgId);
  }

  deleteProject(orgId: string, projectId: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ? AND org_id = ?').run(projectId, orgId);
  }

  createToken(projectId: string, name: string, tokenHash: string, prefix: string): ApiToken {
    const token: ApiToken = { id: randomUUID(), projectId, name: name.trim() || 'CI', prefix, createdAt: now() };
    this.db
      .prepare('INSERT INTO tokens (id, project_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token.id, projectId, token.name, tokenHash, prefix, token.createdAt);
    return token;
  }

  tokens(projectId: string): ApiToken[] {
    return (
      this.db.prepare('SELECT * FROM tokens WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as unknown as TokenRow[]
    ).map(toToken);
  }

  revokeToken(projectId: string, tokenId: string): void {
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL').run(now(), tokenId, projectId);
  }

  /** The project a live token belongs to, recording its use. */
  projectForToken(tokenHash: string): (Project & { org: Org }) | undefined {
    const row = this.db
      .prepare('SELECT p.*, t.id AS token_id FROM tokens t JOIN projects p ON p.id = t.project_id WHERE t.token_hash = ? AND t.revoked_at IS NULL')
      .get(tokenHash) as (ProjectRow & { token_id: string }) | undefined;

    if (!row) return undefined;

    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now(), row.token_id);
    const org = this.orgById(row.org_id)!;
    return { ...toProject(row), org };
  }

  // ------------------------------------------------
  // RUNS
  // ------------------------------------------------

  /** Insert or replace a run by its key: CI retries must not duplicate it. */
  upsertRun(projectId: string, run: RunInput): { id: string; created: boolean } {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM runs WHERE project_id = ? AND run_key = ?').get(projectId, run.runKey) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();

      if (existing) {
        this.db.prepare('DELETE FROM run_tests WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
      }

      this.db
        .prepare(
          `INSERT INTO runs (id, project_id, run_key, commit_sha, branch, pull_request, verdict, quality_score, confidence,
             total, passed, failed, skipped, risk_level, ai_provider, level, decided_at, received_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id, projectId, run.runKey, run.commit ?? null, run.branch ?? null, run.pullRequest ?? null, run.verdict, run.qualityScore,
          run.confidence, run.total, run.passed, run.failed, run.skipped, run.riskLevel ?? null, run.aiProvider ?? null, run.level,
          run.decidedAt ?? null, now(), run.payload
        );

      const insertTest = this.db.prepare(
        'INSERT INTO run_tests (run_id, name, status, category, severity, product_defect, test_defect) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      for (const test of run.tests) {
        insertTest.run(
          id, test.name, test.status, test.category ?? null, test.severity ?? null,
          test.productDefect === undefined ? null : Number(test.productDefect),
          test.testDefect === undefined ? null : Number(test.testDefect)
        );
      }

      return { id, created: !existing };
    });
  }

  runs(projectId: string, options: { branch?: string; limit?: number } = {}): RunRow[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);

    return (
      options.branch
        ? this.db.prepare('SELECT * FROM runs WHERE project_id = ? AND branch = ? ORDER BY received_at DESC, rowid DESC LIMIT ?').all(projectId, options.branch, limit)
        : this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?').all(projectId, limit)
    ) as unknown as RunRow[];
  }

  run(projectId: string, runId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE project_id = ? AND id = ?').get(projectId, runId) as RunRow | undefined;
  }

  runTests(runId: string): RunTestRow[] {
    return this.db.prepare('SELECT * FROM run_tests WHERE run_id = ? ORDER BY status DESC, name').all(runId) as unknown as RunTestRow[];
  }

  /** Per-test history across the project's recent runs, newest first. */
  testHistory(projectId: string, runLimit = 50): { name: string; statuses: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT t.name, t.status FROM run_tests t
         JOIN (SELECT id, received_at FROM runs WHERE project_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?) r ON r.id = t.run_id
         ORDER BY r.received_at DESC`
      )
      .all(projectId, runLimit) as { name: string; status: string }[];

    const byName = new Map<string, string[]>();
    for (const row of rows) {
      byName.set(row.name, [...(byName.get(row.name) ?? []), row.status]);
    }

    return [...byName.entries()].map(([name, statuses]) => ({ name, statuses }));
  }

  /** Runs plus feature reports this calendar month: what the plan meters. */
  runsThisMonth(orgId: string): number {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);

    const runs = this.db
      .prepare('SELECT COUNT(*) AS count FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.org_id = ? AND r.received_at >= ?')
      .get(orgId, start.toISOString()) as { count: number };
    const reports = this.db
      .prepare('SELECT COUNT(*) AS count FROM feature_reports f JOIN projects p ON p.id = f.project_id WHERE p.org_id = ? AND f.received_at >= ?')
      .get(orgId, start.toISOString()) as { count: number };
    return runs.count + reports.count;
  }

  /** Drop runs and feature reports older than each project's retention. */
  applyRetention(at = new Date()): number {
    const runs = this.db
      .prepare(`DELETE FROM runs WHERE id IN (
         SELECT r.id FROM runs r JOIN projects p ON p.id = r.project_id
         WHERE julianday(?) - julianday(r.received_at) > p.retention_days)`)
      .run(at.toISOString());
    const reports = this.db
      .prepare(`DELETE FROM feature_reports WHERE id IN (
         SELECT f.id FROM feature_reports f JOIN projects p ON p.id = f.project_id
         WHERE julianday(?) - julianday(f.received_at) > p.retention_days)`)
      .run(at.toISOString());
    // Expired sessions, resets and invites are dead weight.
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(at.toISOString());
    this.db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(at.toISOString());
    return Number(runs.changes) + Number(reports.changes);
  }

  // ------------------------------------------------
  // OUTCOMES
  // ------------------------------------------------

  upsertOutcome(projectId: string, outcome: OutcomeInput): void {
    this.db
      .prepare(
        `INSERT INTO outcomes (id, project_id, commit_sha, result, severity, area, source, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, commit_sha) DO UPDATE SET result = excluded.result, severity = excluded.severity,
           area = excluded.area, source = excluded.source, occurred_at = excluded.occurred_at, recorded_at = excluded.recorded_at`
      )
      .run(randomUUID(), projectId, outcome.commit, outcome.result, outcome.severity ?? null, outcome.area ?? null, outcome.source, outcome.occurredAt, now());
  }

  outcomes(projectId: string): OutcomeRow[] {
    return this.db.prepare('SELECT * FROM outcomes WHERE project_id = ? ORDER BY occurred_at DESC').all(projectId) as unknown as OutcomeRow[];
  }

  // ------------------------------------------------
  // ACCOUNTS
  // ------------------------------------------------

  createPasswordReset(userId: string, tokenHash: string): void {
    this.db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    this.db
      .prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), userId, tokenHash, new Date(Date.now() + 3_600_000).toISOString());
  }

  /** The user a live reset token belongs to; using it spends it. */
  usePasswordReset(tokenHash: string, peek = false): string | undefined {
    const row = this.db
      .prepare('SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(tokenHash, now()) as { id: string; user_id: string } | undefined;

    if (row && !peek) this.db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now(), row.id);
    return row?.user_id;
  }

  passwordHash(userId: string): string | undefined {
    return (this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined)?.password_hash;
  }

  renameUser(userId: string, name: string): void {
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), userId);
  }

  /**
   * Delete a user. Orgs where they are the only member go with them; an
   * org they own with other members must be handed over first.
   */
  deleteUser(userId: string): { ok: true } | { ok: false; reason: string } {
    const orgs = this.orgsForUser(userId);

    for (const org of orgs) {
      const members = this.members(org.id);
      if (org.role === 'owner' && members.length > 1 && members.filter((member) => member.role === 'owner').length === 1) {
        return { ok: false, reason: `You are the only owner of ${org.name}, which has other members. Make someone else an owner first.` };
      }
    }

    this.transaction(() => {
      for (const org of orgs) {
        if (this.members(org.id).length === 1) this.deleteOrg(org.id);
      }
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });

    return { ok: true };
  }

  setRole(orgId: string, userId: string, role: Role): void {
    this.db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?').run(role, orgId, userId);
  }

  /** Every org with its size and usage, for the operator console. */
  allOrgs(): { id: string; name: string; slug: string; plan: string; createdAt: string; projects: number; members: number; runsThisMonth: number }[] {
    return (this.db.prepare('SELECT * FROM orgs ORDER BY created_at DESC').all() as unknown as OrgRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: row.plan,
      createdAt: row.created_at,
      projects: (this.db.prepare('SELECT COUNT(*) AS c FROM projects WHERE org_id = ?').get(row.id) as { c: number }).c,
      members: (this.db.prepare('SELECT COUNT(*) AS c FROM memberships WHERE org_id = ?').get(row.id) as { c: number }).c,
      runsThisMonth: this.runsThisMonth(row.id),
    }));
  }

  // ------------------------------------------------
  // INVITES
  // ------------------------------------------------

  createInvite(orgId: string, email: string, role: Role, tokenHash: string, createdBy: string): void {
    this.db
      .prepare('INSERT INTO invites (id, org_id, email, role, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), orgId, email.trim(), role, tokenHash, createdBy, new Date(Date.now() + 7 * 86_400_000).toISOString());
  }

  invite(tokenHash: string): { id: string; orgId: string; email: string; role: Role } | undefined {
    const row = this.db
      .prepare('SELECT id, org_id, email, role FROM invites WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?')
      .get(tokenHash, now()) as { id: string; org_id: string; email: string; role: Role } | undefined;
    return row ? { id: row.id, orgId: row.org_id, email: row.email, role: row.role } : undefined;
  }

  acceptInvite(inviteId: string): void {
    this.db.prepare('UPDATE invites SET accepted_at = ? WHERE id = ?').run(now(), inviteId);
  }

  pendingInvites(orgId: string): { email: string; role: string; expiresAt: string }[] {
    return (
      this.db
        .prepare('SELECT email, role, expires_at FROM invites WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY expires_at')
        .all(orgId, now()) as unknown as { email: string; role: string; expires_at: string }[]
    ).map((row) => ({ email: row.email, role: row.role, expiresAt: row.expires_at }));
  }

  removeMember(orgId: string, userId: string): void {
    this.db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ? AND role != 'owner'").run(orgId, userId);
  }

  // ------------------------------------------------
  // FEATURE REPORTS
  // ------------------------------------------------

  upsertFeatureReport(projectId: string, report: FeatureReportInput): { id: string; created: boolean } {
    const existing = this.db.prepare('SELECT id FROM feature_reports WHERE project_id = ? AND report_key = ?').get(projectId, report.reportKey) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();

    this.db
      .prepare(
        `INSERT INTO feature_reports (id, project_id, report_key, feature, verdict, confidence, bugs, verified, findings, commit_sha, branch, received_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, report_key) DO UPDATE SET feature = excluded.feature, verdict = excluded.verdict,
           confidence = excluded.confidence, bugs = excluded.bugs, verified = excluded.verified, findings = excluded.findings,
           commit_sha = excluded.commit_sha, branch = excluded.branch, received_at = excluded.received_at, payload = excluded.payload`
      )
      .run(
        id, projectId, report.reportKey, report.feature, report.verdict, report.confidence, report.bugs, report.verified,
        report.findings, report.commit ?? null, report.branch ?? null, now(), report.payload
      );

    return { id, created: !existing };
  }

  /** The latest report per feature. */
  latestFeatureReports(projectId: string): FeatureReportRow[] {
    return this.db
      .prepare(
        `SELECT f.* FROM feature_reports f
         JOIN (SELECT feature, MAX(received_at) AS latest FROM feature_reports WHERE project_id = ? GROUP BY feature) l
           ON l.feature = f.feature AND l.latest = f.received_at
         WHERE f.project_id = ? ORDER BY f.bugs DESC, f.feature`
      )
      .all(projectId, projectId) as unknown as FeatureReportRow[];
  }

  featureReport(projectId: string, reportId: string): FeatureReportRow | undefined {
    return this.db.prepare('SELECT * FROM feature_reports WHERE project_id = ? AND id = ?').get(projectId, reportId) as unknown as FeatureReportRow | undefined;
  }

  // ------------------------------------------------
  // AUDIT
  // ------------------------------------------------

  audit(orgId: string, actor: string, action: string, target?: string): void {
    this.db.prepare('INSERT INTO audit_log (id, org_id, actor, action, target, at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), orgId, actor, action, target ?? null, now());
  }

  auditLog(orgId: string, limit = 100): { actor: string; action: string; target: string | null; at: string }[] {
    return this.db.prepare('SELECT actor, action, target, at FROM audit_log WHERE org_id = ? ORDER BY at DESC LIMIT ?').all(orgId, limit) as {
      actor: string;
      action: string;
      target: string | null;
      at: string;
    }[];
  }

  /** Everything an org owns, for self-serve export. */
  exportOrg(orgId: string): Record<string, unknown> {
    const projects = this.projects(orgId);

    return {
      org: this.orgById(orgId),
      members: this.members(orgId),
      projects: projects.map((project) => ({
        ...project,
        tokens: this.tokens(project.id).map(({ id, name, prefix, createdAt, lastUsedAt, revokedAt }) => ({ id, name, prefix, createdAt, lastUsedAt, revokedAt })),
        runs: this.runs(project.id, { limit: 500 }).map((run) => ({ ...run, payload: JSON.parse(run.payload) })),
        outcomes: this.outcomes(project.id),
      })),
      auditLog: this.auditLog(orgId, 1000),
    };
  }

  deleteOrg(orgId: string): void {
    this.db.prepare('DELETE FROM orgs WHERE id = ?').run(orgId);
  }
}

// --------------------------------------------------
// SHAPES
// --------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  uploadLevel: string;
  retentionDays: number;
  createdAt: string;
}

export interface ApiToken {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface RunInput {
  runKey: string;
  commit?: string;
  branch?: string;
  pullRequest?: number;
  verdict: string;
  qualityScore: number;
  confidence: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  riskLevel?: string;
  aiProvider?: string;
  level: string;
  decidedAt?: string;
  payload: string;
  tests: { name: string; status: string; category?: string; severity?: string; productDefect?: boolean; testDefect?: boolean }[];
}

export interface FeatureReportInput {
  reportKey: string;
  feature: string;
  verdict: string;
  confidence: string;
  bugs: number;
  verified: number;
  findings: number;
  commit?: string;
  branch?: string;
  payload: string;
}

export interface FeatureReportRow {
  id: string;
  project_id: string;
  report_key: string;
  feature: string;
  verdict: string;
  confidence: string;
  bugs: number;
  verified: number;
  findings: number;
  commit_sha: string | null;
  branch: string | null;
  received_at: string;
  payload: string;
}

export interface OutcomeInput {
  commit: string;
  result: string;
  severity?: string;
  area?: string;
  source: string;
  occurredAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
}

interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  upload_level: string;
  retention_days: number;
  created_at: string;
}

interface TokenRow {
  id: string;
  project_id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface RunRow {
  id: string;
  project_id: string;
  run_key: string;
  commit_sha: string | null;
  branch: string | null;
  pull_request: number | null;
  verdict: string;
  quality_score: number;
  confidence: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  risk_level: string | null;
  ai_provider: string | null;
  level: string;
  decided_at: string | null;
  received_at: string;
  payload: string;
}

export interface RunTestRow {
  run_id: string;
  name: string;
  status: string;
  category: string | null;
  severity: string | null;
  product_defect: number | null;
  test_defect: number | null;
}

export interface OutcomeRow {
  id: string;
  project_id: string;
  commit_sha: string;
  result: string;
  severity: string | null;
  area: string | null;
  source: string;
  occurred_at: string;
  recorded_at: string;
}

const toUser = (row: UserRow): User => ({ id: row.id, email: row.email, name: row.name, createdAt: row.created_at });

const toOrg = (row: OrgRow): Org => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  plan: row.plan,
  ...(row.stripe_customer_id ? { stripeCustomerId: row.stripe_customer_id } : {}),
  ...(row.stripe_subscription_id ? { stripeSubscriptionId: row.stripe_subscription_id } : {}),
  createdAt: row.created_at,
});

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  slug: row.slug,
  uploadLevel: row.upload_level,
  retentionDays: row.retention_days,
  createdAt: row.created_at,
});

const toToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.created_at,
  ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
});

export function now(): string {
  return new Date().toISOString();
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
