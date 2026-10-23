import { test, expect, type Page } from '@playwright/test';

import { listProbes, probeFailureIsDefect, type Probe } from '../../scripts/lib/feature-probes';
import { REAL_WORLD_PAGES } from '../fixtures/real-world/pages';

/**
 * The real-world benchmark. Each page is a shape met on a real site,
 * with the right answer; Qyntra's probes must reach it: no false alarm
 * on a working page, no miss on a broken one. A change to the probes
 * that brings back an old mistake fails here, in CI, before any
 * customer sees it.
 */

async function runProbe(page: Page, probe: Probe): Promise<string | undefined> {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;

  try {
    await new AsyncFunction('page', 'expect', probe.test.body)(page, expect);
    return undefined;
  } catch (error) {
    return String((error as Error).message ?? error);
  }
}

for (const entry of REAL_WORLD_PAGES) {
  test(`real-world: ${entry.name}`, async ({ page }) => {
    test.info().annotations.push({ type: 'origin', description: entry.origin });

    await page.setContent(entry.html);
    const probes = await listProbes(page);

    expect(probes.length, `probes generated on "${entry.name}"`).toBeGreaterThanOrEqual(entry.minProbes);

    const found: string[] = [];

    for (const probe of probes) {
      await page.setContent(entry.html);
      const error = await runProbe(page, probe);

      if (error !== undefined && probeFailureIsDefect(error)) {
        found.push(probe.kind);
      }
    }

    const falseAlarms = found.filter((kind) => !(entry.defects as string[]).includes(kind));
    const misses = entry.defects.filter((kind) => !found.includes(kind));

    expect(falseAlarms, `false alarms on "${entry.name}" (${entry.origin})`).toEqual([]);
    expect(misses, `missed defects on "${entry.name}" (${entry.origin})`).toEqual([]);
  });
}
