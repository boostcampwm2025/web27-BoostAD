// Lua Script: 원자적 예산 검증 + Spent 증가 (by Claude)
// KEYS[1] = campaign:{id}
// ARGV[1] = cpc
//
// 반환값:
// 1 = 성공 (Spent 증가됨)
// 0 = 일일 예산 초과
// -1 = 총 예산 초과
// -2 = ACTIVE 상태가 아님
// -99 = 캠페인 없음
export const REDIS_INCREMENT_SPENT_SCRIPT = `
    local campaignKey = KEYS[1]
    local cpc = tonumber(ARGV[1])

    -- 예약 시점의 최신 상태, 예산, spent를 Redis에서 조회
    local statusRaw = redis.call('JSON.GET', campaignKey, '$.status')
    local dailyBudgetRaw = redis.call('JSON.GET', campaignKey, '$.dailyBudget')
    local totalBudgetRaw = redis.call('JSON.GET', campaignKey, '$.totalBudget')
    local dailySpentRaw = redis.call('JSON.GET', campaignKey, '$.dailySpent')
    local totalSpentRaw = redis.call('JSON.GET', campaignKey, '$.totalSpent')

    if not statusRaw or not dailyBudgetRaw or not totalBudgetRaw
      or not dailySpentRaw or not totalSpentRaw then
      return -99  -- 캠페인 없음
    end

    if not string.find(statusRaw, 'ACTIVE', 1, true) then
      return -2
    end

    -- JSON 배열 형태로 반환되므로 파싱 필요 (예: "[50000]")
    local dailyBudget = tonumber(string.match(dailyBudgetRaw, '%[([%d%.]+)%]'))
    local totalBudget = tonumber(string.match(totalBudgetRaw, '%[([%d%.]+)%]'))
    local dailySpent = tonumber(string.match(dailySpentRaw, '%[([%d%.]+)%]')) or 0
    local totalSpent = tonumber(string.match(totalSpentRaw, '%[([%d%.]+)%]')) or 0

    -- 일일 예산 검증
    if not dailyBudget or dailySpent + cpc > dailyBudget then
      return 0  -- 일일 예산 초과
    end

    -- totalBudget이 null이면 파싱 결과가 nil이므로 총액 제한을 적용하지 않음
    if totalBudget and totalSpent + cpc > totalBudget then
      return -1  -- 총 예산 초과
    end

    -- 원자적으로 Spent 증가
    redis.call('JSON.NUMINCRBY', campaignKey, '$.dailySpent', cpc)
    redis.call('JSON.NUMINCRBY', campaignKey, '$.totalSpent', cpc)

    return 1  -- 성공
  `;

// 순위가 확정된 후보 window에서 첫 예산 가능 후보 1개만 원자적으로 선점
// KEYS[i] = campaign:{id}
// ARGV[i] = 해당 후보의 cpc
// 반환값 = {성공한 1-based index(없으면 0), 실제 검사한 후보 수}
export const REDIS_RESERVE_FIRST_AVAILABLE_SCRIPT = `
  for i = 1, #KEYS do
    local campaignKey = KEYS[i]
    local cpc = tonumber(ARGV[i])
    local statusRaw = redis.call('JSON.GET', campaignKey, '$.status')
    local dailyBudgetRaw = redis.call('JSON.GET', campaignKey, '$.dailyBudget')
    local totalBudgetRaw = redis.call('JSON.GET', campaignKey, '$.totalBudget')
    local dailySpentRaw = redis.call('JSON.GET', campaignKey, '$.dailySpent')
    local totalSpentRaw = redis.call('JSON.GET', campaignKey, '$.totalSpent')

    if statusRaw and string.find(statusRaw, 'ACTIVE', 1, true)
      and dailyBudgetRaw and totalBudgetRaw and dailySpentRaw and totalSpentRaw then
      local dailyBudget = tonumber(string.match(dailyBudgetRaw, '%[([%d%.]+)%]'))
      local dailySpent = tonumber(string.match(dailySpentRaw, '%[([%d%.]+)%]')) or 0
      local totalSpent = tonumber(string.match(totalSpentRaw, '%[([%d%.]+)%]')) or 0
      local totalBudget = tonumber(string.match(totalBudgetRaw, '%[([%d%.]+)%]'))
      local dailyEligible = dailyBudget and dailySpent + cpc <= dailyBudget
      local totalEligible = not totalBudget or totalSpent + cpc <= totalBudget

      if dailyEligible and totalEligible then
        redis.call('JSON.NUMINCRBY', campaignKey, '$.dailySpent', cpc)
        redis.call('JSON.NUMINCRBY', campaignKey, '$.totalSpent', cpc)
        return {i, i}
      end
    end
  end

  return {0, #KEYS}
`;

// Lua Script: 원자적 Spent 감소 (롤백용)
// KEYS[1] = campaign:{id}
// ARGV[1] = cpc (감소할 금액, 양수로 전달)
//
// 반환값:
// 1 = 성공 (Spent 감소됨)
// 0 = 음수 방지 (dailySpent가 음수가 될 뻔함)
// -1 = 음수 방지 (totalSpent가 음수가 될 뻔함)
// -99 = 캠페인 없음
export const REDIS_DECREMENT_SPENT_SCRIPT = `
  local campaignKey = KEYS[1]
  local cpc = tonumber(ARGV[1])
  
  -- 현재 spent 값 조회
  local dailySpentRaw = redis.call('JSON.GET', campaignKey, '$.dailySpent')
  local totalSpentRaw = redis.call('JSON.GET', campaignKey, '$.totalSpent')
  
  if not dailySpentRaw or not totalSpentRaw then
    return -99  -- 캠페인 없음
  end
  
  -- JSON 배열 파싱
  local dailySpent = tonumber(string.match(dailySpentRaw, '%[(%d+)%]')) or 0
  local totalSpent = tonumber(string.match(totalSpentRaw, '%[(%d+)%]')) or 0
  
  -- 음수 방지 검증 (일일)
  if dailySpent - cpc < 0 then
    return 0  -- 일일 Spent가 음수가 될 수 없음
  end
  
  -- 음수 방지 검증 (총)
  if totalSpent - cpc < 0 then
    return -1  -- 총 Spent가 음수가 될 수 없음
  end
  
  -- 원자적으로 Spent 감소
  redis.call('JSON.NUMINCRBY', campaignKey, '$.dailySpent', -cpc)
  redis.call('JSON.NUMINCRBY', campaignKey, '$.totalSpent', -cpc)
  
  return 1  -- 성공
`;
