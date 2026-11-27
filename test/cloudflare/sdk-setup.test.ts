import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSentryInitFile } from '../../src/cloudflare/sdk-setup';
import { defaultEntryPoint } from '../../src/cloudflare/wrangler/get-entry-point-from-wrangler-config';
import * as templates from '../../src/cloudflare/templates';
import * as wrapWorker from '../../src/cloudflare/wrap-worker';

const { clackMocks } = vi.hoisted(() => {
  const info = vi.fn();
  const warn = vi.fn();
  const success = vi.fn();
  const step = vi.fn();
  const note = vi.fn();

  return {
    clackMocks: {
      info,
      warn,
      success,
      step,
      note,
    },
  };
});

vi.mock('@clack/prompts', () => ({
  __esModule: true,
  default: {
    log: {
      info: clackMocks.info,
      warn: clackMocks.warn,
      success: clackMocks.success,
      step: clackMocks.step,
    },
    note: clackMocks.note,
  },
}));

const { getEntryPointFromWranglerConfigMock } = vi.hoisted(() => ({
  getEntryPointFromWranglerConfigMock: vi.fn(),
}));

vi.mock(
  '../../src/cloudflare/wrangler/get-entry-point-from-wrangler-config',
  () => ({
    getEntryPointFromWranglerConfig: getEntryPointFromWranglerConfigMock,
    defaultEntryPoint: 'src/index.ts',
  }),
);

describe('createSentryInitFile', () => {
  let tmpDir: string;
  const testDsn = 'https://example@sentry.io/123';
  const testFeatures = {
    performance: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getEntryPointFromWranglerConfigMock.mockReset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-setup-test-'));

    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }

    vi.restoreAllMocks();
  });

  it('creates a new Sentry-ready default entry point only when no entry point exists', async () => {
    const template =
      'export default Sentry.withSentry(config, { async fetch() { return new Response("hello"); } });';
    const getCloudflareWorkerTemplateSpy = vi
      .spyOn(templates, 'getCloudflareWorkerTemplate')
      .mockReturnValue(template);

    const result = await createSentryInitFile(testDsn, testFeatures, false);

    const expectedPath = path.join(tmpDir, 'src/index.ts');
    const content = fs.readFileSync(expectedPath, 'utf-8');

    expect(result).toBe(true);
    expect(clackMocks.info).toHaveBeenCalledWith(
      'No entry point found in wrangler config, creating a new Sentry-ready worker.',
    );
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(content).toBe(template);
    expect(clackMocks.success).toHaveBeenCalledWith(
      'Created src/index.ts with Sentry initialization.',
    );
    expect(getCloudflareWorkerTemplateSpy).toHaveBeenCalledWith(
      testDsn,
      testFeatures,
      false,
    );
  });

  it('wraps an existing default entry point instead of overwriting it when wrangler has no main', async () => {
    const expectedPath = path.join(tmpDir, defaultEntryPoint);
    await fs.promises.mkdir(path.dirname(expectedPath), { recursive: true });
    await fs.promises.writeFile(
      expectedPath,
      'export default { fetch() { return new Response("keep"); } };',
    );
    getEntryPointFromWranglerConfigMock.mockReturnValue(undefined);
    const originalContent = fs.readFileSync(expectedPath, 'utf-8');
    const wrapWorkerWithSentrySpy = vi
      .spyOn(wrapWorker, 'wrapWorkerWithSentry')
      .mockResolvedValue(undefined);

    const result = await createSentryInitFile(testDsn, testFeatures, false);

    expect(result).toBe(true);
    expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
      expectedPath,
      testDsn,
      testFeatures,
      false,
    );
    expect(fs.readFileSync(expectedPath, 'utf-8')).toBe(originalContent);
  });

  describe('when entry point is found in wrangler config', () => {
    describe('and the entry point file exists', () => {
      beforeEach(async () => {
        await createSentryInitFile(testDsn, testFeatures, false);
        getEntryPointFromWranglerConfigMock.mockReturnValue(defaultEntryPoint);
      });

      it('wraps the worker with Sentry when wrapping succeeds', async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, 'wrapWorkerWithSentry')
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          testFeatures,
          false,
        );
      });

      it('handles wrapping failure gracefully', async () => {
        vi.spyOn(wrapWorker, 'wrapWorkerWithSentry').mockRejectedValue(
          new Error('Wrapping failed'),
        );

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(clackMocks.warn).toHaveBeenCalledWith(
          'Failed to wrap worker automatically.',
        );
        expect(clackMocks.step).toHaveBeenCalledWith(
          'Please wrap your handler with Sentry initialization:',
        );
        expect(clackMocks.note).toHaveBeenCalledWith(
          expect.stringContaining('import * as Sentry'),
        );
      });

      it('shows template with correct DSN when wrapping fails', async () => {
        vi.spyOn(wrapWorker, 'wrapWorkerWithSentry').mockRejectedValue(
          new Error('Failed'),
        );
        const getCloudflareWorkerTemplateSpy = vi
          .spyOn(templates, 'getCloudflareWorkerTemplate')
          .mockReturnValue('template with dsn');

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(getCloudflareWorkerTemplateSpy).toHaveBeenCalledWith(
          testDsn,
          testFeatures,
          false,
        );
        expect(clackMocks.note).toHaveBeenCalledWith('template with dsn');
      });

      it('passes performance feature flag correctly', async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, 'wrapWorkerWithSentry')
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, { performance: false }, false);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          { performance: false },
          false,
        );
      });

      it('passes performance feature flag when enabled', async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, 'wrapWorkerWithSentry')
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, { performance: true }, false);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          { performance: true },
          false,
        );
      });

      it('passes reduceDataCollection through to the worker wrapper', async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, 'wrapWorkerWithSentry')
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, testFeatures, true);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          testFeatures,
          true,
        );
      });
    });

    describe('and the configured entry point file does not exist', () => {
      beforeEach(() => {
        getEntryPointFromWranglerConfigMock.mockReturnValue('missing-worker.ts');
      });

      it('does not create a different worker or report success', async () => {
        const result = await createSentryInitFile(testDsn, testFeatures, false);

        expect(result).toBe(false);
        expect(
          fs.existsSync(path.join(tmpDir, 'missing-worker.ts')),
        ).toBe(false);
        expect(
          fs.existsSync(path.join(tmpDir, defaultEntryPoint)),
        ).toBe(false);
        expect(clackMocks.success).not.toHaveBeenCalled();
        expect(clackMocks.warn).toHaveBeenCalledWith(
          'The configured worker entry point missing-worker.ts does not exist. No worker file was created.',
        );
        expect(clackMocks.note).toHaveBeenCalledWith(
          expect.stringContaining('import * as Sentry'),
        );
      });

      it('does not attempt to wrap a nonexistent entry point', async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, 'wrapWorkerWithSentry')
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(wrapWorkerWithSentrySpy).not.toHaveBeenCalled();
      });
    });
  });
});
