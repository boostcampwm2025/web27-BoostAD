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

// 캠페인 전체 문서를 교체할 때 진행 중 예약 합계를 원자적으로 보존한다.
// KEYS[1] = campaign:{id}
// ARGV[1] = 새 캠페인 JSON, ARGV[2] = 기본 KST 날짜
export const REDIS_SAVE_CAMPAIGN_PRESERVING_RESERVED_SCRIPT = `
  local incoming = cjson.decode(ARGV[1])
  local existingRaw = redis.call('JSON.GET', KEYS[1])

  if existingRaw then
    local existing = cjson.decode(existingRaw)
    incoming.dailyReserved = tonumber(existing.dailyReserved) or 0
    incoming.totalReserved = tonumber(existing.totalReserved) or 0
    if type(existing.dailyReservedDate) == 'string' then
      incoming.dailyReservedDate = existing.dailyReservedDate
    end
  else
    incoming.dailyReserved = tonumber(incoming.dailyReserved) or 0
    incoming.totalReserved = tonumber(incoming.totalReserved) or 0
  end

  if type(incoming.dailyReservedDate) ~= 'string' then
    incoming.dailyReservedDate = ARGV[2]
  end

  redis.call('JSON.SET', KEYS[1], '$', cjson.encode(incoming))
  return 1
`;

// ClickLog projection은 spent만 교체하고 reserved에는 손대지 않는다.
// KEYS[1] = campaign:{id}
// ARGV[1] = dailySpent, ARGV[2] = totalSpent
export const REDIS_REPLACE_SPENT_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
  redis.call('JSON.SET', KEYS[1], '$.dailySpent', ARGV[1])
  redis.call('JSON.SET', KEYS[1], '$.totalSpent', ARGV[2])
  return 1
`;

// KST 일자 전환 시 일일 spent와 일일 reserved를 한 번에 초기화한다.
// KEYS[1] = campaign:{id}
// ARGV[1] = KST budgetDate, ARGV[2] = lastResetDate ISO string
export const REDIS_RESET_DAILY_BUDGET_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
  redis.call('JSON.SET', KEYS[1], '$.dailySpent', '0')
  redis.call('JSON.SET', KEYS[1], '$.dailyReserved', '0')
  redis.call('JSON.SET', KEYS[1], '$.dailyReservedDate', cjson.encode(ARGV[1]))
  redis.call('JSON.SET', KEYS[1], '$.lastResetDate', cjson.encode(ARGV[2]))
  return 1
`;

// winner-only 예약 생성.
// KEYS[1] = expiration ZSET, KEYS[2] = auction:{auctionId}, KEYS[3..] = campaign keys
// ARGV[1] = auctionId, [2] = blogId, [3] = KST budgetDate,
// [4] = expiresAt(ms), [5] = campaign TTL(sec), [6..] = CPC, 이후 campaignId
// return = {code, campaignId, attemptedCount, reservationJson}
// code: 1=reserved, 2=existing, -2=conflict, 0=exhausted
export const REDIS_RESERVE_AUCTION_SCRIPT = `
  local existingRaw = redis.call('GET', KEYS[2])
  if existingRaw then
    local ok, existing = pcall(cjson.decode, existingRaw)
    if ok and tonumber(existing.version) == 1 then
      return {2, existing.campaignId or '', 0, existingRaw}
    end
    return {-2, '', 0, ''}
  end

  local candidateCount = #KEYS - 2
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)

  for i = 1, candidateCount do
    local campaignKey = KEYS[i + 2]
    local campaignRaw = redis.call('JSON.GET', campaignKey)

    if campaignRaw then
      local campaign = cjson.decode(campaignRaw)
      local cpc = tonumber(ARGV[5 + i])
      local campaignId = ARGV[5 + candidateCount + i]
      local dailyBudget = tonumber(campaign.dailyBudget)
      local totalBudget = nil
      if campaign.totalBudget ~= nil and campaign.totalBudget ~= cjson.null then
        totalBudget = tonumber(campaign.totalBudget)
      end
      local dailySpent = tonumber(campaign.dailySpent) or 0
      local totalSpent = tonumber(campaign.totalSpent) or 0
      local dailyReserved = 0
      if campaign.dailyReservedDate == ARGV[3] then
        dailyReserved = tonumber(campaign.dailyReserved) or 0
      end
      local totalReserved = tonumber(campaign.totalReserved) or 0

      local dailyEligible = dailyBudget and dailySpent + dailyReserved + cpc <= dailyBudget
      local totalEligible = not totalBudget or totalSpent + totalReserved + cpc <= totalBudget

      if campaign.status == 'ACTIVE' and dailyEligible and totalEligible then
        redis.call('JSON.SET', campaignKey, '$.dailyReserved', tostring(dailyReserved + cpc))
        redis.call('JSON.SET', campaignKey, '$.totalReserved', tostring(totalReserved + cpc))
        redis.call('JSON.SET', campaignKey, '$.dailyReservedDate', cjson.encode(ARGV[3]))
        redis.call('EXPIRE', campaignKey, tonumber(ARGV[5]))

        local reservation = {
          version = 1,
          auctionId = ARGV[1],
          campaignId = campaignId,
          blogId = tonumber(ARGV[2]),
          cost = cpc,
          status = 'RESERVED',
          budgetDate = ARGV[3],
          createdAt = nowMs,
          updatedAt = nowMs,
          expiresAt = tonumber(ARGV[4])
        }
        local reservationJson = cjson.encode(reservation)
        redis.call('SET', KEYS[2], reservationJson)
        redis.call('ZADD', KEYS[1], tonumber(ARGV[4]), ARGV[1])
        return {1, campaignId, i, reservationJson}
      end
    end
  end

  return {0, '', candidateCount, ''}
`;

// RESERVED -> COMMITTED. 만료됐거나 날짜가 바뀐 예약은 RELEASED로 전환한다.
// KEYS = auction, expiration ZSET, campaign
// ARGV = auctionId, currentBudgetDate, terminal TTL(sec), now(ms)
export const REDIS_COMMIT_AUCTION_SCRIPT = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then
    redis.call('ZREM', KEYS[2], ARGV[1])
    return {-99, ''}
  end

  local ok, reservation = pcall(cjson.decode, raw)
  if not ok or tonumber(reservation.version) ~= 1 then return {-98, ''} end
  if reservation.status == 'COMMITTED' then return {2, raw} end
  if reservation.status == 'RELEASED' then return {-1, raw} end

  local amount = tonumber(reservation.cost)
  local nowMs = tonumber(ARGV[4])

  local function writeMarker(status)
    local marker = {
      version = 1,
      auctionId = ARGV[1],
      status = status,
      updatedAt = nowMs
    }
    local markerRaw = cjson.encode(marker)
    redis.call('SETEX', KEYS[1], tonumber(ARGV[3]), markerRaw)
    redis.call('ZREM', KEYS[2], ARGV[1])
    return markerRaw
  end

  local function releaseReservation()
    local campaignRaw = redis.call('JSON.GET', KEYS[3])
    if campaignRaw then
      local campaign = cjson.decode(campaignRaw)
      local nextTotalReserved = math.max(0, (tonumber(campaign.totalReserved) or 0) - amount)
      redis.call('JSON.SET', KEYS[3], '$.totalReserved', tostring(nextTotalReserved))
      if campaign.dailyReservedDate == reservation.budgetDate then
        local nextDailyReserved = math.max(0, (tonumber(campaign.dailyReserved) or 0) - amount)
        redis.call('JSON.SET', KEYS[3], '$.dailyReserved', tostring(nextDailyReserved))
      end
    end
    return writeMarker('RELEASED')
  end

  if tonumber(reservation.expiresAt) <= nowMs or reservation.budgetDate ~= ARGV[2] then
    return {-2, releaseReservation()}
  end

  local campaignRaw = redis.call('JSON.GET', KEYS[3])
  if not campaignRaw then return {-3, releaseReservation()} end
  local campaign = cjson.decode(campaignRaw)
  local nextTotalReserved = math.max(0, (tonumber(campaign.totalReserved) or 0) - amount)
  local nextDailyReserved = tonumber(campaign.dailyReserved) or 0
  if campaign.dailyReservedDate == reservation.budgetDate then
    nextDailyReserved = math.max(0, nextDailyReserved - amount)
  end

  redis.call('JSON.SET', KEYS[3], '$.totalReserved', tostring(nextTotalReserved))
  redis.call('JSON.SET', KEYS[3], '$.dailyReserved', tostring(nextDailyReserved))
  redis.call('JSON.SET', KEYS[3], '$.dailySpent', tostring((tonumber(campaign.dailySpent) or 0) + amount))
  redis.call('JSON.SET', KEYS[3], '$.totalSpent', tostring((tonumber(campaign.totalSpent) or 0) + amount))
  return {1, writeMarker('COMMITTED')}
`;

// RESERVED -> RELEASED.
// KEYS = auction, expiration ZSET, campaign
// ARGV = auctionId, terminal TTL(sec), now(ms)
export const REDIS_RELEASE_AUCTION_SCRIPT = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then
    redis.call('ZREM', KEYS[2], ARGV[1])
    return {-99, ''}
  end

  local ok, reservation = pcall(cjson.decode, raw)
  if not ok or tonumber(reservation.version) ~= 1 then return {-98, ''} end
  if reservation.status == 'COMMITTED' then return {-1, raw} end
  if reservation.status == 'RELEASED' then return {2, raw} end

  local amount = tonumber(reservation.cost)
  local campaignRaw = redis.call('JSON.GET', KEYS[3])
  if campaignRaw then
    local campaign = cjson.decode(campaignRaw)
    local nextTotalReserved = math.max(0, (tonumber(campaign.totalReserved) or 0) - amount)
    redis.call('JSON.SET', KEYS[3], '$.totalReserved', tostring(nextTotalReserved))
    if campaign.dailyReservedDate == reservation.budgetDate then
      local nextDailyReserved = math.max(0, (tonumber(campaign.dailyReserved) or 0) - amount)
      redis.call('JSON.SET', KEYS[3], '$.dailyReserved', tostring(nextDailyReserved))
    end
  end

  local marker = {
    version = 1,
    auctionId = ARGV[1],
    status = 'RELEASED',
    updatedAt = tonumber(ARGV[3])
  }
  local markerRaw = cjson.encode(marker)
  redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), markerRaw)
  redis.call('ZREM', KEYS[2], ARGV[1])
  return {1, markerRaw}
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
