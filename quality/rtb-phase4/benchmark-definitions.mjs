export const DATASET_VERSION = 'rtb-phase4-quality-v1';

export const CAMPAIGN_VARIANTS = [
  {
    id: 'guide',
    intent: 'learn',
    label: '실무 가이드',
    copy: '문제를 이해하고 적용할 수 있는 예제와 체크리스트를 제공합니다.',
  },
  {
    id: 'starter',
    intent: 'build',
    label: '구축 스타터',
    copy: '초기 구축과 검증에 필요한 템플릿과 기본 구성을 제공합니다.',
  },
  {
    id: 'diagnostic',
    intent: 'operate',
    label: '운영 진단',
    copy: '운영 병목과 장애 원인을 점검하고 개선 우선순위를 제안합니다.',
  },
  {
    id: 'demo',
    intent: 'buy',
    label: '도입 데모',
    copy: '실제 도입 환경을 기준으로 기능과 비용을 비교할 수 있습니다.',
  },
  {
    id: 'enterprise',
    intent: 'buy',
    label: '엔터프라이즈 패키지',
    copy: '조직 단위 도입과 운영 지원, 보안 요구사항을 함께 제공합니다.',
  },
];

export const THEMES = {
  frontend: {
    label: '프론트엔드',
    product: '웹 UI 개발 패키지',
    coreTags: ['React', 'TypeScript', 'NextJS', 'Tailwind CSS', 'Vite'],
    semanticFocus: '복잡한 웹 화면의 렌더링 비용과 사용자 경험을 개선하는 것',
    exactTopic: 'React와 NextJS 렌더링 성능 최적화',
    problem:
      '화면 전환과 상태 변경 때 불필요한 렌더링이 누적되어 사용자 입력이 늦게 반응한다.',
    strongRelations: ['learning'],
    weakRelations: ['collaboration', 'mobile'],
    trapTheme: 'gaming',
    trapTag: 'React',
  },
  backend: {
    label: '백엔드',
    product: '서버 아키텍처 패키지',
    coreTags: ['NestJS', 'Node.js', 'TypeScript', 'MySQL', 'Redis'],
    semanticFocus:
      '높은 요청량에서도 서버 응답과 데이터 정합성을 안정적으로 유지하는 것',
    exactTopic: 'NestJS API의 이벤트 루프와 Redis 병목 분석',
    problem:
      '동시 요청이 늘면 이벤트 루프 지연과 저장소 왕복이 겹쳐 응답 시간이 급격히 증가한다.',
    strongRelations: ['api'],
    weakRelations: ['data', 'devops'],
    trapTheme: 'gaming',
    trapTag: 'Redis',
  },
  devops: {
    label: 'DevOps',
    product: '클라우드 운영 자동화 패키지',
    coreTags: ['Docker', 'Kubernetes', 'AWS', 'Terraform', 'GitHub Actions'],
    semanticFocus: '배포 재현성과 인프라 운영 안정성을 높이는 것',
    exactTopic: 'Kubernetes와 Terraform 기반 무중단 배포',
    problem:
      '환경별 설정 차이와 수동 배포 때문에 장애 복구 시간이 길어지고 변경 위험이 커진다.',
    strongRelations: ['backend'],
    weakRelations: ['api', 'data'],
    trapTheme: 'ai',
    trapTag: 'Docker',
  },
  ai: {
    label: 'AI',
    product: 'AI 서비스 구축 패키지',
    coreTags: ['Python', 'AI', 'Machine Learning', 'OpenAI', 'PyTorch'],
    catalogExtraTags: ['Docker'],
    semanticFocus:
      '언어 모델과 사내 데이터를 연결해 신뢰할 수 있는 자동화 기능을 만드는 것',
    exactTopic: 'RAG 검색 품질과 LLM 응답 평가',
    problem:
      '모델이 문맥과 무관한 답을 생성하고 평가 기준이 없어 개선 여부를 판단하기 어렵다.',
    strongRelations: ['data'],
    weakRelations: ['backend', 'learning'],
    trapTheme: 'frontend',
    trapTag: 'TypeScript',
  },
  data: {
    label: '데이터',
    product: '데이터 파이프라인 패키지',
    coreTags: ['Python', 'PostgreSQL', 'SQL', 'Redis', 'Elasticsearch'],
    semanticFocus: '분산된 데이터를 신뢰 가능한 분석 정보로 빠르게 변환하는 것',
    exactTopic: 'PostgreSQL 분석 쿼리와 검색 인덱스 최적화',
    problem:
      '수집 지연과 비효율적인 쿼리 때문에 운영 지표가 늦게 도착하고 대시보드가 느리다.',
    strongRelations: ['ai'],
    weakRelations: ['backend', 'devops'],
    trapTheme: 'gaming',
    trapTag: 'Redis',
  },
  collaboration: {
    label: '협업',
    product: '팀 협업 워크스페이스',
    coreTags: ['실시간 협업', 'React', 'TypeScript', 'WebSocket', 'Redis'],
    semanticFocus:
      '여러 사용자가 같은 문맥을 공유하며 충돌 없이 함께 작업하는 것',
    exactTopic: 'WebSocket 기반 실시간 공동 편집과 충돌 해결',
    problem:
      '문서와 대화가 여러 도구에 흩어지고 동시 수정 충돌 때문에 최신 상태를 신뢰하기 어렵다.',
    strongRelations: ['frontend'],
    weakRelations: ['learning', 'backend'],
    trapTheme: 'gaming',
    trapTag: 'WebSocket',
  },
  learning: {
    label: '학습',
    product: '개발자 학습 플랫폼',
    coreTags: ['학습도구', '기록/CS', 'TypeScript', 'React', 'AI'],
    semanticFocus:
      '개발 지식을 단계적으로 익히고 실습 결과를 지속적으로 피드백하는 것',
    exactTopic: '개발자 실습 과정과 AI 학습 피드백 설계',
    problem:
      '자료를 읽기만 하고 실습과 피드백이 연결되지 않아 학습 진도와 이해도를 확인하기 어렵다.',
    strongRelations: ['frontend'],
    weakRelations: ['ai', 'collaboration'],
    trapTheme: 'gaming',
    trapTag: 'React',
  },
  gaming: {
    label: '게임',
    product: '실시간 게임 서비스 패키지',
    coreTags: ['게임', 'Node.js', 'WebSocket', 'Redis', 'AWS'],
    catalogExtraTags: ['React', 'React Native'],
    semanticFocus:
      '많은 플레이어의 실시간 상호작용과 게임 상태를 안정적으로 운영하는 것',
    exactTopic: '멀티플레이 게임의 매치 상태와 실시간 동기화',
    problem:
      '접속자가 몰릴 때 매치 상태가 어긋나고 네트워크 지연으로 플레이 경험이 불안정해진다.',
    strongRelations: ['backend'],
    weakRelations: ['devops', 'mobile'],
    trapTheme: 'collaboration',
    trapTag: 'WebSocket',
  },
  mobile: {
    label: '모바일',
    product: '모바일 앱 출시 패키지',
    coreTags: ['React Native', 'Flutter', 'TypeScript', 'GraphQL', 'Jest'],
    semanticFocus:
      '여러 모바일 플랫폼에서 일관된 사용자 경험과 안정적인 출시 흐름을 만드는 것',
    exactTopic: 'React Native 앱의 렌더링과 배포 자동화',
    problem:
      '플랫폼별 동작 차이와 느린 화면 전환 때문에 QA 범위가 커지고 출시 주기가 길어진다.',
    strongRelations: ['frontend'],
    weakRelations: ['api', 'collaboration'],
    trapTheme: 'gaming',
    trapTag: 'React Native',
  },
  api: {
    label: 'API',
    product: 'API 통합 플랫폼',
    coreTags: ['REST', 'gRPC', 'Swagger', 'Docker', 'Redis'],
    semanticFocus:
      '서비스 사이의 계약을 명확하게 유지하고 안정적으로 통신하는 것',
    exactTopic: 'REST와 gRPC 인터페이스의 계약 및 성능 비교',
    problem:
      '팀마다 다른 명세와 오류 형식을 사용해 연동 실패가 반복되고 변경 영향 범위를 알기 어렵다.',
    strongRelations: ['backend'],
    weakRelations: ['devops', 'mobile'],
    trapTheme: 'gaming',
    trapTag: 'Redis',
  },
};

export const CONTENT_MODES = [
  {
    id: 'exact-learn',
    intent: 'learn',
    tags: 'core',
    title: ({ exactTopic }) => `${exactTopic} 실전 가이드`,
    body: ({ problem }) =>
      `${problem} 이 글은 원인을 측정하고 개선 목표를 달성하기 위한 단계별 접근을 정리한다.`,
  },
  {
    id: 'exact-buy',
    intent: 'buy',
    tags: 'core',
    title: ({ label, product }) =>
      `${label} 솔루션을 도입하기 전에 비교할 기준`,
    body: ({ problem, product }) =>
      `${problem} 직접 구축과 ${product} 도입의 비용, 운영 지원, 전환 위험을 비교한다.`,
  },
  {
    id: 'semantic-paraphrase',
    intent: 'general',
    tags: 'none',
    title: ({ semanticFocus }) => `${semanticFocus}: 문제 중심 설계 원칙`,
    body: ({ problem }) =>
      `${problem} 특정 제품명이나 프레임워크 이름 대신 문제의 구조와 해결 조건을 중심으로 살펴본다.`,
  },
  {
    id: 'tagless-incident',
    intent: 'operate',
    tags: 'none',
    title: ({ label }) => `${label} 서비스가 트래픽 증가 뒤 느려진 장애 회고`,
    body: ({ problem }) =>
      `${problem} 타임라인, 관측 지표, 완화 조치와 재발 방지 기준을 기록한다.`,
  },
  {
    id: 'comparison',
    intent: 'buy',
    tags: 'partial',
    title: ({ product }) => `${product} 직접 구축과 관리형 서비스 비교`,
    body: () =>
      '초기 비용뿐 아니라 목표 달성에 필요한 인력, 장애 대응, 확장 비용을 비교한다.',
  },
  {
    id: 'migration',
    intent: 'build',
    tags: 'partial',
    title: ({ label }) => `기존 ${label} 구조를 중단 없이 교체한 과정`,
    body: ({ problem }) =>
      `${problem} 데이터와 트래픽을 단계적으로 옮기면서 호환성과 rollback을 검증한 방법을 설명한다.`,
  },
  {
    id: 'architecture',
    intent: 'build',
    tags: 'core',
    title: ({ exactTopic }) => `${exactTopic} 아키텍처 결정 기록`,
    body: ({ semanticFocus }) =>
      `${semanticFocus}을 목표로 경계, 상태 소유권, 실패 격리와 확장 방식을 결정한 근거를 남긴다.`,
  },
  {
    id: 'operations',
    intent: 'operate',
    tags: 'partial',
    title: ({ label }) => `${label} 운영에서 먼저 봐야 할 지표와 알림`,
    body: ({ problem }) =>
      `${problem} 증상이 사용자 영향으로 번지기 전에 감지할 지표와 용량 경보를 정리한다.`,
  },
  {
    id: 'beginner',
    intent: 'learn',
    tags: 'core',
    title: ({ exactTopic }) => `${exactTopic}: 처음 배우는 개발자를 위한 실습`,
    body: () =>
      '작은 예제로 시작해 실제 개선 효과까지 확인할 수 있도록 실습 순서와 확인 질문을 제공한다.',
  },
  {
    id: 'multi-topic',
    intent: 'general',
    tags: 'mixed',
    title: ({ label }) => `${label} 문제를 인접 시스템과 함께 해결한 사례`,
    body: ({ problem, semanticFocus }) =>
      `${problem} 한 계층만 바꾸지 않고 인접 시스템의 제약과 ${semanticFocus}을 함께 고려한다.`,
  },
  {
    id: 'lexical-trap',
    intent: 'general',
    tags: 'trap',
    title: ({ trapTag, label }) =>
      `${trapTag}를 언급하지만 핵심은 ${label} 설계인 글`,
    body: ({ trapTag, semanticFocus }) =>
      `${trapTag}는 구현 도구로 한 번 사용될 뿐이다. 글의 실제 목적은 ${semanticFocus}이며 같은 단어를 쓰는 다른 상품을 찾는 것이 아니다.`,
  },
  {
    id: 'high-intent',
    intent: 'buy',
    tags: 'partial',
    title: ({ product }) =>
      `${product} 견적과 PoC 범위를 요청하기 위한 체크리스트`,
    body: ({ problem }) =>
      `${problem} 현재 요구사항과 예상 트래픽을 기준으로 데모, PoC, 기술 지원 범위를 확인하려 한다.`,
  },
];

export const OUT_OF_DOMAIN_CONTENTS = [
  [
    'sourdough',
    '천연 발효종으로 사워도우 굽기',
    '반죽의 수분율과 발효 온도에 따른 빵의 풍미를 비교한다.',
  ],
  [
    'travel',
    '겨울 홋카이도 기차 여행 준비',
    '철도 패스와 숙소, 방한 장비를 중심으로 일정을 정리한다.',
  ],
  [
    'gardening',
    '베란다에서 바질과 로즈메리 키우기',
    '햇빛과 물주기 주기, 흙 배합을 기록한다.',
  ],
  [
    'coffee',
    '가정용 에스프레소 추출 변수 실험',
    '원두 분쇄도와 물 온도에 따른 맛의 차이를 비교한다.',
  ],
  [
    'running',
    '첫 하프 마라톤을 위한 12주 훈련',
    '주간 거리와 회복, 부상 방지 계획을 세운다.',
  ],
  [
    'photography',
    '야간 인물 사진의 조명 배치',
    '카메라 노출과 소형 조명의 각도를 실험한다.',
  ],
  [
    'finance',
    '월별 생활비 예산을 점검하는 방법',
    '고정비와 변동비를 나누고 저축 목표를 조정한다.',
  ],
  [
    'music',
    '재즈 피아노 보이싱 연습 기록',
    '왼손 보이싱과 리듬 패턴을 반복 연습한다.',
  ],
  [
    'pet',
    '노령견의 산책 시간 조절',
    '관절 상태와 날씨에 따라 운동량을 조절한다.',
  ],
  [
    'pottery',
    '물레 성형에서 그릇 두께 맞추기',
    '점토의 수분과 손의 압력을 일정하게 유지하는 법을 설명한다.',
  ],
];
