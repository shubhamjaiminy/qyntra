/**
 * Release outcomes from git history, so the track record fills itself.
 *
 * For each commit the gate judged on the release branch:
 *
 *   rollback   a later commit says "This reverts commit <sha>"
 *   hotfix     a hotfix branch was merged within the window after it
 *   ok         the window passed with neither
 *   (pending)  too recent to tell — nothing is recorded yet
 *
 * Deliberately conservative: it only ever claims what git shows. An
 * incident that never touched git (a config change, a data fix) is not
 * detected; `qyntra outcome --result incident` records those by hand,
 * and an outcome recorded by hand is never overwritten.
 */

import { execFileSync } from 'child_process';

import type { ReleaseOutcome } from './release-outcomes';
import type { RunHistoryEntry } from './run-history';

export const OUTCOME_WINDOW_HOURS = 72;

export interface GitCommit {
  sha: string;
  date: string;
  subject: string;
  body: string;
}

export interface DetectedOutcome {
  commit: string;
  result: 'ok' | 'rollback' | 'hotfix';
  occurredAt: string;
  evidence: string;
}

const HOTFIX = /hot-?fix/i;

/** Commits in the last `days` days, newest first, merges included. */
export function readGitLog(rootDir: string, days: number): GitCommit[] {
  const output = execFileSync('git', ['log', `--since=${days}.days`, '--format=%H%x1f%cI%x1f%s%x1f%b%x1e'], {
    cwd: rootDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });

  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, date, subject, body] = record.split('\x1f');
      return { sha, date, subject: subject ?? '', body: body ?? '' };
    });
}

/** The branch releases are cut from: origin's default, else main or master. */
export function releaseBranch(rootDir: string): string {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: rootDir, encoding: 'utf-8' })
      .trim()
      .replace(/^origin\//, '');
  } catch {
    try {
      execFileSync('git', ['rev-parse', '--verify', 'main'], { cwd: rootDir, stdio: 'ignore' });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

export function detectOutcomes(input: {
  commits: GitCommit[];
  runs: RunHistoryEntry[];
  existing: ReleaseOutcome[];
  branch: string;
  now?: Date;
  windowHours?: number;
}): { detected: DetectedOutcome[]; pending: string[] } {
  const now = (input.now ?? new Date()).getTime();
  const windowMs = (input.windowHours ?? OUTCOME_WINDOW_HOURS) * 3_600_000;
  const detected: DetectedOutcome[] = [];
  const pending: string[] = [];
  const seen = new Set<string>();

  const judged = input.runs.filter((run) => run.git?.commit && (!run.git.branch || run.git.branch === input.branch));

  // When each judged release landed, to blame a hotfix on the right one.
  const releaseTimes = judged
    .map((run) => input.commits.find((commit) => sameSha(commit.sha, run.git!.commit!)))
    .filter((commit): commit is GitCommit => commit !== undefined)
    .map((commit) => Date.parse(commit.date));

  for (const run of judged) {
    const sha = run.git!.commit!;
    if (seen.has(sha)) continue;
    seen.add(sha);

    // Recorded by a person, or already detected: theirs stands.
    if (input.existing.some((outcome) => sameSha(outcome.commit, sha))) continue;

    const released = input.commits.find((commit) => sameSha(commit.sha, sha));
    if (!released) continue;

    const releasedAt = Date.parse(released.date);
    const after = input.commits.filter((commit) => Date.parse(commit.date) > releasedAt);

    const revert = after.find((commit) => {
      const reverted = /This reverts commit ([0-9a-f]{7,40})/i.exec(commit.body)?.[1];
      return reverted !== undefined && sameSha(reverted, released.sha);
    });

    if (revert) {
      detected.push({ commit: released.sha, result: 'rollback', occurredAt: revert.date, evidence: `reverted by ${revert.sha.slice(0, 7)} "${revert.subject}"` });
      continue;
    }

    // A hotfix belongs to the latest release before it: that one shipped
    // whatever needed fixing, not every release in the window.
    const hotfix = after.find((commit) => {
      const at = Date.parse(commit.date);
      const later = releaseTimes.some((time) => time > releasedAt && time < at);
      return at - releasedAt <= windowMs && !later && HOTFIX.test(`${commit.subject}\n${commit.body}`);
    });

    if (hotfix) {
      detected.push({ commit: released.sha, result: 'hotfix', occurredAt: hotfix.date, evidence: `hotfix ${hotfix.sha.slice(0, 7)} "${hotfix.subject}" within ${input.windowHours ?? OUTCOME_WINDOW_HOURS}h` });
      continue;
    }

    if (now - releasedAt >= windowMs) {
      detected.push({
        commit: released.sha,
        result: 'ok',
        occurredAt: new Date(releasedAt + windowMs).toISOString(),
        evidence: `no revert or hotfix within ${input.windowHours ?? OUTCOME_WINDOW_HOURS}h`,
      });
    } else {
      pending.push(released.sha);
    }
  }

  return { detected, pending };
}
