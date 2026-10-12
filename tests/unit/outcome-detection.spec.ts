import { test, expect } from '@playwright/test';

import { detectOutcomes, readGitLog, type GitCommit } from '../../scripts/lib/outcome-detection';
import type { RunHistoryEntry } from '../../scripts/lib/run-history';

const NOW = new Date('2026-10-12T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const sha = (char: string) => char.repeat(40);

const run = (commit: string, branch = 'main'): RunHistoryEntry => ({
  runId: commit,
  timestamp: hoursAgo(200),
  git: { commit, branch },
  execution: { total: 1, passed: 1, failed: 0, skipped: 0 },
  verdict: 'SAFE',
  qualityScore: 100,
  risk: { level: 'LOW', score: 1 },
  tests: [],
});

const commit = (char: string, hours: number, subject = 'feat: x', body = ''): GitCommit => ({ sha: sha(char), date: hoursAgo(hours), subject, body });

test.describe('outcome detection', () => {
  test('a revert is a rollback, a hotfix merge within 72h is a hotfix, a quiet 72h is ok', () => {
    const commits = [
      commit('9', 10, "Revert \"feat: billing\"", `This reverts commit ${sha('a')}.`),
      commit('8', 90, "Merge branch 'hotfix/total-rounding'"),
      commit('c', 100, 'feat: checkout'),
      commit('b', 150, 'feat: search'),
      commit('a', 160, 'feat: billing'),
    ];

    const { detected } = detectOutcomes({ commits, runs: [run(sha('a')), run(sha('b')), run(sha('c'))], existing: [], branch: 'main', now: NOW });

    expect(detected.map((outcome) => [outcome.commit[0], outcome.result])).toEqual([
      ['a', 'rollback'],
      ['b', 'ok'],
      ['c', 'hotfix'],
    ]);
    expect(detected[0].evidence).toContain('reverted by 9999999');
  });

  test('too recent to tell is pending, never "ok"', () => {
    const { detected, pending } = detectOutcomes({ commits: [commit('a', 5)], runs: [run(sha('a'))], existing: [], branch: 'main', now: NOW });

    expect(detected).toEqual([]);
    expect(pending).toEqual([sha('a')]);
  });

  test('an outcome recorded by hand is never overwritten, and other branches are ignored', () => {
    const { detected } = detectOutcomes({
      commits: [commit('a', 100), commit('b', 100)],
      runs: [run(sha('a')), run(sha('b'), 'feature/x')],
      existing: [{ commit: 'aaaaaaa', result: 'incident', occurredAt: hoursAgo(90), recordedAt: hoursAgo(90) }],
      branch: 'main',
      now: NOW,
    });

    expect(detected).toEqual([]);
  });

  test('reads this repository\'s real git history', () => {
    const commits = readGitLog(process.cwd(), 3650);

    expect(commits.length).toBeGreaterThan(5);
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.parse(commits[0].date)).not.toBeNaN();
  });
});
