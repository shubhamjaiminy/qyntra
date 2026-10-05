import fs from 'fs';

import { stagePaths } from '../lib/paths';
import {
  FailureContext,
} from './provider';

export function buildFailureContext(
  failure: any
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

  return {
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
}