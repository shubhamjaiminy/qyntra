/**
 * Pilot report: the numbers that say whether Qyntra is earning trust.
 *
 * A design partner runs `qyntra pilot-report` and sends the result
 * back. It must be safe to send without review, so it holds counts and
 * rates only — no test names, URLs, commits, requirement text, notes or
 * application name. Everything here is derived from artifacts the
 * partner already has; nothing is collected that Qyntra did not need
 * for its own decision.
 */

import type { RemediationArtifact } from '../repair';
import { trackRecord, type ReleaseOutcome } from './release-outcomes';
import {
  computeStability,
  maintenanceDebt,
  type RunHistoryEntry,
} from './run-history';

export const PILOT_REPORT_VERSION = 2;

/** The subset of ai-analysis.json the report reads. */
export interface PilotAnalysisInput {
  analyses?: {
    isLikelyTestDefect?: boolean;
    isLikelyProductDefect?: boolean;
    degraded?: boolean;
  }[];
}

export interface PilotReportInputs {
  runs: RunHistoryEntry[];
  outcomes: ReleaseOutcome[];
  analysis?: PilotAnalysisInput;
  remediation?: RemediationArtifact;
  /** Configured AI, e.g. "ollama (qwen2.5-coder:7b)". */
  provider: string;
  qyntraVersion: string;
  now?: Date;
}

export interface PilotReport {
  version: number;
  generatedAt: string;
  qyntraVersion: string;

  usage: {
    runs: number;
    firstRunAt: string | null;
    lastRunAt: string | null;
    /** Distinct commits judged; a proxy for "used on real changes". */
    commitsJudged: number;
    averageTestsPerRun: number;
    averagePassRate: number | null;
  };

  decisions: {
    safe: number;
    safeWithRisk: number;
    unsafe: number;
    averageQualityScore: number | null;
  };

  /** Joined with recorded outcomes: was "safe" actually safe? */
  accuracy: {
    outcomesRecorded: number;
    judged: number;
    calledSafe: number;
    escapes: number;
    escapeRate: number | null;
    falseAlarms: number;
    unjudgedIncidents: number;
  };

  stability: {
    testsTracked: number;
    flakyOrChronic: number;
  };

  /** Latest run only: ai-analysis.json is regenerated per run. */
  diagnosis: {
    failuresAnalyzed: number;
    productDefects: number;
    testDefects: number;
    unattributed: number;
    /** Analyses that fell back from the AI to the deterministic analyzer. */
    deterministicFallbacks: number;
    provider: string;
  };

  /**
   * The pilot's headline number, per week: bugs the gate caught and
   * false alarms it kept from blocking. A test counts once per week
   * however many runs it failed in. These are the gate's claims; the
   * partner confirms them with the local pilot review.
   */
  weekly: {
    weeks: PilotWeek[];
    /** Runs with no findings recorded: older Qyntra, or pulled from the cloud. */
    runsWithoutFindings: number;
  };

  /** Latest run only, like diagnosis. */
  repair: {
    attempted: number;
    verified: number;
    applied: number;
    reviewRequired: number;
    declined: number;
    notVerified: number;
    flaky: number;
  };
}

export interface PilotWeek {
  /** Monday of the week, UTC, as YYYY-MM-DD. */
  weekOf: string;
  runs: number;
  bugsCaught: number;
  falseAlarmsAvoided: number;
}

/** Monday 00:00 UTC of the week containing the timestamp, as YYYY-MM-DD. */
export function weekOf(timestamp: string): string {
  const date = new Date(timestamp);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;

  date.setUTCDate(date.getUTCDate() - daysSinceMonday);

  return date.toISOString().slice(0, 10);
}

interface WeekFindings {
  weekOf: string;
  runs: number;
  bugs: Set<string>;
  noise: Set<string>;
}

/**
 * Findings grouped by week, oldest first. A test that was a bug in one
 * run and noise in another that week is counted as a bug only.
 */
function findingsByWeek(runs: RunHistoryEntry[]): WeekFindings[] {
  const weeks = new Map<string, WeekFindings>();

  for (const run of runs) {
    if (!run.findings || Number.isNaN(Date.parse(run.timestamp))) continue;

    const key = weekOf(run.timestamp);
    const week = weeks.get(key) ?? { weekOf: key, runs: 0, bugs: new Set(), noise: new Set() };

    week.runs++;
    run.findings.bugs.forEach((test) => week.bugs.add(test));
    run.findings.noise.forEach((test) => week.noise.add(test));

    weeks.set(key, week);
  }

  for (const week of weeks.values()) {
    week.bugs.forEach((test) => week.noise.delete(test));
  }

  return [...weeks.values()].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

export function buildPilotReport(inputs: PilotReportInputs): PilotReport {
  const { runs, outcomes } = inputs;
  const now = inputs.now ?? new Date();

  const commits = new Set(
    runs.map((run) => run.git?.commit).filter((commit): commit is string => !!commit)
  );

  const passRates = runs
    .filter((run) => run.execution.total > 0)
    .map((run) => (run.execution.passed / run.execution.total) * 100);

  const record = trackRecord(outcomes, runs, now);
  const stability = computeStability(runs);

  const analyses = inputs.analysis?.analyses ?? [];
  const repairs = (inputs.remediation?.repairs ?? []).filter(
    (repair) => repair.status !== 'skipped'
  );

  const countVerdict = (verdict: string) =>
    runs.filter((run) => run.verdict === verdict).length;

  const countRepairs = (status: string) =>
    repairs.filter((repair) => repair.status === status).length;

  return {
    version: PILOT_REPORT_VERSION,
    generatedAt: now.toISOString(),
    qyntraVersion: inputs.qyntraVersion,

    usage: {
      runs: runs.length,
      firstRunAt: runs[0]?.timestamp ?? null,
      lastRunAt: runs[runs.length - 1]?.timestamp ?? null,
      commitsJudged: commits.size,
      averageTestsPerRun: average(runs.map((run) => run.execution.total)) ?? 0,
      averagePassRate: average(passRates),
    },

    decisions: {
      safe: countVerdict('SAFE'),
      safeWithRisk: countVerdict('SAFE_WITH_RISK'),
      unsafe: countVerdict('UNSAFE'),
      averageQualityScore: average(runs.map((run) => run.qualityScore)),
    },

    accuracy: {
      outcomesRecorded: outcomes.length,
      judged: record.judged,
      calledSafe: record.calledSafe,
      escapes: record.escapes,
      escapeRate: record.escapeRate,
      falseAlarms: record.falseAlarms,
      unjudgedIncidents: record.unjudgedIncidents,
    },

    stability: {
      testsTracked: Object.keys(stability).length,
      flakyOrChronic: maintenanceDebt(stability).length,
    },

    diagnosis: {
      failuresAnalyzed: analyses.length,
      productDefects: analyses.filter((entry) => entry.isLikelyProductDefect).length,
      testDefects: analyses.filter((entry) => entry.isLikelyTestDefect).length,
      unattributed: analyses.filter(
        (entry) => !entry.isLikelyProductDefect && !entry.isLikelyTestDefect
      ).length,
      deterministicFallbacks: analyses.filter((entry) => entry.degraded).length,
      provider: inputs.provider,
    },

    weekly: {
      weeks: findingsByWeek(runs).map((week) => ({
        weekOf: week.weekOf,
        runs: week.runs,
        bugsCaught: week.bugs.size,
        falseAlarmsAvoided: week.noise.size,
      })),
      runsWithoutFindings: runs.filter((run) => !run.findings).length,
    },

    repair: {
      attempted: repairs.length,
      verified: countRepairs('verified'),
      applied: repairs.filter((repair) => repair.applied).length,
      reviewRequired: repairs.filter((repair) => repair.reviewRequired).length,
      declined: countRepairs('declined'),
      notVerified: countRepairs('not-verified'),
      flaky: countRepairs('flaky'),
    },
  };
}

const percent = (rate: number | null) =>
  rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;

const orNa = (value: number | null) => (value === null ? 'n/a' : String(value));

/**
 * The same report for a person: what a partner reads before sending it.
 */
export function formatPilotReportMarkdown(report: PilotReport): string {
  const { usage, decisions, accuracy, stability, diagnosis, repair, weekly } = report;

  const lines = [
    '# Qyntra pilot report',
    '',
    `Generated ${report.generatedAt.slice(0, 10)} by Qyntra ${report.qyntraVersion}.`,
    'Counts and rates only: no test names, URLs, commits or application details.',
    '',
    '## Bugs caught and false alarms avoided, per week',
    '',
  ];

  if (weekly.weeks.length === 0) {
    lines.push('No runs with findings recorded yet.');
  } else {
    lines.push(
      '| Week of | Runs | Bugs caught | False alarms avoided |',
      '| --- | --- | --- | --- |',
      ...weekly.weeks.map(
        (week) => `| ${week.weekOf} | ${week.runs} | ${week.bugsCaught} | ${week.falseAlarmsAvoided} |`
      ),
      '',
      'Bugs caught: failing tests attributed to the product, or newly failing after ' +
        'passing in every recent run. False alarms avoided: failures on broken, flaky ' +
        'or chronically failing tests that were kept from blocking on their own. ' +
        'Each test counts once per week. These are the gate\'s claims; confirm them ' +
        'with pilot-review.md, which stays with you.'
    );
  }

  if (weekly.runsWithoutFindings > 0) {
    lines.push('', `Runs without findings (older Qyntra, or from the cloud): ${weekly.runsWithoutFindings}`);
  }

  lines.push(
    '',
    '## Usage',
    '',
    `- Runs: ${usage.runs}` +
      (usage.firstRunAt && usage.lastRunAt
        ? ` (${usage.firstRunAt.slice(0, 10)} to ${usage.lastRunAt.slice(0, 10)})`
        : ''),
    `- Commits judged: ${usage.commitsJudged}`,
    `- Average tests per run: ${usage.averageTestsPerRun}`,
    `- Average pass rate: ${usage.averagePassRate === null ? 'n/a' : `${usage.averagePassRate}%`}`,
    '',
    '## Release decisions',
    '',
    `- SAFE: ${decisions.safe}, SAFE_WITH_RISK: ${decisions.safeWithRisk}, UNSAFE: ${decisions.unsafe}`,
    `- Average quality score: ${orNa(decisions.averageQualityScore)}`,
    '',
    '## Were the decisions right?',
    '',
    `- Outcomes recorded: ${accuracy.outcomesRecorded} (judged by the gate: ${accuracy.judged})`,
    `- Called safe, then caused an incident: ${accuracy.escapes} of ${accuracy.calledSafe} (${percent(accuracy.escapeRate)})`,
    `- Called UNSAFE, shipped anyway, and were fine: ${accuracy.falseAlarms}`,
    `- Incidents on commits the gate never judged: ${accuracy.unjudgedIncidents}`
  );

  if (accuracy.outcomesRecorded === 0) {
    lines.push(
      '',
      'No outcomes recorded yet. After each release, run ' +
        '`qyntra outcome --commit <sha> --result ok|incident|rollback|hotfix` — ' +
        'without it, accuracy cannot be measured.'
    );
  }

  lines.push(
    '',
    '## Test stability',
    '',
    `- Tests tracked: ${stability.testsTracked}`,
    `- Flaky or chronically failing: ${stability.flakyOrChronic}`,
    '',
    '## Failure diagnosis (latest run)',
    '',
    `- Failures analyzed: ${diagnosis.failuresAnalyzed}` +
      ` (AI: ${diagnosis.provider})`,
    `- Product defects: ${diagnosis.productDefects}, test defects: ${diagnosis.testDefects}, ` +
      `unattributed: ${diagnosis.unattributed}`,
    `- Fell back to the deterministic analyzer: ${diagnosis.deterministicFallbacks}`,
    '',
    '## Repairs (latest run)',
    '',
    `- Attempted: ${repair.attempted}, verified: ${repair.verified}, applied: ${repair.applied}`,
    `- Needed human review: ${repair.reviewRequired}`,
    `- Declined: ${repair.declined}, not verified: ${repair.notVerified}, flaky: ${repair.flaky}`,
    ''
  );

  return lines.join('\n');
}

/**
 * The partner's own list behind the weekly counts, with test names, so
 * they can mark each claim right or wrong. Written next to the report
 * and never meant to be sent: test names can describe the application.
 */
export function formatPilotReviewMarkdown(runs: RunHistoryEntry[], weeks = 4): string {
  const recent = findingsByWeek(runs).slice(-weeks).reverse();

  const lines = [
    '# Qyntra pilot review — keep this file, do not send it',
    '',
    'The tests behind each week\'s counts in pilot-report.md. Mark each one,',
    'then send only the confirmed counts with the weekly scorecard.',
    '',
  ];

  if (recent.length === 0) {
    lines.push('No runs with findings recorded yet.', '');
    return lines.join('\n');
  }

  const checklist = (tests: Set<string>, none: string) =>
    tests.size === 0 ? [`- ${none}`] : [...tests].sort().map((test) => `- [ ] ${test}`);

  for (const week of recent) {
    lines.push(
      `## Week of ${week.weekOf} (${week.runs} run(s))`,
      '',
      '**Bugs caught** — tick if it was a real product bug:',
      '',
      ...checklist(week.bugs, 'None.'),
      '',
      '**False alarms avoided** — tick if the test really was broken or flaky, not the product:',
      '',
      ...checklist(week.noise, 'None.'),
      ''
    );
  }

  return lines.join('\n');
}
