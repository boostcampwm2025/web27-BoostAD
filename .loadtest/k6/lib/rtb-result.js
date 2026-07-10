export function classifyDecisionResponse(response) {
  const transportOk = response.status >= 200 && response.status < 300;

  let body = null;
  let parseError = false;
  try {
    body = response.json();
  } catch {
    parseError = true;
  }

  const businessOk = Boolean(
    transportOk &&
      !parseError &&
      body &&
      body.status === 'success' &&
      body.data &&
      typeof body.data.auctionId === 'string' &&
      body.data.auctionId.length > 0 &&
      body.data.campaign &&
      typeof body.data.campaign.id === 'string' &&
      body.data.campaign.id.length > 0
  );

  return {
    transportOk,
    businessOk,
    reason: businessOk
      ? 'none'
      : classifyErrorReason({ transportOk, parseError, body }),
  };
}

function classifyErrorReason({ transportOk, parseError, body }) {
  if (!transportOk) {
    return 'transport_error';
  }
  if (parseError || !body) {
    return 'invalid_json';
  }

  const explicitReason = normalizeReason(body.reason ?? body.errorReason);
  if (explicitReason) {
    return explicitReason;
  }

  const messages = [
    body.message,
    ...(Array.isArray(body.errors)
      ? body.errors.map((error) => error?.message)
      : []),
  ]
    .filter((message) => typeof message === 'string')
    .join(' ')
    .toLowerCase();

  if (messages.includes('budget') || messages.includes('예산')) {
    return 'no_reservable_budget';
  }
  if (messages.includes('fallback')) {
    return 'fallback_missing';
  }
  if (messages.includes('candidate') || messages.includes('후보')) {
    return 'no_candidate';
  }

  return 'unknown';
}

function normalizeReason(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return normalized.replace(/[^a-z0-9_-]+/g, '_').slice(0, 64);
}
