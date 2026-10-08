import fs from 'fs';

import type { FailureEvidence } from '../lib/failure-evidence';
import { stagePaths } from '../lib/paths';
import {
  FailureContext,
} from './provider';

/** Larger images cost tokens without adding diagnostic detail. */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

export function buildFailureContext(
  failure: any,
  options: { includeScreenshot?: boolean; includeDomElements?: boolean } = {}
): FailureContext {
  const applicationMapPath =
    stagePaths().applicationMap;

  let applicationMap: unknown = {};

  if (
    fs.existsSync(
      applicationMapPath
    )
  ) {
    try {
      applicationMap =
        JSON.parse(
          fs.readFileSync(
            applicationMapPath,
            'utf-8'
          )
        );
    } catch {
      applicationMap = {};
    }
  }

  const evidence: FailureEvidence | undefined =
    failure.evidence;

  const context: FailureContext = {
    test: String(
      failure.test ??
        'Unknown test'
    ),

    category: String(
      failure.category ??
        'Unknown / Environment'
    ),

    error: String(
      failure.error ??
        ''
    ),

    stackTrace: String(
      failure.stackTrace ??
        failure.error ??
        ''
    ),

    sourceCode: String(
      failure.testSource ??
        ''
    ),

    applicationMap,
  };

  if (evidence) {
    // Artifact paths stay local: they reveal the runner's filesystem
    // and mean nothing to the model.
    context.evidence = {
      ...(evidence.pageSnapshot
        ? { pageSnapshot: evidence.pageSnapshot }
        : {}),
      consoleErrors: evidence.consoleErrors ?? [],
      pageErrors: evidence.pageErrors ?? [],
      failedRequests: evidence.failedRequests ?? [],
      steps: evidence.steps ?? [],
      // The element list is for choosing a locator during repair. In
      // diagnosis it made a 7B model read "the element exists" as "the
      // app is wrong" and misattribute test defects, so it is opt-in.
      ...(options.includeDomElements && evidence.domElements
        ? { domElements: evidence.domElements }
        : {}),
    };
  }

  const screenshot =
    options.includeScreenshot
      ? readScreenshot(evidence?.screenshotPath)
      : undefined;

  if (screenshot) {
    context.screenshot = screenshot;
  }

  return context;
}

function readScreenshot(
  filePath: string | undefined
): FailureContext['screenshot'] {
  if (!filePath) {
    return undefined;
  }

  try {
    const stat = fs.statSync(filePath);

    if (stat.size === 0 || stat.size > MAX_SCREENSHOT_BYTES) {
      return undefined;
    }

    return {
      mimeType: filePath.endsWith('.jpeg') || filePath.endsWith('.jpg')
        ? 'image/jpeg'
        : 'image/png',
      base64: fs.readFileSync(filePath).toString('base64'),
    };
  } catch {
    return undefined;
  }
}
