const mockIncrby = jest.fn()
const mockIncrbyfloat = jest.fn()

jest.mock('../src/models/redis', () => ({
  getClient: () => ({ incrby: mockIncrby, incrbyfloat: mockIncrbyfloat })
}))
jest.mock('../src/services/pricingService', () => ({ calculateCost: jest.fn() }))
jest.mock('../src/utils/costCalculator', () => ({ calculateCost: jest.fn() }))

const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')

describe('rateLimitHelper hidden billing multiplier', () => {
  beforeEach(() => jest.clearAllMocks())

  test('uses billable cost for enforcement and real cost for API Stats', async () => {
    const result = await updateRateLimitCounters(
      {
        tokenCountKey: 'rate_limit:tokens:key-1',
        costCountKey: 'rate_limit:cost:key-1'
      },
      { inputTokens: 10, outputTokens: 5 },
      'gpt-5',
      'key-1',
      'openai',
      { realCost: 1, ratedCost: 1.5, billableCost: 3.75 }
    )

    expect(mockIncrby).toHaveBeenCalledWith('rate_limit:tokens:key-1', 15)
    expect(mockIncrbyfloat).toHaveBeenCalledWith('rate_limit:cost:key-1', 3.75)
    expect(result).toEqual({
      totalTokens: 15,
      totalCost: 1,
      ratedCost: 1.5,
      billableCost: 3.75
    })
  })
})
