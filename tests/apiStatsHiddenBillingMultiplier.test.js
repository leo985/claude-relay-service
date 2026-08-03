const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock('express', () => ({ Router: () => mockRouter }))
jest.mock('../src/models/redis', () => ({
  getApiKey: jest.fn(),
  getUsageStats: jest.fn(),
  getDailyCost: jest.fn(),
  getCostStats: jest.fn(),
  getWeeklyOpusCost: jest.fn(),
  getClientSafe: jest.fn(),
  scanAndGetAllChunked: jest.fn(),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  security: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/services/apiKeyService', () => ({ validateApiKeyForStats: jest.fn() }))
jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn(),
  formatCost: jest.fn((cost) => `$${Number(cost).toFixed(6)}`)
}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/openaiAccountService', () => ({}))
jest.mock('../src/services/serviceRatesService', () => ({ getServiceFromModel: jest.fn() }))
jest.mock('../src/services/modelService', () => ({ getAllModels: jest.fn() }))
jest.mock('../src/utils/testPayloadHelper', () => ({}))
jest.mock('../src/utils/errorSanitizer', () => ({ getSafeMessage: jest.fn() }))
jest.mock('../src/utils/apiStatsModelDisplay', () => ({
  normalizeApiStatsModelDisplayMode: jest.fn((value) => value || 'full'),
  sanitizeModelStatsForDisplay: jest.fn((value) => value)
}))
jest.mock('../config/models', () => ({ BEDROCK_MODELS: [] }))
jest.mock('../config/config', () => ({ apiStats: { modelDisplayMode: 'full' } }))

const redis = require('../src/models/redis')
const CostCalculator = require('../src/utils/costCalculator')
const serviceRatesService = require('../src/services/serviceRatesService')
require('../src/routes/apiStats')

function createResponse() {
  const res = {
    body: null,
    status: jest.fn(() => res),
    json: jest.fn((body) => {
      res.body = body
      return res
    }),
    redirect: jest.fn()
  }
  return res
}

describe('API Stats hidden billing multiplier isolation', () => {
  test('returns billable costs without exposing the hidden multiplier', async () => {
    const apiId = '11111111-1111-4111-8111-111111111111'
    const windowStart = Date.now() - 1000
    redis.getApiKey.mockResolvedValue({
      id: apiId,
      name: 'Public Key',
      description: '',
      isActive: 'true',
      createdAt: '2026-07-01T00:00:00.000Z',
      permissions: '[]',
      rateLimitWindow: '60',
      rateLimitRequests: '100',
      rateLimitCost: '20',
      dailyCostLimit: '100',
      totalCostLimit: '1000',
      weeklyOpusCostLimit: '50'
    })
    redis.getUsageStats.mockResolvedValue({
      total: { requests: 3, allTokens: 15 },
      daily: { requests: 1 },
      monthly: { requests: 3 }
    })
    redis.getDailyCost.mockResolvedValue(1.875)
    redis.getCostStats.mockResolvedValue({ daily: 1.875, monthly: 3.125, total: 3.125 })
    redis.getWeeklyOpusCost.mockResolvedValue(1.25)
    redis.getClientSafe.mockReturnValue({
      get: jest.fn(async (key) => {
        const values = {
          [`usage:cost:total:${apiId}`]: '3.125',
          [`rate_limit:requests:${apiId}`]: '2',
          [`rate_limit:tokens:${apiId}`]: '15',
          [`rate_limit:cost:${apiId}`]: '1',
          [`rate_limit:window_start:${apiId}`]: String(windowStart)
        }
        return values[key] || null
      })
    })

    const route = mockRouter.post.mock.calls.find((call) => call[0] === '/api/user-stats')
    const res = createResponse()
    await route[1]({ body: { apiId }, ip: '127.0.0.1' }, res)

    expect(res.body.success).toBe(true)
    expect(res.body.data.usage.total.cost).toBe(3.125)
    expect(res.body.data.limits).toMatchObject({
      currentWindowCost: 1,
      currentDailyCost: 1.875,
      currentTotalCost: 3.125,
      weeklyOpusCost: 1.25
    })
    expect(JSON.stringify(res.body)).not.toContain('multiplier')
  })

  test('returns billable model costs while retaining real and rated costs', async () => {
    const apiId = '11111111-1111-4111-8111-111111111111'
    redis.getApiKey.mockResolvedValue({ id: apiId, name: 'Public Key', isActive: 'true' })
    redis.getDateInTimezone.mockReturnValue(new Date('2026-07-15T00:00:00.000Z'))
    redis.getDateStringInTimezone.mockReturnValue('2026-07-15')
    redis.scanAndGetAllChunked.mockResolvedValue([
      {
        key: `usage:${apiId}:model:daily:gpt-5:2026-07-15`,
        data: {
          requests: '1',
          inputTokens: '10',
          outputTokens: '5',
          allTokens: '15',
          realCostMicro: '1000000',
          ratedCostMicro: '1500000',
          billableCostMicro: '3750000'
        }
      }
    ])
    redis.getCostStats.mockResolvedValue({ daily: 3.75, monthly: 3.75, total: 3.75 })
    redis.getClientSafe.mockReturnValue({ get: jest.fn().mockResolvedValue(null) })
    serviceRatesService.getServiceFromModel.mockReturnValue('codex')
    CostCalculator.calculateCost.mockReturnValue({
      costs: { total: 1 },
      formatted: { total: '$1.000000' },
      pricing: {}
    })

    const route = mockRouter.post.mock.calls.find((call) => call[0] === '/api/user-model-stats')
    const res = createResponse()
    await route[1]({ body: { apiId, period: 'daily' } }, res)

    expect(res.body.success).toBe(true)
    expect(res.body.billingCost).toBe(3.75)
    expect(res.body.data[0].costs).toMatchObject({
      real: 1,
      rated: 1.5,
      billable: 3.75,
      total: 3.75
    })
  })
})
