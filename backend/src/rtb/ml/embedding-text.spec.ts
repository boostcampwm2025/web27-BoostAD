import { buildCampaignDocumentText } from './embedding-text';

describe('embedding text contract', () => {
  it('builds a deterministic campaign passage from title content and tags', () => {
    expect(
      buildCampaignDocumentText({
        title: '  프론트엔드   운영 진단 ',
        content: 'React\n렌더링 병목을 분석합니다.',
        tags: ['TypeScript', 'React', 'React'],
      })
    ).toBe(
      '프론트엔드 운영 진단\nReact 렌더링 병목을 분석합니다.\nReact TypeScript'
    );
  });
});
