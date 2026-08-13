#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataset } from './dataset.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes('--check');
const outputArgumentIndex = process.argv.indexOf('--output');
const outputDirectory = resolve(
  outputArgumentIndex >= 0
    ? process.argv[outputArgumentIndex + 1]
    : join(scriptDirectory, 'dataset')
);

const dataset = buildDataset();
const outputs = {
  'campaigns.jsonl': dataset.files.campaigns,
  'contents.jsonl': dataset.files.contents,
  'qrels.jsonl': dataset.files.qrels,
  'manifest.json': `${JSON.stringify(dataset.manifest, null, 2)}\n`,
};

if (checkOnly) {
  const mismatches = [];
  for (const [fileName, expected] of Object.entries(outputs)) {
    let actual = null;
    try {
      actual = await readFile(join(outputDirectory, fileName), 'utf8');
    } catch {
      mismatches.push(`${fileName}: missing`);
      continue;
    }
    if (actual !== expected) {
      mismatches.push(`${fileName}: content mismatch`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Phase 4 dataset check failed\n${mismatches.join('\n')}`);
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'valid', outputDirectory, ...dataset.manifest.counts })}\n`
  );
} else {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    Object.entries(outputs).map(([fileName, content]) =>
      writeFile(join(outputDirectory, fileName), content, 'utf8')
    )
  );
  process.stdout.write(
    `${JSON.stringify({ status: 'generated', outputDirectory, ...dataset.manifest.counts })}\n`
  );
}
