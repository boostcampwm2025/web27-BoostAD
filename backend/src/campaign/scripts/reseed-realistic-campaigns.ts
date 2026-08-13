import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { resolveEmbeddingQueueName } from '../../queue/queue.names';
import {
  resolveEmbeddingProfile,
  toEmbeddingNamespace,
} from '../../rtb/ml/embedding-profile';
import { DataSource, In } from 'typeorm';
import { AVAILABLE_TAGS } from '../../common/constants';
import { CampaignEntity, CampaignStatus } from '../entities/campaign.entity';
import { TagEntity } from '../../tag/entities/tag.entity';
import { UserEntity } from '../../user/entities/user.entity';

config({ path: join(__dirname, '../../../.env') });

type ThemeId =
  | 'frontend'
  | 'backend'
  | 'devops'
  | 'ai'
  | 'data'
  | 'collaboration'
  | 'learning'
  | 'gaming'
  | 'mobile'
  | 'api';

type Theme = {
  id: ThemeId;
  route: string;
  offerObjects: string[];
  lowIntentOffers: string[];
  highIntentOffers: string[];
  benefitPhrases: string[];
  tagSets: string[][];
  optionalTags: string[];
  cpcRange: [number, number];
  dailyBudgetRange: [number, number];
  durationDaysRange: [number, number];
};

type AdvertiserProfile = {
  userId: number;
  brand: string;
  host: string;
  themes: ThemeId[];
};

type CampaignSeed = {
  userId: number;
  title: string;
  content: string;
  image: string;
  url: string;
  maxCpc: number;
  dailyBudget: number;
  totalBudget: number;
  isHighIntent: boolean;
  status: CampaignStatus;
  startDate: Date;
  endDate: Date;
  lastResetDate: Date;
  tags: string[];
};

const CAMPAIGN_CACHE_TTL_SECONDS = 60 * 60 * 24;
const REDIS_CLEANUP_PATTERNS = [
  'campaign:*',
  'auction:*',
  'rollback:view:*',
  'backup:rollback:view:*',
  'dedup:view:*',
  'dedup:click:*',
];

const THEMES: Record<ThemeId, Theme> = {
  frontend: {
    id: 'frontend',
    route: 'frontend',
    offerObjects: [
      'React 보일러플레이트',
      'UI 키트',
      '대시보드 템플릿',
      'SSR 스타터',
      '컴포넌트 팩',
    ],
    lowIntentOffers: ['가이드', '튜토리얼', '샘플킷', '웨비나', '체크리스트'],
    highIntentOffers: ['도입 상담', '무료 데모', '견적 상담', '전환 랜딩', 'PoC 제안'],
    benefitPhrases: [
      '초기 구축 시간을 줄이는 실무 템플릿입니다.',
      '운영 화면을 빠르게 검증할 수 있는 구성입니다.',
      '프론트엔드 팀의 반복 작업을 줄이는 패키지입니다.',
      '디자인 시스템과 배포 흐름을 함께 정리한 상품입니다.',
    ],
    tagSets: [
      ['React', 'TypeScript', 'NextJS', 'Tailwind CSS', 'Vite'],
      ['React', 'JavaScript', 'Redux', 'React Query', 'CSS'],
      ['NextJS', 'TypeScript', 'SWR', 'HTML', 'CSS'],
      ['React', 'Vite', 'ESLint', 'Prettier', 'pnpm'],
      ['TypeScript', 'React', 'Jest', 'Playwright', 'GitHub Actions'],
    ],
    optionalTags: ['Node.js', 'GitHub', 'HTML', 'CSS', 'JavaScript'],
    cpcRange: [400, 1200],
    dailyBudgetRange: [20000, 120000],
    durationDaysRange: [45, 120],
  },
  backend: {
    id: 'backend',
    route: 'backend',
    offerObjects: [
      'API 플랫폼',
      '백엔드 스타터',
      '서비스 템플릿',
      '어드민 API',
      '데이터 파이프라인',
    ],
    lowIntentOffers: ['구축 가이드', '실무 예제', '샘플 코드', '기술 브리프', '워크숍'],
    highIntentOffers: ['도입 문의', '기술 상담', '엔터프라이즈 데모', '견적 비교', 'PoC 제안'],
    benefitPhrases: [
      '운영 환경에 맞춘 API 구조를 바로 검증할 수 있습니다.',
      '장애 대응과 배포 편의성을 함께 고려한 구성이 포함됩니다.',
      '실서비스 전환 전 아키텍처를 빠르게 검토하기 좋습니다.',
      '팀 내 표준 백엔드 구조를 통일하기 위한 제안입니다.',
    ],
    tagSets: [
      ['NestJS', 'Node.js', 'TypeScript', 'MySQL', 'Redis'],
      ['Express', 'JavaScript', 'MySQL', 'Redis', 'Docker'],
      ['Spring Boot', 'Java', 'MySQL', 'Redis', 'Docker'],
      ['FastAPI', 'Python', 'PostgreSQL', 'Redis', 'Docker'],
      ['Gin', 'Go', 'MySQL', 'Redis', 'Nginx'],
    ],
    optionalTags: ['REST', 'Swagger', 'Docker', 'PostgreSQL', 'Node.js'],
    cpcRange: [500, 1500],
    dailyBudgetRange: [30000, 150000],
    durationDaysRange: [60, 150],
  },
  devops: {
    id: 'devops',
    route: 'devops',
    offerObjects: [
      '인프라 패키지',
      '배포 자동화',
      '클라우드 런치팩',
      'K8s 운영킷',
      'SRE 스타터',
    ],
    lowIntentOffers: ['체크리스트', '운영 가이드', '진단 세션', '샘플 파이프라인', '웨비나'],
    highIntentOffers: ['비용 진단', '전환 상담', '데모 요청', '엔터프라이즈 제안', '도입 상담'],
    benefitPhrases: [
      '배포 표준화와 비용 통제를 동시에 검토할 수 있습니다.',
      '운영 자동화 범위를 빠르게 정의하기 위한 제안입니다.',
      '클라우드 전환 전에 필요한 기준 구성을 묶어두었습니다.',
      '인프라 변경 리스크를 줄이기 위한 운영 패키지입니다.',
    ],
    tagSets: [
      ['Docker', 'Kubernetes', 'AWS', 'Terraform', 'GitHub Actions'],
      ['AWS', 'Nginx', 'Redis', 'Ansible', 'Jenkins'],
      ['GCP', 'Kubernetes', 'Docker', 'Terraform', 'GitLab CI'],
      ['Azure', 'Docker', 'GitHub Actions', 'Nginx', 'Redis'],
      ['Kubernetes', 'AWS', 'Redis', 'Nginx', 'Apache'],
    ],
    optionalTags: ['Docker', 'Kubernetes', 'AWS', 'Terraform', 'Redis'],
    cpcRange: [700, 1800],
    dailyBudgetRange: [40000, 180000],
    durationDaysRange: [60, 180],
  },
  ai: {
    id: 'ai',
    route: 'ai',
    offerObjects: [
      'LLM 워크플로',
      'AI 에이전트',
      '모델 서빙팩',
      'RAG 스타터',
      '추천 엔진',
    ],
    lowIntentOffers: ['사례집', '실습 세션', '샘플 프로젝트', '가이드', '튜토리얼'],
    highIntentOffers: ['무료 진단', 'PoC 상담', '데모 요청', 'ROI 상담', '전환 상담'],
    benefitPhrases: [
      '생산성 실험을 빠르게 진행할 수 있는 구성을 제공합니다.',
      '사내 데이터와 모델 활용 범위를 검증하기 좋습니다.',
      'AI 기능을 기존 서비스에 붙이는 흐름을 단축할 수 있습니다.',
      '실험 단계에서 운영 전환까지 고려한 제안입니다.',
    ],
    tagSets: [
      ['Python', 'AI', 'Machine Learning', 'OpenAI', 'PyTorch'],
      ['Python', 'AI', 'TensorFlow', 'Machine Learning', 'Docker'],
      ['OpenAI', 'FastAPI', 'Python', 'Redis', 'PostgreSQL'],
      ['AI', 'Node.js', 'TypeScript', 'OpenAI', 'NextJS'],
      ['Machine Learning', 'Python', 'Elasticsearch', 'Docker', 'AWS'],
    ],
    optionalTags: ['OpenAI', 'Redis', 'Docker', 'Python', 'NextJS'],
    cpcRange: [800, 2200],
    dailyBudgetRange: [50000, 220000],
    durationDaysRange: [45, 150],
  },
  data: {
    id: 'data',
    route: 'data',
    offerObjects: [
      '데이터 스택',
      '분석 대시보드',
      '수집 파이프라인',
      '리포팅 자동화',
      '데이터 마트',
    ],
    lowIntentOffers: ['설계 가이드', '사례 공유', '샘플 리포트', '체크리스트', '워크숍'],
    highIntentOffers: ['구축 상담', '데모 세션', '비용 상담', '전환 제안', '무료 진단'],
    benefitPhrases: [
      '분산된 운영 지표를 한 흐름으로 묶기 위한 상품입니다.',
      '리포트 작성 비용을 줄이는 자동화 구성을 담았습니다.',
      '분석 적재와 조회 성능을 함께 검토할 수 있는 제안입니다.',
      '데이터팀과 서비스팀이 같이 보기 좋은 구조를 제공합니다.',
    ],
    tagSets: [
      ['Python', 'PostgreSQL', 'SQL', 'Redis', 'Elasticsearch'],
      ['MySQL', 'SQL', 'Redis', 'Docker', 'GitHub Actions'],
      ['PostgreSQL', 'Elasticsearch', 'Python', 'Machine Learning', 'Docker'],
      ['MongoDB', 'Node.js', 'Redis', 'GraphQL', 'TypeScript'],
      ['DynamoDB', 'AWS', 'Python', 'REST', 'Terraform'],
    ],
    optionalTags: ['SQL', 'MySQL', 'PostgreSQL', 'Redis', 'Python'],
    cpcRange: [600, 1700],
    dailyBudgetRange: [35000, 170000],
    durationDaysRange: [50, 150],
  },
  collaboration: {
    id: 'collaboration',
    route: 'collaboration',
    offerObjects: [
      '협업 워크스페이스',
      '브라우저 확장팩',
      '문서 협업툴',
      '팀 운영허브',
      '실시간 코멘트킷',
    ],
    lowIntentOffers: ['사용 가이드', '업무 템플릿', '튜토리얼', '샘플 보드', '베스트 프랙티스'],
    highIntentOffers: ['전환 상담', '팀 데모', '요금 상담', '도입 진단', '무료 체험'],
    benefitPhrases: [
      '원격 협업 흐름을 빠르게 정리할 수 있는 구성을 제공합니다.',
      '실시간 편집과 알림 기능을 한 번에 검토하기 좋습니다.',
      '분산된 업무 맥락을 한 화면에 모으는 제안입니다.',
      '팀 커뮤니케이션 병목을 줄이는 운영형 상품입니다.',
    ],
    tagSets: [
      ['실시간 협업', 'React', 'TypeScript', 'WebSocket', 'Redis'],
      ['확장프로그램', 'React', 'TypeScript', '소셜', 'GitHub'],
      ['소셜', 'NextJS', 'GraphQL', 'React Query', 'CSS'],
      ['기록/CS', 'React', 'SWR', 'Node.js', 'Redis'],
      ['실시간 협업', 'NestJS', 'WebSocket', 'Redis', 'TypeScript'],
    ],
    optionalTags: ['GitHub', 'React', 'TypeScript', 'Node.js', 'GraphQL'],
    cpcRange: [500, 1400],
    dailyBudgetRange: [25000, 130000],
    durationDaysRange: [45, 120],
  },
  learning: {
    id: 'learning',
    route: 'learning',
    offerObjects: [
      '학습 플랫폼',
      'CS 노트팩',
      '실습 트랙',
      '커리큘럼 키트',
      '스터디 허브',
    ],
    lowIntentOffers: ['무료 강의', '입문 가이드', '튜토리얼', '체험 강좌', '샘플 레슨'],
    highIntentOffers: ['수강 상담', 'B2B 제안', '교육 데모', '무료 상담', '도입 문의'],
    benefitPhrases: [
      '학습 전환율을 높이기 위한 실습형 랜딩 구성을 제공합니다.',
      '초보자 유입부터 팀 교육까지 연결되는 상품입니다.',
      '기술 콘텐츠를 실습 과제로 확장하기 좋은 패키지입니다.',
      '교육 운영 비용을 줄이도록 콘텐츠 구성을 단순화했습니다.',
    ],
    tagSets: [
      ['학습도구', 'React', 'TypeScript', 'NextJS', 'AI'],
      ['기록/CS', 'React', 'NextJS', 'SQL', 'GitHub'],
      ['학습도구', 'Python', 'AI', 'Machine Learning', 'OpenAI'],
      ['학습도구', 'TypeScript', 'NestJS', 'MySQL', 'Redis'],
      ['기록/CS', 'React', 'Tailwind CSS', 'Jest', 'Playwright'],
    ],
    optionalTags: ['학습도구', '기록/CS', 'TypeScript', 'React', 'AI'],
    cpcRange: [300, 1000],
    dailyBudgetRange: [15000, 90000],
    durationDaysRange: [30, 120],
  },
  gaming: {
    id: 'gaming',
    route: 'gaming',
    offerObjects: [
      '게임 런치팩',
      '메타버스 허브',
      '시뮬레이터 스튜디오',
      '실시간 매치팩',
      '커뮤니티 시즌패스',
    ],
    lowIntentOffers: ['트레일러', '사전예약 가이드', '체험판', '티저 캠페인', '런칭 노트'],
    highIntentOffers: ['사전등록', '무료 체험', '시즌 오픈', '런칭 데모', '프로모션 문의'],
    benefitPhrases: [
      '커뮤니티 확장과 실시간 참여를 동시에 노리는 상품입니다.',
      '런칭 직전 모객 성능을 검증하기 위한 전환형 캠페인입니다.',
      '게임 유저의 체류 시간을 높이는 경험형 구성입니다.',
      '소셜 확산과 시즌 이벤트 운영을 함께 고려한 상품입니다.',
    ],
    tagSets: [
      ['게임', 'Node.js', 'WebSocket', 'Redis', 'AWS'],
      ['메타버스', 'React', 'WebSocket', 'Node.js', 'AWS'],
      ['시뮬레이터', 'Rust', 'WebAssembly', 'C++', 'Docker'],
      ['게임', 'C#', 'AWS', 'Redis', '소셜'],
      ['메타버스', '소셜', 'React Native', 'AWS', 'GraphQL'],
    ],
    optionalTags: ['게임', '메타버스', 'WebSocket', 'AWS', '소셜'],
    cpcRange: [400, 1300],
    dailyBudgetRange: [20000, 140000],
    durationDaysRange: [30, 120],
  },
  mobile: {
    id: 'mobile',
    route: 'mobile',
    offerObjects: [
      '모바일 스타터',
      '앱 온보딩팩',
      '크로스플랫폼 킷',
      '앱 QA 패키지',
      '모바일 전환팩',
    ],
    lowIntentOffers: ['샘플 앱', '실무 가이드', '튜토리얼', '체험판', '워크숍'],
    highIntentOffers: ['앱 데모', '전환 상담', '출시 제안', '무료 진단', 'PoC 상담'],
    benefitPhrases: [
      '모바일 출시 직전 필요한 핵심 화면을 빠르게 검증할 수 있습니다.',
      '크로스플랫폼 전환 비용을 줄이기 위한 실무형 패키지입니다.',
      '앱 팀의 QA와 배포 루틴을 함께 정리하는 제안입니다.',
      '모바일 사용자 온보딩을 개선하기 좋은 전환형 구성입니다.',
    ],
    tagSets: [
      ['React Native', 'TypeScript', 'GraphQL', 'Redux', 'Jest'],
      ['Flutter', 'REST', 'SQLite', 'GitHub Actions', 'Playwright'],
      ['Swift', 'REST', 'SQLite', 'GitHub', 'CSS'],
      ['Kotlin', 'REST', 'SQL', 'GitHub Actions', 'Jest'],
      ['React Native', 'TypeScript', 'REST', 'MobX', 'SWR'],
    ],
    optionalTags: ['React Native', 'Flutter', 'GraphQL', 'REST', 'TypeScript'],
    cpcRange: [500, 1500],
    dailyBudgetRange: [25000, 140000],
    durationDaysRange: [45, 140],
  },
  api: {
    id: 'api',
    route: 'api',
    offerObjects: [
      'API 게이트웨이',
      '통합 인터페이스',
      '서비스 메시팩',
      '연동 스타터',
      '프로토콜 전환킷',
    ],
    lowIntentOffers: ['설계 가이드', '실습 세션', '샘플 명세', '튜토리얼', '베스트 프랙티스'],
    highIntentOffers: ['기술 상담', '도입 문의', 'PoC 제안', '무료 데모', '견적 상담'],
    benefitPhrases: [
      '팀 간 인터페이스 차이를 줄이기 위한 제안입니다.',
      '연동 실패 비용을 줄이는 표준 명세 구성을 제공합니다.',
      '프로토콜 전환 전에 성능과 운영성을 함께 검토하기 좋습니다.',
      '내부 API 계약을 정리하기 위한 실무형 패키지입니다.',
    ],
    tagSets: [
      ['Go', 'gRPC', 'Docker', 'Kubernetes', 'Nginx'],
      ['REST', 'Swagger', 'Postman', 'NestJS', 'TypeScript'],
      ['GraphQL', 'Node.js', 'Redis', 'PostgreSQL', 'Docker'],
      ['gRPC', 'Go', 'Redis', 'MySQL', 'Docker'],
      ['REST', 'FastAPI', 'Python', 'PostgreSQL', 'Redis'],
    ],
    optionalTags: ['REST', 'gRPC', 'Swagger', 'Docker', 'Redis'],
    cpcRange: [700, 1900],
    dailyBudgetRange: [30000, 180000],
    durationDaysRange: [45, 150],
  },
};

const ADVERTISER_PROFILES: AdvertiserProfile[] = [
  {
    userId: 1,
    brand: 'FlowForge',
    host: 'flowforge.dev',
    themes: ['frontend', 'learning', 'collaboration', 'api'],
  },
  {
    userId: 2,
    brand: 'InfraPilot',
    host: 'infrapilot.io',
    themes: ['backend', 'devops', 'data', 'api'],
  },
  {
    userId: 3,
    brand: 'DataCanvas',
    host: 'datacanvas.ai',
    themes: ['ai', 'data', 'backend', 'api'],
  },
  {
    userId: 4,
    brand: 'TeamSync',
    host: 'teamsync.app',
    themes: ['collaboration', 'learning', 'frontend', 'mobile'],
  },
  {
    userId: 5,
    brand: 'GameVerse',
    host: 'gameverse.gg',
    themes: ['gaming', 'frontend', 'mobile', 'collaboration'],
  },
  {
    userId: 6,
    brand: 'MobileStack',
    host: 'mobilestack.dev',
    themes: ['mobile', 'frontend', 'api', 'backend'],
  },
  {
    userId: 7,
    brand: 'QueryWorks',
    host: 'queryworks.io',
    themes: ['data', 'backend', 'devops', 'ai'],
  },
  {
    userId: 8,
    brand: 'CodeBridge',
    host: 'codebridge.school',
    themes: ['learning', 'ai', 'frontend', 'collaboration'],
  },
  {
    userId: 9,
    brand: 'LaunchKit',
    host: 'launchkit.dev',
    themes: ['frontend', 'backend', 'devops', 'api'],
  },
  {
    userId: 10,
    brand: 'ProtoBase',
    host: 'protobase.io',
    themes: ['mobile', 'ai', 'data', 'gaming'],
  },
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
}

function buildRange(start: number, end: number): number[] {
  if (end < start) {
    return [];
  }

  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function createRng(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }

  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function pickOne<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

function pickUnique<T>(items: T[], count: number, rng: () => number): T[] {
  const pool = [...items];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }

  return pool.slice(0, Math.min(count, pool.length));
}

function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function buildSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function steppedRandom(
  min: number,
  max: number,
  step: number,
  rng: () => number
): number {
  const slots = Math.floor((max - min) / step);
  const offset = Math.floor(rng() * (slots + 1)) * step;
  return min + offset;
}

function addDays(baseDate: Date, days: number): Date {
  const next = new Date(baseDate);
  next.setDate(next.getDate() + days);
  return next;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function validateThemeTags(): void {
  const tagNameSet = new Set(AVAILABLE_TAGS.map((tag) => tag.name));

  for (const theme of Object.values(THEMES)) {
    const tags = [...theme.tagSets.flat(), ...theme.optionalTags];
    for (const tagName of tags) {
      if (!tagNameSet.has(tagName)) {
        throw new Error(
          `[seed] theme=${theme.id} references unknown tag "${tagName}"`
        );
      }
    }
  }
}

function buildCampaignTags(
  profile: AdvertiserProfile,
  theme: Theme,
  campaignIndex: number,
  rng: () => number
): string[] {
  const baseTagSet =
    theme.tagSets[(campaignIndex + profile.userId) % theme.tagSets.length];
  const tags = [...baseTagSet];

  if ((campaignIndex + profile.userId) % 2 === 0) {
    tags.push(pickOne(theme.optionalTags, rng));
  }

  if ((campaignIndex + profile.userId) % 5 === 0) {
    const secondaryThemeId =
      profile.themes[(campaignIndex + 1) % profile.themes.length];
    const secondaryTheme = THEMES[secondaryThemeId];
    const secondarySet =
      secondaryTheme.tagSets[
        (campaignIndex + profile.userId) % secondaryTheme.tagSets.length
      ];
    tags.push(pickOne(secondarySet, rng));
  }

  return unique(tags).slice(0, 6);
}

function buildTitle(
  profile: AdvertiserProfile,
  theme: Theme,
  isHighIntent: boolean,
  rng: () => number
): string {
  const offerObject = pickOne(theme.offerObjects, rng);
  const offerType = pickOne(
    isHighIntent ? theme.highIntentOffers : theme.lowIntentOffers,
    rng
  );

  return clampText(`${profile.brand} ${offerObject} ${offerType}`, 30);
}

function buildContent(
  tags: string[],
  theme: Theme,
  isHighIntent: boolean,
  rng: () => number
): string {
  const leadingTags = tags.slice(0, 2).join('·');
  const benefit = pickOne(theme.benefitPhrases, rng);
  const callToAction = isHighIntent
    ? '비교표와 데모 요청 흐름까지 바로 연결됩니다.'
    : '실무 예제와 체크리스트를 바로 확인할 수 있습니다.';

  return clampText(`${leadingTags} 기반 상품입니다. ${benefit} ${callToAction}`, 100);
}

function buildCampaignSeed(
  profile: AdvertiserProfile,
  theme: Theme,
  campaignIndex: number,
  rng: () => number
): CampaignSeed {
  const isHighIntent = (campaignIndex + profile.userId * 3) % 5 === 0;
  const tags = buildCampaignTags(profile, theme, campaignIndex, rng);
  const today = new Date();
  const startDate = addDays(today, -steppedRandom(5, 30, 1, rng));
  const endDate = addDays(
    today,
    steppedRandom(
      theme.durationDaysRange[0],
      theme.durationDaysRange[1],
      1,
      rng
    )
  );
  const maxCpc = steppedRandom(
    theme.cpcRange[0],
    theme.cpcRange[1],
    100,
    rng
  );
  const dailyBudget = steppedRandom(
    theme.dailyBudgetRange[0],
    theme.dailyBudgetRange[1],
    1000,
    rng
  );
  const totalBudgetMultiplier = steppedRandom(20, 90, 5, rng);
  const totalBudget = Math.max(dailyBudget * 2, dailyBudget * totalBudgetMultiplier);
  const campaignNumber = campaignIndex + 1;
  const slugBase = buildSlug(`${profile.brand}-${theme.id}-${campaignNumber}`);
  const title = buildTitle(profile, theme, isHighIntent, rng);
  const content = buildContent(tags, theme, isHighIntent, rng);

  return {
    userId: profile.userId,
    title,
    content,
    image: `https://cdn.boostad.dev/campaigns/${theme.route}/${slugBase}.jpg`,
    url: `https://${profile.host}/${theme.route}/${isHighIntent ? 'demo' : 'guide'}/${slugBase}`,
    maxCpc,
    dailyBudget,
    totalBudget,
    isHighIntent,
    status: CampaignStatus.ACTIVE,
    startDate,
    endDate,
    lastResetDate: today,
    tags,
  };
}

function buildSeedCampaigns(
  targetUserIds: number[],
  campaignsPerUser: number,
  seed: number
): CampaignSeed[] {
  const rng = createRng(seed);
  const profiles = ADVERTISER_PROFILES.filter((profile) =>
    targetUserIds.includes(profile.userId)
  );
  const campaigns: CampaignSeed[] = [];

  for (const profile of profiles) {
    for (let campaignIndex = 0; campaignIndex < campaignsPerUser; campaignIndex += 1) {
      const theme = THEMES[profile.themes[campaignIndex % profile.themes.length]];
      campaigns.push(buildCampaignSeed(profile, theme, campaignIndex, rng));
    }
  }

  return campaigns;
}

function printSummary(campaigns: CampaignSeed[]): void {
  const highIntentCount = campaigns.filter(
    (campaign) => campaign.isHighIntent
  ).length;
  const tagCountAverage = (
    campaigns.reduce((sum, campaign) => sum + campaign.tags.length, 0) /
    Math.max(campaigns.length, 1)
  ).toFixed(2);

  console.log(`- 생성 대상 캠페인: ${campaigns.length}개`);
  console.log(`- 고의도 캠페인: ${highIntentCount}개`);
  console.log(`- 일반 캠페인: ${campaigns.length - highIntentCount}개`);
  console.log(`- 캠페인당 평균 태그 수: ${tagCountAverage}`);

  for (const profile of ADVERTISER_PROFILES) {
    const userCampaigns = campaigns.filter(
      (campaign) => campaign.userId === profile.userId
    );
    if (userCampaigns.length === 0) {
      continue;
    }

    const sampleTitles = userCampaigns
      .slice(0, 3)
      .map((campaign) => campaign.title)
      .join(' | ');

    console.log(
      `  - user ${profile.userId} (${profile.brand}): ${userCampaigns.length}개 / 예시: ${sampleTitles}`
    );
  }
}

function toCachedCampaign(campaign: CampaignEntity) {
  return {
    id: campaign.id,
    userId: campaign.userId,
    title: campaign.title,
    content: campaign.content,
    image: campaign.image,
    url: campaign.url,
    maxCpc: campaign.maxCpc,
    dailyBudget: campaign.dailyBudget,
    totalBudget: campaign.totalBudget ?? null,
    dailySpent: campaign.dailySpent,
    totalSpent: campaign.totalSpent,
    lastResetDate: campaign.lastResetDate.toISOString(),
    isHighIntent: campaign.isHighIntent,
    status: campaign.status,
    startDate: campaign.startDate.toISOString(),
    endDate: campaign.endDate.toISOString(),
    createdAt: campaign.createdAt.toISOString(),
    deletedAt: campaign.deletedAt ? campaign.deletedAt.toISOString() : null,
    tags: campaign.tags.map((tag) => tag.name),
  };
}

async function deleteKeysByPattern(redis: Redis, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;

  do {
    const [nextCursor, keys] = (await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      200
    )) as [string, string[]];

    cursor = nextCursor;

    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');

  return deleted;
}

async function syncRedisAndQueue(
  campaigns: CampaignEntity[],
  syncRedis: boolean,
  enqueueEmbeddings: boolean
): Promise<void> {
  if (enqueueEmbeddings && !syncRedis) {
    throw new Error(
      'SEED_ENQUEUE_EMBEDDINGS=true requires SEED_SYNC_REDIS=true because worker reads campaign tags from Redis.'
    );
  }

  if (!syncRedis) {
    return;
  }

  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: envInt('REDIS_PORT', 16379),
  });

  const embeddingProfile = resolveEmbeddingProfile(
    process.env.RTB_EMBEDDING_PROFILE
  );
  const queue = new Queue(resolveEmbeddingQueueName(
    process.env.RTB_EMBEDDING_PROFILE,
    process.env.RTB_EMBEDDING_QUEUE_NAME
  ), {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: envInt('REDIS_PORT', 16379),
    },
  });

  try {
    let cleanedKeys = 0;
    for (const pattern of REDIS_CLEANUP_PATTERNS) {
      cleanedKeys += await deleteKeysByPattern(redis, pattern);
    }

    for (let index = 0; index < campaigns.length; index += 50) {
      const batch = campaigns.slice(index, index + 50);
      const pipeline = redis.pipeline();

      for (const campaign of batch) {
        const key = `campaign:${campaign.id}`;
        pipeline.call('JSON.SET', key, '$', JSON.stringify(toCachedCampaign(campaign)));
        pipeline.expire(key, CAMPAIGN_CACHE_TTL_SECONDS);
        pipeline.sadd('campaign:keys', key);
      }

      await pipeline.exec();
    }

    console.log(`✅ Redis 캠페인 캐시 동기화 완료: ${campaigns.length}개`);
    console.log(`- 정리한 Redis 키 수: ${cleanedKeys}`);

    if (enqueueEmbeddings) {
      await queue.addBulk(
        campaigns.map((campaign) => ({
          name: 'generate-campaign-embedding',
          data: {
            campaignId: campaign.id,
            modelVersion: embeddingProfile.modelVersion,
          },
          opts: {
            jobId: `campaign-embedding-${toEmbeddingNamespace(
              embeddingProfile.modelVersion
            )}-${campaign.id}`,
            removeOnComplete: true,
            removeOnFail: false,
            attempts: 3,
          },
        }))
      );

      console.log(`✅ 임베딩 큐 적재 완료: ${campaigns.length}개`);
    }
  } finally {
    await queue.close();
    await redis.quit();
  }
}

async function reseedCampaigns(): Promise<void> {
  const userStart = envInt('SEED_USER_START', 1);
  const userEnd = envInt('SEED_USER_END', 10);
  const campaignsPerUser = envInt('SEED_CAMPAIGNS_PER_USER', 50);
  const seed = envInt('SEED_RANDOM_SEED', 20260306);
  const dryRun = envBool('SEED_DRY_RUN', false);
  const syncRedis = envBool('SEED_SYNC_REDIS', true);
  const enqueueEmbeddings = envBool('SEED_ENQUEUE_EMBEDDINGS', true);
  const targetUserIds = buildRange(userStart, userEnd);

  if (targetUserIds.length === 0) {
    throw new Error('SEED_USER_START/SEED_USER_END range is empty.');
  }

  validateThemeTags();

  const campaigns = buildSeedCampaigns(targetUserIds, campaignsPerUser, seed);

  console.log('🚀 현실형 캠페인 reseed 시작');
  console.log(`- 대상 사용자: ${targetUserIds.join(', ')}`);
  console.log(`- 사용자당 캠페인 수: ${campaignsPerUser}`);
  console.log(`- 랜덤 시드: ${seed}`);
  printSummary(campaigns);

  const dataSource = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: envInt('DB_PORT', 3306),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'database',
    entities: [join(__dirname, '../../**/*.entity{.ts,.js}')],
    synchronize: false,
    logging: false,
    timezone: '+09:00',
  });

  await dataSource.initialize();

  try {
    const userRepo = dataSource.getRepository(UserEntity);
    const existingUsers = await userRepo.find({
      where: { id: In(targetUserIds) },
      order: { id: 'ASC' },
    });
    const existingUserIds = new Set(existingUsers.map((user) => user.id));
    const missingUserIds = targetUserIds.filter((userId) => !existingUserIds.has(userId));

    if (missingUserIds.length > 0) {
      throw new Error(`Users not found: ${missingUserIds.join(', ')}`);
    }

    if (dryRun) {
      console.log('ℹ️ SEED_DRY_RUN=true, DB/Redis 변경 없이 종료합니다.');
      return;
    }

    await dataSource.transaction(async (manager) => {
      console.log('🧹 기존 캠페인/로그/태그 정리 중...');
      await manager.query('DELETE FROM ClickLog');
      await manager.query('DELETE FROM ViewLog');
      await manager.query('DELETE FROM BidLog');
      await manager.query(
        'UPDATE CreditHistory SET campaign_id = NULL WHERE campaign_id IS NOT NULL'
      );
      await manager.query('DELETE FROM CampaignTag');
      await manager.query('DELETE FROM Campaign');
      await manager.query('DELETE FROM Tag');

      const tagRepo = manager.getRepository(TagEntity);
      await tagRepo.insert(
        AVAILABLE_TAGS.map((tag) => ({
          id: tag.id,
          name: tag.name,
        }))
      );

      const tagEntities = await tagRepo.find();
      const tagByName = new Map(tagEntities.map((tag) => [tag.name, tag]));

      const campaignRepo = manager.getRepository(CampaignEntity);
      const campaignEntities = campaigns.map((campaign) =>
        campaignRepo.create({
          id: randomUUID(),
          userId: campaign.userId,
          title: campaign.title,
          content: campaign.content,
          image: campaign.image,
          url: campaign.url,
          maxCpc: campaign.maxCpc,
          dailyBudget: campaign.dailyBudget,
          totalBudget: campaign.totalBudget,
          dailySpent: 0,
          totalSpent: 0,
          lastResetDate: campaign.lastResetDate,
          isHighIntent: campaign.isHighIntent,
          status: campaign.status,
          startDate: campaign.startDate,
          endDate: campaign.endDate,
          tags: campaign.tags.map((tagName) => {
            const tag = tagByName.get(tagName);
            if (!tag) {
              throw new Error(`Tag not found during reseed: ${tagName}`);
            }
            return tag;
          }),
        })
      );

      await campaignRepo.save(campaignEntities, { chunk: 100 });
      console.log(`✅ DB 캠페인 재생성 완료: ${campaignEntities.length}개`);
    });

    const insertedCampaigns = await dataSource.getRepository(CampaignEntity).find({
      relations: ['tags'],
      order: { userId: 'ASC', createdAt: 'ASC' },
    });

    await syncRedisAndQueue(insertedCampaigns, syncRedis, enqueueEmbeddings);

    console.log('🎯 reseed 완료');
    console.log('- backend 프로세스가 이미 떠 있었다면 in-memory allCampaigns cache가 최대 10초간 남을 수 있습니다.');
    console.log('- worker가 떠 있어야 embeddingTags가 채워지고 RTB match path가 정상 동작합니다.');
  } finally {
    await dataSource.destroy();
  }
}

reseedCampaigns().catch((error) => {
  console.error('❌ 현실형 캠페인 reseed 실패:', error);
  process.exit(1);
});
