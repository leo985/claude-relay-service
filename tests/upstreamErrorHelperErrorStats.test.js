const pipeline = {
  lpush: jest.fn().mockReturnThis(),
  ltrim: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  hincrby: jest.fn().mockReturnThis(),
  hset: jest.fn().mockReturnThis(),
  del: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([])
}

const mockClient = {
  pipeline: jest.fn(() => pipeline)
}

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => mockClient),
  getDateStringInTimezone: jest.fn(() => '2026-06-23')
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))

const {
  ERROR_STATS_TTL,
  clearErrorHistory,
  recordErrorHistory
} = require('../src/utils/upstreamErrorHelper')

describe('upstreamErrorHelper error stats aggregation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('adds daily exception aggregation to the existing recordErrorHistory pipeline', async () => {
    await recordErrorHistory('acc-1', 'openai', 429, 'rate_limit', {
      model: 'gpt-5',
      path: '/v1/messages',
      apiKeyName: 'default\nkey',
      errorBody: 'x'.repeat(3000)
    })

    const statsKey = 'account_error_stats:daily:openai:acc-1:2026-06-23'
    expect(mockClient.pipeline).toHaveBeenCalledTimes(1)
    expect(pipeline.lpush).toHaveBeenCalledWith('error_history:openai:acc-1', expect.any(String))
    expect(pipeline.hincrby).toHaveBeenCalledWith(statsKey, 'total', 1)
    expect(pipeline.hincrby).toHaveBeenCalledWith(statsKey, 'type:rate_limit', 1)
    expect(pipeline.hincrby).toHaveBeenCalledWith(statsKey, 'status:429', 1)
    expect(pipeline.hincrby).toHaveBeenCalledWith(statsKey, 'errorType:rate_limit', 1)
    expect(pipeline.hincrby).toHaveBeenCalledWith(statsKey, 'model:gpt-5', 1)
    expect(pipeline.hincrby).toHaveBeenCalledWith(statsKey, 'path:/v1/messages', 1)
    expect(pipeline.hincrby).toHaveBeenCalledWith(statsKey, 'apiKey:default key', 1)
    expect(pipeline.hset).toHaveBeenCalledWith(statsKey, 'latestAt', expect.any(String))
    expect(pipeline.expire).toHaveBeenCalledWith(statsKey, ERROR_STATS_TTL)
    expect(pipeline.exec).toHaveBeenCalledTimes(1)

    const savedEntry = JSON.parse(pipeline.lpush.mock.calls[0][1])
    expect(savedEntry.context.errorBody).toHaveLength(2000)
  })

  it('clears list history and daily aggregate keys together', async () => {
    await clearErrorHistory('openai', 'acc-1')

    expect(mockClient.pipeline).toHaveBeenCalledTimes(1)
    expect(pipeline.del).toHaveBeenCalledWith('error_history:openai:acc-1')
    expect(pipeline.del).toHaveBeenCalledWith('account_error_stats:daily:openai:acc-1:2026-06-23')
    expect(pipeline.del).toHaveBeenCalledTimes(61)
    expect(pipeline.exec).toHaveBeenCalledTimes(1)
  })
})
