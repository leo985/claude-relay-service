jest.mock('../src/models/redis', () => ({}))

const {
  ApiKeyMonthlyUsageService,
  HISTORY_DAYS
} = require('../src/services/apiKeyMonthlyUsageService')

function createRedisFixture({ delayMs = 0 } = {}) {
  const commands = []
  const pipeline = {
    hgetall: jest.fn((key) => {
      commands.push(['hgetall', key])
      return pipeline
    }),
    get: jest.fn((key) => {
      commands.push(['get', key])
      return pipeline
    }),
    exec: jest.fn(async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return commands.map(([command, key]) => {
        const isToday = key.endsWith(':2026-07-12')
        if (command === 'hgetall') {
          return [
            null,
            isToday
              ? {
                  requests: '3',
                  inputTokens: '100',
                  outputTokens: '40',
                  cacheCreateTokens: '10',
                  cacheReadTokens: '50',
                  allTokens: '200'
                }
              : {}
          ]
        }
        return [null, isToday ? '0.1234567' : null]
      })
    })
  }

  return {
    pipeline,
    redis: {
      getClientSafe: jest.fn(() => ({ pipeline: jest.fn(() => pipeline) })),
      getDateStringInTimezone: jest.fn((date) => date.toISOString().slice(0, 10))
    }
  }
}

describe('ApiKeyMonthlyUsageService', () => {
  const now = () => new Date('2026-07-12T12:00:00.000Z')

  test('loads 30 daily usage and cost values in one Redis pipeline', async () => {
    const fixture = createRedisFixture()
    const service = new ApiKeyMonthlyUsageService({ redis: fixture.redis, now })

    const result = await service.getUsage('key-1')

    expect(fixture.pipeline.exec).toHaveBeenCalledTimes(1)
    expect(fixture.pipeline.hgetall).toHaveBeenCalledTimes(HISTORY_DAYS)
    expect(fixture.pipeline.get).toHaveBeenCalledTimes(HISTORY_DAYS)
    expect(result.history).toHaveLength(HISTORY_DAYS)
    expect(result.startDate).toBe('2026-06-13')
    expect(result.endDate).toBe('2026-07-12')
    expect(result.summary).toMatchObject({
      days: 30,
      activeDays: 1,
      totalRequests: 3,
      totalTokens: 200,
      totalCost: 0.123457
    })
  })

  test('serves repeated requests from the bounded TTL cache', async () => {
    const fixture = createRedisFixture()
    const service = new ApiKeyMonthlyUsageService({ redis: fixture.redis, now })

    const first = await service.getUsage('key-1')
    const second = await service.getUsage('key-1')

    expect(second).toBe(first)
    expect(fixture.pipeline.exec).toHaveBeenCalledTimes(1)
  })

  test('coalesces concurrent requests for the same key and date', async () => {
    const fixture = createRedisFixture({ delayMs: 10 })
    const service = new ApiKeyMonthlyUsageService({ redis: fixture.redis, now })

    const [first, second] = await Promise.all([
      service.getUsage('key-1'),
      service.getUsage('key-1')
    ])

    expect(second).toBe(first)
    expect(fixture.pipeline.exec).toHaveBeenCalledTimes(1)
  })

  test('does not cache an in-flight result after the key is invalidated', async () => {
    const fixture = createRedisFixture({ delayMs: 10 })
    const service = new ApiKeyMonthlyUsageService({ redis: fixture.redis, now })

    const pending = service.getUsage('key-1')
    service.invalidate('key-1', '2026-07-12')
    await pending

    expect(service.cache.get('key-1:2026-07-12')).toBeUndefined()
  })
})
