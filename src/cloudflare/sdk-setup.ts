// @ts-expect-error - clack is ESM and TS complains about that. It works though
import clack from '@clack/prompts';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { getCloudflareWorkerTemplate } from './templates';
import {
  defaultEntryPoint,
  getEntryPointFromWranglerConfig,
} from './wrangler/get-entry-point-from-wrangler-config';
import { wrapWorkerWithSentry } from './wrap-worker';

/**
 * Creates or updates the main worker file with Sentry initialization.
 * Existing entry points are always preserved and wrapped; a new Sentry-ready
 * default worker is created only when Wrangler has no configured entry point.
 *
 * Returns false when automatic setup could not be completed. The caller must
 * not update Wrangler's main field or report a successful setup in that case.
 */
export async function createSentryInitFile(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
  },
  reduceDataCollection: boolean,
): Promise<boolean> {
  const entryPointFromConfig = getEntryPointFromWranglerConfig();
  const entryPoint = entryPointFromConfig ?? defaultEntryPoint;
  const entryPointPath = path.join(process.cwd(), entryPoint);

  if (fs.existsSync(entryPointPath)) {
    clack.log.info(
      `Found existing entry point: ${chalk.cyan(entryPoint)}`,
    );

    try {
      await wrapWorkerWithSentry(
        entryPointPath,
        dsn,
        selectedFeatures,
        reduceDataCollection,
      );
      clack.log.success(
        `Wrapped ${chalk.cyan(entryPoint)} with Sentry initialization.`,
      );
      return true;
    } catch (error) {
      clack.log.warn('Failed to wrap worker automatically.');
      clack.log.step('Please wrap your handler with Sentry initialization:');
      clack.note(
        chalk.cyan(
          getCloudflareWorkerTemplate(
            dsn,
            selectedFeatures,
            reduceDataCollection,
          ),
        ),
      );
      return false;
    }
  }

  // A missing explicitly configured file is not permission to silently create
  // a different entry point or to claim setup succeeded.
  if (entryPointFromConfig) {
    clack.log.warn(
      `The configured worker entry point ${chalk.cyan(entryPoint)} does not exist. No worker file was created.`,
    );
    clack.log.step('Create the configured entry point and add Sentry initialization:');
    clack.note(
      chalk.cyan(
        getCloudflareWorkerTemplate(
          dsn,
          selectedFeatures,
          reduceDataCollection,
        ),
      ),
    );
    return false;
  }

  clack.log.info(
    'No entry point found in wrangler config, creating a new Sentry-ready worker.',
  );

  const cloudflareWorkerTemplate = getCloudflareWorkerTemplate(
    dsn,
    selectedFeatures,
    reduceDataCollection,
  );

  await fs.promises.mkdir(
    path.join(process.cwd(), path.dirname(defaultEntryPoint)),
    {
      recursive: true,
    },
  );
  // Exclusive creation protects an entry point created after the existence check.
  await fs.promises.writeFile(
    entryPointPath,
    cloudflareWorkerTemplate,
    { encoding: 'utf-8', flag: 'wx' },
  );

  clack.log.success(`Created ${chalk.cyan(defaultEntryPoint)} with Sentry initialization.`);
  return true;
}
