import { check } from 'k6';

import { classifyDecisionResponse } from '../lib/rtb-result.js';

export const options = {
  iterations: 1,
  vus: 1,
};

export default function () {
  const success = classifyDecisionResponse(
    response(201, {
      status: 'success',
      data: { auctionId: 'auction-1', campaign: { id: 'campaign-1' } },
    })
  );
  const businessError = classifyDecisionResponse(
    response(201, { status: 'error', message: 'error message', data: null })
  );
  const transportError = classifyDecisionResponse(
    response(503, { status: 'error', data: null })
  );
  const invalidJson = classifyDecisionResponse({
    status: 201,
    json() {
      throw new Error('invalid json');
    },
  });

  check(null, {
    'success payload is business success': () => success.businessOk,
    '2xx error payload is business error': () =>
      businessError.transportOk &&
      !businessError.businessOk &&
      businessError.reason === 'unknown',
    'non-2xx is transport error': () =>
      !transportError.transportOk &&
      transportError.reason === 'transport_error',
    'invalid JSON is classified': () =>
      !invalidJson.businessOk && invalidJson.reason === 'invalid_json',
  });
}

function response(status, body) {
  return {
    status,
    json() {
      return body;
    },
  };
}
