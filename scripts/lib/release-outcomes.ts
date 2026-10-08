/**
 * Release outcomes: the feedback loop from production back into the gate.
 *
 * A release gate that never learns whether its "SAFE" was right cannot
 * be trusted, and cannot improve. Only the team knows what happened
 * after a release, so outcomes are recorded explicitly
 * (`qyntra outcome --commit <sha> --result incident ...`) and kept in
 * .qyntra/release-outcomes.json — committed with the code, so the whole
 * team and CI see the same record and a cache eviction cannot erase it.
 *
 * Outcomes flow back in two places:
 *
 *   - Risk: an incident in an area raises the risk of later runs whose
 *     requirement or discovered capabilities touch that area. Bounded
 *     and decaying, so one bad week cannot dominate forever.
 *   - The gate: outcomes are joined with the gate's own past verdicts
 *     to measure how often SAFE was wrong, and a gate that has been
 *     wrong lately reports lower confidence in itself.
 */

import { readOptionalArtifact, writeArtifact } from './paths';
import type { RiskFactor } from './risk-intelligence';
import type { ReleaseDecision } from './release-intelligence';
import type { RunHistoryEntry } from './run-history';

export const OUTCOME_RESULTS = ['ok', 'incident', 'rollback', 'hotfix'] as const;

export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

export const OUTCOME_SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;

export type OutcomeSeverity = (typeof OUTCOME_SEVERITIES)[number];

export interface ReleaseOutcome {
  /** The released commit. Full SHA when Qyntra could resolve it. */
  commit: string;
  result: OutcomeResult;
  severity?: OutcomeSeverity;
  /** What broke, in the team's words: "checkout", "login". */
  area?: string;
  note?: string;
  /** When it happened (defaults to when it was recorded). */
  occurredAt: string;
  recordedAt: string;
}

export interface OutcomeLog {
  version: number;
  outcomes: ReleaseOutcome[];
}

const OUTCOME_LOG_VERSION = 1;

/** Outcomes older than this no longer influence risk or confidence. */
export const OUTCOME_WINDOW_DAYS = 90;

/** Most risk points outcomes may add to one assessment. */
const MAX_HISTORY_POINTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A bad outcome: the release hurt someone. */
export function isEscape(result: OutcomeResult): boolean {
  return result !== 'ok';
}

// --------------------------------------------------
// STORAGE
// --------------------------------------------------

export function readOutcomes(filePath: string): OutcomeLog {
  const log = readOptionalArtifact<OutcomeLog>(filePath);

  if (!log || !Array.isArray(log.outcomes)) {
    return { version: OUTCOME_LOG_VERSION, outcomes: [] };
  }

  return {
    version: OUTCOME_LOG_VERSION,
    outcomes: log.outcomes.filter(
      (entry) =>
        typeof entry?.commit === 'string' &&
        (OUTCOME_RESULTS as readonly string[]).includes(entry.result)
    ),
  };
}

/**
 * Record an outcome. A second outcome for the same commit replaces the
 * first — "ok" recorded on deploy day and an incident found a week
 * later must not both count.
 */
export function recordOutcome(
  filePath: string,
  outcome: ReleaseOutcome
): OutcomeLog {
  const log = readOutcomes(filePath);

  const outcomes = [
    ...log.outcomes.filter((entry) => !sameCommit(entry.commit, outcome.commit)),
    outcome,
  ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const updated = { version: OUTCOME_LOG_VERSION, outcomes };

  writeArtifact(filePath, updated);

  return updated;
}

/** Short and full SHAs of the same commit match. */
export function sameCommit(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();

  if (left.length < 7 || right.length < 7) {
    return left === right;
  }

  return left.startsWith(right) || right.startsWith(left);
}

function ageInDays(isoDate: string, now: Date): number {
  const time = Date.parse(isoDate);

  return Number.isNaN(time) ? Infinity : (now.getTime() - time) / DAY_MS;
}

function recent(outcomes: ReleaseOutcome[], now: Date): ReleaseOutcome[] {
  return outcomes.filter((entry) => {
    const age = ageInDays(entry.occurredAt, now);
    return age >= 0 && age <= OUTCOME_WINDOW_DAYS;
  });
}

// --------------------------------------------------
// RISK
// --------------------------------------------------

/** Words long enough to mean something: "checkout", not "in". */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

/**
 * Risk factors from recent bad outcomes that touch this assessment.
 *
 * An incident counts when its area shares a word with the requirement
 * or a discovered capability. An incident with no area counts against
 * the whole application, at the lowest weight. Recent and severe
 * weighs more; the total is capped.
 */
export function outcomeRiskFactors(
  outcomes: ReleaseOutcome[],
  requirement: string,
  capabilities: string[],
  now: Date = new Date()
): RiskFactor[] {
  const vocabulary = new Set(
    [requirement, ...capabilities].flatMap((text) => terms(text))
  );

  const factors: RiskFactor[] = [];

  for (const outcome of recent(outcomes, now)) {
    if (!isEscape(outcome.result)) {
      continue;
    }

    const age = Math.round(ageInDays(outcome.occurredAt, now));
    const severe =
      outcome.severity === 'Critical' || outcome.severity === 'High';

    const area = outcome.area?.trim();
    const matched = area
      ? terms(area).filter((word) => vocabulary.has(word))
      : [];

    let points: number;

    if (area && matched.length === 0) {
      // A broken checkout says nothing about the todo list.
      continue;
    } else if (!area) {
      points = age <= 30 ? 1 : 0;
    } else {
      points = severe ? (age <= 30 ? 2 : 1) : age <= 30 ? 1 : 0;
    }

    if (points === 0) {
      continue;
    }

    const what = `${outcome.severity ? `${outcome.severity} ` : ''}${outcome.result}`;
    const where = area ? ` in "${area}"` : '';

    factors.push({
      points,
      source: 'history',
      reason: `A ${what}${where} followed a release ${age} day(s) ago`,
      evidence:
        `commit ${outcome.commit.slice(0, 12)}` +
        (outcome.note ? `: ${outcome.note}` : ''),
    });
  }

  // Worst first, then cap: the strongest signals survive the limit.
  factors.sort((a, b) => b.points - a.points);

  const capped: RiskFactor[] = [];
  let total = 0;

  for (const factor of factors) {
    const points = Math.min(factor.points, MAX_HISTORY_POINTS - total);

    if (points <= 0) {
      break;
    }

    capped.push({ ...factor, points });
    total += points;
  }

  return capped;
}

// --------------------------------------------------
// GATE TRACK RECORD
// --------------------------------------------------

export interface TrackRecord {
  /** Recent outcomes whose release the gate had judged. */
  judged: number;
  /** Of those, released as SAFE or SAFE_WITH_RISK. */
  calledSafe: number;
  /** Called safe, then caused an incident, rollback or hotfix. */
  escapes: number;
  /** escapes / calledSafe, or null with nothing called safe. */
  escapeRate: number | null;
  /** Called UNSAFE, shipped anyway, and fine: the gate was too strict. */
  falseAlarms: number;
  /** Bad outcomes on commits the gate never judged. */
  unjudgedIncidents: number;
  /** One line per escape, for the decision's warnings. */
  escapeDetails: string[];
}

/**
 * Join recent outcomes with the gate's own past verdicts.
 *
 * Verdicts come from run history, so this measures the gate that is
 * actually running — in CI, the CI gate whose history is cached.
 */
export function trackRecord(
  outcomes: ReleaseOutcome[],
  runs: RunHistoryEntry[],
  now: Date = new Date()
): TrackRecord {
  const record: TrackRecord = {
    judged: 0,
    calledSafe: 0,
    escapes: 0,
    escapeRate: null,
    falseAlarms: 0,
    unjudgedIncidents: 0,
    escapeDetails: [],
  };

  for (const outcome of recent(outcomes, now)) {
    // The last verdict for that commit is the one that let it ship.
    const run = [...runs]
      .reverse()
      .find((entry) => entry.git?.commit && sameCommit(entry.git.commit, outcome.commit));

    if (!run) {
      if (isEscape(outcome.result)) {
        record.unjudgedIncidents += 1;
      }
      continue;
    }

    record.judged += 1;

    const safe = run.verdict === 'SAFE' || run.verdict === 'SAFE_WITH_RISK';

    if (safe) {
      record.calledSafe += 1;

      if (isEscape(outcome.result)) {
        record.escapes += 1;
        record.escapeDetails.push(
          `${outcome.commit.slice(0, 7)} was called ${run.verdict} ` +
            `(score ${run.qualityScore}) and then caused a ` +
            `${outcome.severity ? `${outcome.severity} ` : ''}${outcome.result}` +
            `${outcome.area ? ` in ${outcome.area}` : ''}.`
        );
      }
    } else if (!isEscape(outcome.result)) {
      record.falseAlarms += 1;
    }
  }

  record.escapeRate =
    record.calledSafe === 0
      ? null
      : Math.round((record.escapes / record.calledSafe) * 1000) / 1000;

  return record;
}

/** Above this share of wrong SAFE calls, the gate trusts itself less. */
const ESCAPE_RATE_THRESHOLD = 0.2;

/** Fewer judged releases than this is too little to call a trend. */
const MIN_JUDGED_FOR_CALIBRATION = 3;

/**
 * Fold the track record into a decision: warnings always, and one step
 * less confidence when SAFE has been wrong often enough to matter.
 * Never changes the verdict or the score — the record is about the
 * gate, not about this release.
 */
export function applyTrackRecord(
  decision: ReleaseDecision,
  record: TrackRecord
): ReleaseDecision {
  const warnings = [...decision.warnings];
  let confidence = decision.decisionConfidence;

  if (record.escapes > 0) {
    warnings.push(
      `In the last ${OUTCOME_WINDOW_DAYS} days ${record.escapes} of ` +
        `${record.calledSafe} release(s) this gate called safe later caused ` +
        'an incident, rollback or hotfix:'
    );
    warnings.push(...record.escapeDetails);
  }

  if (
    record.judged >= MIN_JUDGED_FOR_CALIBRATION &&
    record.escapeRate !== null &&
    record.escapeRate > ESCAPE_RATE_THRESHOLD
  ) {
    confidence = confidence === 'High' ? 'Medium' : 'Low';

    warnings.push(
      `Confidence lowered: ${Math.round(record.escapeRate * 100)}% of recent ` +
        'SAFE calls were wrong. Add tests for the areas listed above, or ' +
        'raise gate.minQualityScore.'
    );
  }

  if (record.unjudgedIncidents > 0) {
    warnings.push(
      `${record.unjudgedIncidents} recent incident(s) were on commits this ` +
        'gate never judged; they count towards risk but not the track record.'
    );
  }

  return { ...decision, warnings, decisionConfidence: confidence };
}
