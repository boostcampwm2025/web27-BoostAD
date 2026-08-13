import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const size = readPositiveInt(process.env.RTB_CORPUS_SIZE, 3600);
const seed = readPositiveInt(process.env.RTB_CORPUS_SEED, 20260710);
const outputPath = resolve(
  process.argv[2] ?? 'k6/data/rtb-random-corpus.json'
);

const tagPool = [
  'JavaScript',
  'TypeScript',
  'Python',
  'Java',
  'Go',
  'Rust',
  'Kotlin',
  'Swift',
  'React',
  'Vue',
  'Angular',
  'Svelte',
  'NextJS',
  'NestJS',
  'Express',
  'Fastify',
  'Spring Boot',
  'Django',
  'FastAPI',
  'MySQL',
  'PostgreSQL',
  'MongoDB',
  'Redis',
  'Elasticsearch',
  'Docker',
  'Kubernetes',
  'AWS',
  'GCP',
  'Azure',
  'Terraform',
  'GitHub Actions',
  'Nginx',
  'REST',
  'GraphQL',
  'gRPC',
  'WebSocket',
  'Jest',
  'Playwright',
  'Redux',
  'React Query',
  'React Native',
  'Flutter',
  'AI',
  'Machine Learning',
  'Node.js',
  'Tailwind CSS',
  'WebAssembly',
  '게임',
  '소셜',
  '실시간 협업',
];

const queryPool = [
  'review',
  'guide',
  'compare',
  'best-practice',
  'tips',
  'example',
  'tutorial',
];

const random = createXorShift32(seed);
const corpus = Array.from({ length: size }, (_, index) => ({
  blogKey: 'test-blog',
  postUrl:
    `http://127.0.0.1/posts/1?corpus=${index}` +
    `&q=${queryPool[index % queryPool.length]}` +
    `&nonce=${Math.floor(random() * 0xffffffff).toString(16)}`,
  tags: pickUniqueTags(random, 3),
  behaviorScore: Number((20 + random() * 70).toFixed(2)),
  isHighIntent: random() < 0.2,
}));

const serialized = `${JSON.stringify(corpus)}\n`;
const sha256 = createHash('sha256').update(serialized).digest('hex');
const manifestPath = `${outputPath}.manifest.json`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, serialized);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      generator: 'generate_rtb_corpus.mjs',
      seed,
      size,
      sha256,
      output: outputPath,
    },
    null,
    2
  )}\n`
);

process.stdout.write(
  `${JSON.stringify({ outputPath, manifestPath, seed, size, sha256 })}\n`
);

function readPositiveInt(raw, fallback) {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createXorShift32(initialSeed) {
  let state = initialSeed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function pickUniqueTags(randomFn, count) {
  const selected = new Set();
  while (selected.size < count) {
    selected.add(tagPool[Math.floor(randomFn() * tagPool.length)]);
  }
  return [...selected];
}
