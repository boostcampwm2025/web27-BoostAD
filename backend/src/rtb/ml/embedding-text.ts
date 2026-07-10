export type CampaignEmbeddingTextInput = {
  title: string;
  content: string;
  tags?: string[];
};

const canonicalize = (text: string): string =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim();

export function buildCampaignDocumentText(
  campaign: CampaignEmbeddingTextInput
): string {
  const title = canonicalize(campaign.title);
  const content = canonicalize(campaign.content);
  const tags = [
    ...new Set((campaign.tags ?? []).map(canonicalize).filter(Boolean)),
  ].sort();

  return [title, content, tags.join(' ')].filter(Boolean).join('\n');
}
