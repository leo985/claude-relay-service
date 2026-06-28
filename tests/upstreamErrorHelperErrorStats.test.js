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
  buildSafeUpstreamErrorForClient,
  clearErrorHistory,
  recordErrorHistory,
  sanitizeErrorForClient
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

describe('upstreamErrorHelper client error sanitization', () => {
  it('masks non-429 upstream error details before returning to clients', () => {
    const payload = sanitizeErrorForClient(
      {
        error: {
          message: 'invalid token sk-secret leaked detail [codex/codex]',
          type: 'auth_error',
          code: 'invalid_api_key'
        }
      },
      { statusCode: 401 }
    )

    expect(payload).toEqual({
      error: {
        message: 'Upstream authentication failed',
        type: 'authentication_error',
        code: 'upstream_auth_error'
      }
    })
  })

  it('keeps only retry timing for 429 errors', () => {
    const payload = buildSafeUpstreamErrorForClient(
      429,
      {
        error: {
          message: 'quota exhausted for account acct-secret',
          resets_in_seconds: 123
        }
      },
      { retryAfterSeconds: 60 }
    )

    expect(payload).toEqual({
      error: {
        message: 'Upstream rate limit exceeded',
        type: 'rate_limit_error',
        code: 'upstream_rate_limited',
        resets_in_seconds: 60
      }
    })
  })
})
