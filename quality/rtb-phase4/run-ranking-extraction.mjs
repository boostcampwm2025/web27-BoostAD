#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');

export function toCampaignPayload(campaign) {
  return {
    campaignKey: campaign.campaignKey,
    title: campaign.title,
    content: campaign.content,
    tags: campaign.tags,
  };
}

export function toContentPayload(content) {
  return {
    contentId: content.contentId,
    title: content.title,
    body: content.body,
    tags: content.tags,
  };
}

export function chunk(items, size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('batch size must be a positive integer');
  }
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function parseJsonLines(value) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function timestampId() {
  return new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
}

function command(commandName, args) {
  try {
    return execFileSync(commandName, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash('sha256')
    .update(value ?? '')
    .digest('hex');
}

function captureReproducibility(backendContainer) {
  const gitSha = command('git', ['rev-parse', 'HEAD']);
  const gitStatus = command('git', ['status', '--porcelain=v1']) ?? '';
  const gitDiff = command('git', ['diff', '--binary', 'HEAD']) ?? '';
  const backendImageId = backendContainer
    ? command('docker', ['inspect', '--format', '{{.Image}}', backendContainer])
    : null;
  return {
    gitSha,
    gitDiffSha256: sha256(gitDiff),
    gitDirty: gitStatus.length > 0,
    gitStatus,
    backendContainer: backendContainer ?? null,
    backendImageId,
  };
}

async function postJson(baseUrl, token, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-loadtest-reset-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON response (${response.status})`);
  }
  if (!response.ok || payload.status !== 'success') {
    throw new Error(
      `${path} failed (${response.status}): ${payload.message ?? text}`
    );
  }
  return payload.data;
}

async function main() {
  const baseUrl = argument('--base-url', 'http://127.0.0.1:3000');
  const token = argument('--token', process.env.LOADTEST_RESET_TOKEN);
  const retrievalMode = argument('--mode', 'dense_only');
  const variant = argument('--variant');
  const backendContainer = argument(
    '--backend-container',
    'boostad-backend-local'
  );
  const topK = Number.parseInt(argument('--top-k', '10'), 10);
  const batchSize = Number.parseInt(argument('--batch-size', '10'), 10);
  const datasetDirectory = resolve(
    argument('--dataset', join(scriptDirectory, 'dataset'))
  );
  const outputDirectory = resolve(
    argument(
      '--output',
      join(
        repositoryRoot,
        '.loadtest',
        'results',
        `${timestampId()}-phase4-quality-${variant}`
      )
    )
  );

  if (!token) {
    throw new Error('--token or LOADTEST_RESET_TOKEN is required');
  }
  if (retrievalMode !== 'dense_only') {
    throw new Error('현재 ranking extractor는 dense_only만 지원합니다.');
  }
  if (!variant || !/^[a-z0-9][a-z0-9_-]*$/i.test(variant)) {
    throw new Error('--variant must be a filesystem-safe identifier');
  }
  if (!Number.isInteger(topK) || topK <= 0 || topK > 50) {
    throw new Error('--top-k must be between 1 and 50');
  }

  const [campaignText, contentText, manifestText] = await Promise.all([
    readFile(join(datasetDirectory, 'campaigns.jsonl'), 'utf8'),
    readFile(join(datasetDirectory, 'contents.jsonl'), 'utf8'),
    readFile(join(datasetDirectory, 'manifest.json'), 'utf8'),
  ]);
  const campaigns = parseJsonLines(campaignText);
  const contents = parseJsonLines(contentText);
  const datasetManifest = JSON.parse(manifestText);
  await mkdir(outputDirectory, { recursive: true });
  const loadResult = await postJson(
    baseUrl,
    token,
    '/api/internal/loadtest/quality/load-campaigns',
    {
      datasetVersion: datasetManifest.datasetVersion,
      campaigns: campaigns.map(toCampaignPayload),
    }
  );
  const sessionPath = join(outputDirectory, 'session.json');
  await writeFile(
    sessionPath,
    `${JSON.stringify(
      {
        sessionId: loadResult.sessionId,
        datasetVersion: datasetManifest.datasetVersion,
        variant,
        runtime: loadResult.runtime,
        restored: false,
        recoveryEndpoint: '/api/internal/loadtest/quality/restore-campaigns',
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  const rankings = [];
  let extractionError = null;
  let restoreResult = null;

  try {
    for (const contentBatch of chunk(contents, batchSize)) {
      const result = await postJson(
        baseUrl,
        token,
        '/api/internal/loadtest/quality/extract-rankings',
        {
          sessionId: loadResult.sessionId,
          datasetVersion: datasetManifest.datasetVersion,
          retrievalMode,
          topK,
          contents: contentBatch.map(toContentPayload),
        }
      );
      if (result.reserveCalled !== false || result.budgetMutationCount !== 0) {
        throw new Error('reserve-free response contract was violated');
      }
      rankings.push(...result.rankings);
    }

    if (rankings.length !== contents.length) {
      throw new Error(
        `ranking count mismatch: ${rankings.length}/${contents.length}`
      );
    }
    const expectedIds = new Set(contents.map((content) => content.contentId));
    const rankedIds = new Set(rankings.map((ranking) => ranking.contentId));
    if (
      rankedIds.size !== expectedIds.size ||
      [...expectedIds].some((contentId) => !rankedIds.has(contentId))
    ) {
      throw new Error('ranking contentId set does not match the dataset');
    }

    await writeFile(
      join(outputDirectory, `${retrievalMode}.jsonl`),
      `${rankings.map((ranking) => JSON.stringify(ranking)).join('\n')}\n`,
      'utf8'
    );
  } catch (error) {
    extractionError = error;
  } finally {
    try {
      restoreResult = await postJson(
        baseUrl,
        token,
        '/api/internal/loadtest/quality/restore-campaigns',
        { sessionId: loadResult.sessionId }
      );
      await writeFile(
        sessionPath,
        `${JSON.stringify(
          {
            sessionId: loadResult.sessionId,
            datasetVersion: datasetManifest.datasetVersion,
            restored: true,
            restoredAt: new Date().toISOString(),
            variant,
            runtime: loadResult.runtime,
          },
          null,
          2
        )}\n`,
        'utf8'
      );
    } catch (restoreError) {
      await writeFile(
        sessionPath,
        `${JSON.stringify(
          {
            sessionId: loadResult.sessionId,
            datasetVersion: datasetManifest.datasetVersion,
            restored: false,
            variant,
            runtime: loadResult.runtime,
            restoreError:
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError),
            recoveryEndpoint:
              '/api/internal/loadtest/quality/restore-campaigns',
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      throw new AggregateError(
        [extractionError, restoreError].filter(Boolean),
        'ranking extraction and/or serving cache restore failed'
      );
    }
  }

  if (extractionError) {
    throw extractionError;
  }

  const runManifest = {
    kind: 'phase4-quality-ranking-extraction',
    generatedAt: new Date().toISOString(),
    baseUrl,
    retrievalMode,
    variant,
    topK,
    batchSize,
    datasetVersion: datasetManifest.datasetVersion,
    datasetSha256: datasetManifest.sha256,
    campaignCount: campaigns.length,
    contentCount: contents.length,
    reserveCalled: false,
    budgetMutationCount: 0,
    reproducibility: captureReproducibility(backendContainer),
    runtime: loadResult.runtime,
    load: loadResult,
    restore: restoreResult,
  };
  await writeFile(
    join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(runManifest, null, 2)}\n`,
    'utf8'
  );
  process.stdout.write(
    `${JSON.stringify({ status: 'complete', outputDirectory, ...runManifest })}\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
