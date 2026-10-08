import { test, expect } from '@playwright/test';

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyTrackRecord,
  outcomeRiskFactors,
  readOutcomes,
  recordOutcome,
  sameCommit,
  trackRecord,
  type ReleaseOutcome,
} from '../../scripts/lib/release-outcomes';
import { decideRelease } from '../../scripts/lib/release-intelligence';
import { assessRisk } from '../../scripts/lib/risk-intelligence';
import type { RunHistoryEntry } from '../../scripts/lib/run-history';

const NOW = new Date('2026-10-08T12:00:00Z');

const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function outcome(overrides: Partial<ReleaseOutcome> = {}): ReleaseOutcome {
  return {
    commit: 'a'.repeat(40),
    result: 'incident',
    severity: 'High',
    area: 'checkout',
    occurredAt: daysAgo(5),
    recordedAt: daysAgo(5),
    ...overrides,
  };
}

function run(commit: string, verdict: string): RunHistoryEntry {
  return {
    runId: commit,
    timestamp: daysAgo(10),
    git: { commit },
    execution: { total: 10, passed: 10, failed: 0, skipped: 0 },
    verdict,
    qualityScore: verdict === 'UNSAFE' ? 60 : 100,
    risk: { level: 'MEDIUM', score: 5 },
    tests: [],
  };
}

const sha = (char: string) => char.repeat(40);

test.describe('commit matching', () => {
  test('a short SHA matches its full SHA', () => {
    expect(sameCommit('4e489eb', '4e489ebbed3398fcb7298a93adc94abaada701f7')).toBe(true);
  });

  test('different commits and too-short prefixes do not match', () => {
    expect(sameCommit('4e489eb', '485d198')).toBe(false);
    expect(sameCommit('4e4', '4e489eb')).toBe(false);
  });
});

test.describe('outcome storage', () => {
  test('a later outcome for the same commit replaces the earlier one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-outcomes-')), 'o.json');

    recordOutcome(file, outcome({ result: 'ok', commit: sha('b'), occurredAt: daysAgo(9) }));
    recordOutcome(file, outcome({ result: 'incident', commit: 'bbbbbbb', occurredAt: daysAgo(2) }));

    const { outcomes } = readOutcomes(file);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe('incident');
  });

  test('a missing or corrupt file reads as no outcomes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-outcomes-'));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');

    expect(readOutcomes(path.join(dir, 'missing.json')).outcomes).toEqual([]);
    expect(readOutcomes(path.join(dir, 'bad.json')).outcomes).toEqual([]);
  });
});

test.describe('risk from outcomes', () => {
  test('an incident in a matching area raises risk, with its evidence', () => {
    const [factor] = outcomeRiskFactors(
      [outcome({ area: 'checkout', note: 'Double charge on retry' })],
      'User can complete checkout',
      [],
      NOW
    );

    expect(factor).toMatchObject({ points: 2, source: 'history' });
    expect(factor.evidence).toContain('Double charge on retry');
  });

  test('matches on discovered capabilities, not only the requirement', () => {
    expect(
      outcomeRiskFactors([outcome({ area: 'delete item' })], 'User manages todos', ['Delete Item'], NOW)
    ).toHaveLength(1);
  });

  test('an incident elsewhere in the app does not raise this risk', () => {
    expect(outcomeRiskFactors([outcome({ area: 'checkout' })], 'User can log in', ['Login'], NOW)).toEqual([]);
  });

  test('good outcomes and old incidents add nothing', () => {
    expect(
      outcomeRiskFactors(
        [outcome({ result: 'ok' }), outcome({ occurredAt: daysAgo(120) })],
        'checkout',
        [],
        NOW
      )
    ).toEqual([]);
  });

  test('influence decays: a severe incident counts less after 30 days', () => {
    expect(outcomeRiskFactors([outcome({ occurredAt: daysAgo(60) })], 'checkout', [], NOW)[0].points).toBe(1);
  });

  test('an incident with no area counts against the whole app, lightly', () => {
    expect(outcomeRiskFactors([outcome({ area: undefined })], 'anything', [], NOW)[0].points).toBe(1);
  });

  test('the total is capped so history cannot dominate the rating', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      outcome({ commit: String(i).repeat(40), severity: 'Critical' })
    );

    const total = outcomeRiskFactors(many, 'checkout', [], NOW).reduce((sum, f) => sum + f.points, 0);

    expect(total).toBe(3);
  });

  test('history factors are added to the assessment and kept apart in the reasoning', () => {
    const history = outcomeRiskFactors([outcome()], 'checkout', [], NOW);
    const assessment = assessRisk('User can complete checkout', undefined, history);

    expect(assessment.factors.some((f) => f.source === 'history')).toBe(true);
    expect(assessment.reasoning).toContain('Recorded release outcomes add');
    expect(assessment.reasoning).not.toContain('discovery observed: a high incident');
  });
});

test.describe('gate track record', () => {
  const runs = [run(sha('1'), 'SAFE'), run(sha('2'), 'SAFE'), run(sha('3'), 'SAFE_WITH_RISK'), run(sha('4'), 'UNSAFE')];

  test('counts SAFE calls that later caused incidents', () => {
    const record = trackRecord(
      [
        outcome({ commit: sha('1') }),
        outcome({ commit: sha('2'), result: 'ok' }),
        outcome({ commit: sha('3'), result: 'rollback' }),
      ],
      runs,
      NOW
    );

    expect(record).toMatchObject({ judged: 3, calledSafe: 3, escapes: 2, escapeRate: 0.667 });
    expect(record.escapeDetails).toHaveLength(2);
  });

  test('an UNSAFE release that shipped fine is a false alarm, not an escape', () => {
    const record = trackRecord([outcome({ commit: sha('4'), result: 'ok' })], runs, NOW);

    expect(record).toMatchObject({ judged: 1, calledSafe: 0, escapes: 0, falseAlarms: 1, escapeRate: null });
  });

  test('incidents on commits the gate never judged are reported separately', () => {
    const record = trackRecord([outcome({ commit: sha('9') })], runs, NOW);

    expect(record).toMatchObject({ judged: 0, unjudgedIncidents: 1 });
  });

  test('the last verdict for a commit is the one that let it ship', () => {
    const rerun = [run(sha('5'), 'UNSAFE'), run(sha('5'), 'SAFE')];

    expect(trackRecord([outcome({ commit: sha('5') })], rerun, NOW).escapes).toBe(1);
  });
});

test.describe('applying the track record', () => {
  const clean = () =>
    decideRelease({
      execution: { total: 10, passed: 10, failed: 0, skipped: 0 },
      failures: [],
      risk: { level: 'MEDIUM', score: 5 },
      gate: {
        maxCriticalFailures: 0,
        maxHighFailures: 0,
        minQualityScore: 80,
        allowLowSeverityFailures: true,
        blockOnProductDefect: true,
        blockOnNewRegression: true,
        blockOnPerformanceRegression: false,
        historyRuns: 50,
      },
      aiAnalysisAvailable: true,
    });

  const runs = [run(sha('1'), 'SAFE'), run(sha('2'), 'SAFE'), run(sha('3'), 'SAFE')];

  test('a gate that has been wrong lately trusts itself less, but keeps its verdict', () => {
    const record = trackRecord(
      [outcome({ commit: sha('1') }), outcome({ commit: sha('2') }), outcome({ commit: sha('3'), result: 'ok' })],
      runs,
      NOW
    );

    const decision = applyTrackRecord(clean(), record);

    expect(decision.verdict).toBe('SAFE');
    expect(decision.qualityScore).toBe(100);
    expect(decision.decisionConfidence).toBe('Medium');
    expect(decision.warnings.join('\n')).toMatch(/Confidence lowered: 67%/);
  });

  test('one escape among few judged releases warns without recalibrating', () => {
    const record = trackRecord([outcome({ commit: sha('1') })], runs, NOW);
    const decision = applyTrackRecord(clean(), record);

    expect(decision.decisionConfidence).toBe('High');
    expect(decision.warnings.join('\n')).toMatch(/1 of 1 release\(s\) this gate called safe/);
  });

  test('a clean record changes nothing', () => {
    const decision = clean();

    expect(applyTrackRecord(decision, trackRecord([], runs, NOW))).toEqual(decision);
  });
});
