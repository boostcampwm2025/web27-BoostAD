import { createHash } from 'node:crypto';
import {
  CAMPAIGN_VARIANTS,
  CONTENT_MODES,
  DATASET_VERSION,
  OUT_OF_DOMAIN_CONTENTS,
  THEMES,
} from './benchmark-definitions.mjs';

function selectTags(theme, mode, relatedTheme) {
  switch (mode.tags) {
    case 'none':
      return [];
    case 'partial':
      return theme.coreTags.slice(0, 2);
    case 'mixed':
      return [
        ...theme.coreTags.slice(0, 2),
        ...relatedTheme.coreTags.slice(0, 2),
      ];
    case 'trap':
      return [theme.trapTag];
    default:
      return theme.coreTags.slice(0, 4);
  }
}

export function buildCampaigns() {
  return Object.entries(THEMES).flatMap(([themeId, theme]) =>
    CAMPAIGN_VARIANTS.map((variant, variantIndex) => ({
      campaignKey: `q4-${themeId}-${variant.id}`,
      theme: themeId,
      intent: variant.intent,
      title: `${theme.label} ${theme.product} ${variant.label}`,
      content: `${theme.exactTopic}. ${variant.copy}`,
      tags: [
        ...theme.coreTags.slice(variantIndex % 3, (variantIndex % 3) + 3),
        theme.coreTags[0],
        ...(theme.catalogExtraTags?.length
          ? [
              theme.catalogExtraTags[
                variantIndex % theme.catalogExtraTags.length
              ],
            ]
          : []),
      ].filter((tag, index, tags) => tags.indexOf(tag) === index),
      eligible: true,
    }))
  );
}

export function buildContents() {
  const contents = [];
  let sequence = 0;

  for (const [themeId, theme] of Object.entries(THEMES)) {
    for (const mode of CONTENT_MODES) {
      const relatedThemeId = theme.strongRelations[0] ?? theme.weakRelations[0];
      const relatedTheme = THEMES[relatedThemeId];
      const contentId = `q4-content-${String(sequence + 1).padStart(3, '0')}`;
      contents.push({
        contentId,
        split: sequence % 5 === 0 ? 'holdout' : 'development',
        scenario: mode.id,
        targetTheme: themeId,
        intent: mode.intent,
        title: mode.title(theme),
        body: mode.body(theme),
        tags: selectTags(theme, mode, relatedTheme),
        relatedTheme: mode.id === 'multi-topic' ? relatedThemeId : null,
        trapTheme: mode.id === 'lexical-trap' ? theme.trapTheme : null,
      });
      sequence += 1;
    }
  }

  for (const [index, [slug, title, body]] of OUT_OF_DOMAIN_CONTENTS.entries()) {
    contents.push({
      contentId: `q4-null-${slug}`,
      split: index % 5 === 0 ? 'holdout' : 'development',
      scenario: 'no-match',
      targetTheme: null,
      intent: 'general',
      title,
      body,
      tags: [],
      relatedTheme: null,
      trapTheme: null,
    });
  }

  return contents;
}

function judge(content, campaign) {
  if (content.targetTheme === null) {
    return {
      relevance: 0,
      reason: '개발 광고 catalog와 무관한 no-match 콘텐츠다.',
    };
  }

  if (content.trapTheme === campaign.theme) {
    return {
      relevance: 0,
      reason:
        '공통 기술 단어만 존재하는 lexical hard negative이며 글의 실제 의도와 다르다.',
    };
  }

  if (campaign.theme === content.targetTheme) {
    const intentMatches =
      content.intent === 'general' || content.intent === campaign.intent;
    return {
      relevance: intentMatches ? 3 : 2,
      reason: intentMatches
        ? '핵심 주제와 사용자 의도가 모두 직접 일치한다.'
        : '핵심 주제는 직접 일치하지만 학습·구축·운영·구매 의도가 다르다.',
    };
  }

  if (content.relatedTheme === campaign.theme) {
    return {
      relevance: 2,
      reason: 'multi-topic 시나리오에서 명시적으로 다루는 인접 주제다.',
    };
  }

  const target = THEMES[content.targetTheme];
  if (target.strongRelations.includes(campaign.theme)) {
    return {
      relevance: 2,
      reason: '핵심 문제를 실질적으로 해결할 수 있는 강한 인접 주제다.',
    };
  }

  if (target.weakRelations.includes(campaign.theme)) {
    return {
      relevance: 1,
      reason: '일부 기술 또는 운영 맥락만 공유하는 약한 관련 주제다.',
    };
  }

  return {
    relevance: 0,
    reason: '핵심 의도와 해결하려는 문제가 다르다.',
  };
}

export function buildQrels(contents, campaigns) {
  return contents.flatMap((content) =>
    campaigns.map((campaign) => {
      const judgment = judge(content, campaign);
      return {
        contentId: content.contentId,
        campaignKey: campaign.campaignKey,
        relevance: judgment.relevance,
        eligible: campaign.eligible,
        reason: judgment.reason,
      };
    })
  );
}

export function toJsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildDataset() {
  const campaigns = buildCampaigns();
  const contents = buildContents();
  const qrels = buildQrels(contents, campaigns);
  const files = {
    campaigns: toJsonLines(campaigns),
    contents: toJsonLines(contents),
    qrels: toJsonLines(qrels),
  };
  const distribution = qrels.reduce(
    (result, qrel) => {
      result[qrel.relevance] += 1;
      return result;
    },
    { 0: 0, 1: 0, 2: 0, 3: 0 }
  );

  return {
    campaigns,
    contents,
    qrels,
    files,
    manifest: {
      datasetVersion: DATASET_VERSION,
      deterministic: true,
      relevantThreshold: 2,
      relevanceScale: {
        0: '무관하거나 lexical hard negative',
        1: '일부 기술·운영 맥락만 관련',
        2: '주요 문제를 해결하는 강한 관련',
        3: '핵심 주제와 사용자 의도가 직접 일치',
      },
      counts: {
        campaigns: campaigns.length,
        contents: contents.length,
        qrels: qrels.length,
        development: contents.filter(
          (content) => content.split === 'development'
        ).length,
        holdout: contents.filter((content) => content.split === 'holdout')
          .length,
        noMatch: contents.filter((content) => content.scenario === 'no-match')
          .length,
      },
      relevanceDistribution: distribution,
      sha256: {
        campaigns: sha256(files.campaigns),
        contents: sha256(files.contents),
        qrels: sha256(files.qrels),
      },
    },
  };
}
