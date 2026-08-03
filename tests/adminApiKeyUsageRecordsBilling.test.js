const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn()
}

jest.mock('express', () => ({
  Router: jest.fn(() => mockRouter)
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((req, res, next) => next())
}))

jest.mock('../src/models/redis', () => ({
  getApiKey: jest.fn(),
  getUsageRecords: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/pricingService', () => ({}))

jest.mock('../src/services/account/ccrAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/claudeAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn()
}))
jest.mock('../src/services/account/geminiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/geminiApiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/openaiAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))
jest.mock('../src/services/account/droidAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/bedrockAccountService', () => ({ getAccount: jest.fn() }))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn(),
  formatCost: jest.fn((cost) => `$${Number(cost).toFixed(6)}`)
}))

const redis = require('../src/models/redis')
const CostCalculator = require('../src/utils/costCalculator')
require('../src/routes/admin/usageStats')

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(function (body) {
      this.body = body
      return this
    })
  }
}

function findGetHandler(path) {
  const route = mockRouter.get.mock.calls.find((call) => call[0] === path)
  return route?.[route.length - 1]
}

describe('admin API key usage records billing costs', () => {
  beforeEach(() => {
    redis.getApiKey.mockReset()
    redis.getUsageRecords.mockReset()
    CostCalculator.calculateCost.mockReset()
    CostCalculator.formatCost.mockClear()
    redis.getApiKey.mockResolvedValue({ id: 'key-1', name: 'Billing Key' })
    CostCalculator.calculateCost.mockReturnValue({
      costs: { input: 0.4, output: 0.6, total: 1 }
    })
  })

  test('shows persisted hidden-multiplier costs and keeps legacy records compatible', async () => {
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-07-15T02:00:00.000Z',
        model: 'gpt-5',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        realCost: 1,
        cost: 1.5,
        ratedCost: 1.5,
        billableCost: 3.75,
        billableCostBreakdown: { input: 1.5, output: 2.25, total: 3.75 }
      },
      {
        timestamp: '2026-07-15T01:00:00.000Z',
        model: 'gpt-5',
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        realCost: 1,
        cost: 1.5
      }
    ])

    const handler = findGetHandler('/api-keys/:keyId/usage-records')
    const res = createResponse()
    await handler({ params: { keyId: 'key-1' }, query: {} }, res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.body.data.summary).toMatchObject({
      totalRequests: 2,
      totalCost: 5.25,
      avgCost: 2.625
    })
    expect(res.body.data.records[0]).toMatchObject({
      cost: 3.75,
      ratedCost: 1.5,
      billableCost: 3.75,
      billableCostBreakdown: { input: 1.5, output: 2.25, total: 3.75 }
    })
    expect(res.body.data.records[1]).toMatchObject({
      cost: 1.5,
      ratedCost: 1.5,
      billableCost: 1.5
    })
  })
})
