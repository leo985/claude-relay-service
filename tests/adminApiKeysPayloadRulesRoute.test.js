const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))

jest.mock('../src/services/apiKeyService', () => ({
  updateApiKey: jest.fn()
}))

jest.mock('../src/services/apiKeyMonthlyUsageService', () => ({
  getUsage: jest.fn()
}))

jest.mock('../src/services/apiKeyDailyUsageService', () => ({
  reset: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn(),
  getApiKey: jest.fn(),
  getDailyCost: jest.fn(),
  getWeeklyOpusCost: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn(),
  formatCost: jest.fn()
}))

jest.mock(
  '../config/config',
  () => ({
    system: {
      timezoneOffset: 8
    }
  }),
  { virtual: true }
)

jest.mock('../src/services/requestBodyRuleService', () => ({
  validateAndNormalizeRules: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const apiKeyMonthlyUsageService = require('../src/services/apiKeyMonthlyUsageService')
const apiKeyDailyUsageService = require('../src/services/apiKeyDailyUsageService')
const requestBodyRuleService = require('../src/services/requestBodyRuleService')
const redis = require('../src/models/redis')
const CostCalculator = require('../src/utils/costCalculator')
require('../src/routes/admin/apiKeys')

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    })
  }

  return res
}

function findPutHandler(path) {
  const route = mockRouter.put.mock.calls.find((call) => call[0] === path)
  return route?.[2]
}

function findGetHandler(path) {
  const route = mockRouter.get.mock.calls.find((call) => call[0] === path)
  return route?.[2]
}

function findPostHandler(path) {
  const route = mockRouter.post.mock.calls.find((call) => call[0] === path)
  return route?.[2]
}

describe('admin API key monthly usage route', () => {
  test('returns the pre-aggregated 30 day usage payload', async () => {
    const payload = { history: [], summary: { days: 30 } }
    apiKeyMonthlyUsageService.getUsage.mockResolvedValueOnce(payload)
    const handler = findGetHandler('/api-keys/:keyId/monthly-usage')
    const res = createResponse()

    await handler({ params: { keyId: 'key-30-days' } }, res)

    expect(apiKeyMonthlyUsageService.getUsage).toHaveBeenCalledWith('key-30-days')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({ success: true, data: payload })
  })
})

describe('admin API key daily usage reset route', () => {
  test('returns the reset result', async () => {
    const payload = { keyId: 'key-1', date: '2026-07-12', previous: { requests: 5 } }
    apiKeyDailyUsageService.reset.mockResolvedValueOnce(payload)
    const handler = findPostHandler('/api-keys/:keyId/reset-daily-usage')
    const res = createResponse()

    await handler({ params: { keyId: 'key-1' } }, res)

    expect(apiKeyDailyUsageService.reset).toHaveBeenCalledWith('key-1')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      success: true,
      message: 'Daily usage reset successfully',
      data: payload
    })
  })

  test('returns 404 for an unknown key', async () => {
    apiKeyDailyUsageService.reset.mockRejectedValueOnce(
      Object.assign(new Error('API key not found'), { code: 'API_KEY_NOT_FOUND' })
    )
    const handler = findPostHandler('/api-keys/:keyId/reset-daily-usage')
    const res = createResponse()

    await handler({ params: { keyId: 'missing-key' } }, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.body).toEqual({ success: false, error: 'API key not found' })
  })
})

describe('admin API key batch stats billing cost', () => {
  test('uses billable model cost for both the cost column and daily limit progress', async () => {
    const modelKey = 'usage:key-1:model:daily:gpt-5:2026-07-15'
    const pipeline = {
      hgetall: jest.fn(() => pipeline),
      exec: jest.fn().mockResolvedValue([
        [
          null,
          {
            inputTokens: '10',
            outputTokens: '5',
            requests: '1',
            realCostMicro: '1000000',
            ratedCostMicro: '1500000',
            billableCostMicro: '3750000'
          }
        ]
      ])
    }
    redis.getClientSafe.mockReturnValue({
      scan: jest.fn().mockResolvedValue(['0', [modelKey]]),
      get: jest.fn().mockResolvedValue('3.75'),
      pipeline: jest.fn(() => pipeline)
    })
    redis.getDateInTimezone.mockReturnValue(new Date('2026-07-15T00:00:00.000Z'))
    redis.getDateStringInTimezone.mockReturnValue('2026-07-15')
    redis.getApiKey.mockResolvedValue({
      dailyCostLimit: '10',
      weeklyOpusCostLimit: '0',
      rateLimitWindow: '0'
    })
    redis.getDailyCost.mockResolvedValue(3.75)
    CostCalculator.formatCost.mockImplementation((cost) => `$${cost.toFixed(2)}`)

    const handler = findPostHandler('/api-keys/batch-stats')
    const res = createResponse()
    await handler({ body: { keyIds: ['key-1'], timeRange: 'today' } }, res)

    expect(res.body.success).toBe(true)
    expect(res.body.data['key-1']).toMatchObject({
      cost: 3.75,
      formattedCost: '$3.75',
      dailyCost: 3.75,
      ratedCost: 1.5,
      realCost: 1
    })
  })
})

describe('admin api keys route payload rule updates', () => {
  beforeEach(() => {
    apiKeyService.updateApiKey.mockReset()
    apiKeyService.updateApiKey.mockResolvedValue()

    requestBodyRuleService.validateAndNormalizeRules.mockReset()
    requestBodyRuleService.validateAndNormalizeRules.mockImplementation((rules) => ({
      valid: true,
      rules
    }))
  })

  test('does not clear stored payload rules when the toggle is disabled without sending rules', async () => {
    const handler = findPutHandler('/api-keys/:keyId')
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'key-1' },
        body: {
          name: 'Renamed Key',
          enableOpenAIResponsesPayloadRules: false
        }
      },
      res
    )

    expect(requestBodyRuleService.validateAndNormalizeRules).not.toHaveBeenCalled()

    const updates = apiKeyService.updateApiKey.mock.calls[0][1]
    expect(updates).toEqual({
      name: 'Renamed Key',
      enableOpenAIResponsesPayloadRules: false
    })
    expect(updates).not.toHaveProperty('openaiResponsesPayloadRules')

    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      success: true,
      message: 'API key updated successfully'
    })
  })

  test('accepts payload rules even when the toggle is disabled', async () => {
    const handler = findPutHandler('/api-keys/:keyId')
    const res = createResponse()
    const rules = [{ path: 'model', valueType: 'string', value: 'gpt-5' }]

    await handler(
      {
        params: { keyId: 'key-2' },
        body: {
          enableOpenAIResponsesPayloadRules: false,
          openaiResponsesPayloadRules: rules
        }
      },
      res
    )

    expect(requestBodyRuleService.validateAndNormalizeRules).toHaveBeenCalledWith(rules)
    expect(apiKeyService.updateApiKey).toHaveBeenCalledWith('key-2', {
      enableOpenAIResponsesPayloadRules: false,
      openaiResponsesPayloadRules: rules
    })

    expect(res.status).not.toHaveBeenCalled()
    expect(res.body.success).toBe(true)
  })

  test('allows explicitly clearing payload rules with an empty array', async () => {
    const handler = findPutHandler('/api-keys/:keyId')
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'key-3' },
        body: {
          openaiResponsesPayloadRules: []
        }
      },
      res
    )

    expect(requestBodyRuleService.validateAndNormalizeRules).toHaveBeenCalledWith([])
    expect(apiKeyService.updateApiKey).toHaveBeenCalledWith('key-3', {
      openaiResponsesPayloadRules: []
    })

    expect(res.status).not.toHaveBeenCalled()
    expect(res.body.success).toBe(true)
  })
})
