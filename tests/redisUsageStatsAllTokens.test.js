jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock(
  '../config/config',
  () => ({
    redis: {
      host: 'localhost',
      port: 6379,
      password: '',
      db: 0,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableTLS: false
    },
    system: { timezoneOffset: 8 }
  }),
  { virtual: true }
)

const redis = require('../src/models/redis')

describe('redis usage stats all-token display', () => {
  const originalClient = redis.client
  const originalGetAccountDailyCost = redis.getAccountDailyCost

  afterEach(() => {
    redis.client = originalClient
    redis.getAccountDailyCost = originalGetAccountDailyCost
    jest.clearAllMocks()
  })

  test('getUsageStats uses totalAllTokens for tokens and averages', async () => {
    redis.client = {
      hgetall: jest.fn(async (key) => {
        if (key === 'usage:key-1') {
          return {
            totalTokens: '100',
            totalAllTokens: '160',
            totalInputTokens: '70',
            totalOutputTokens: '30',
            totalCacheReadTokens: '60',
            totalRequests: '2'
          }
        }
        if (key === 'apikey:key-1') {
          return { createdAt: new Date().toISOString() }
        }
        return {}
      })
    }

    const stats = await redis.getUsageStats('key-1')

    expect(stats.total.tokens).toBe(160)
    expect(stats.total.allTokens).toBe(160)
    expect(stats.averages.dailyTokens).toBe(160)
    expect(stats.averages.tpm).toBe(0.11)
  })

  test('getAccountUsageStats returns allTokens as the default token total', async () => {
    redis.client = {
      hgetall: jest.fn(async (key) => {
        if (key === 'account_usage:acct-1') {
          return {
            totalTokens: '100',
            totalAllTokens: '160',
            totalInputTokens: '70',
            totalOutputTokens: '30',
            totalCacheReadTokens: '60',
            totalRequests: '2'
          }
        }
        if (key === 'claude:account:acct-1') {
          return { createdAt: new Date().toISOString() }
        }
        return {}
      })
    }
    redis.getAccountDailyCost = jest.fn().mockResolvedValue(0)

    const stats = await redis.getAccountUsageStats('acct-1')

    expect(stats.total.tokens).toBe(160)
    expect(stats.total.allTokens).toBe(160)
    expect(stats.averages.dailyTokens).toBe(160)
    expect(stats.averages.tpm).toBe(0.11)
  })
})
