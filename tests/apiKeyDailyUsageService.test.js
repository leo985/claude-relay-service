jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/apiKeyMonthlyUsageService', () => ({}))
jest.mock('../src/utils/logger', () => ({ warn: jest.fn() }))

const { ApiKeyDailyUsageService } = require('../src/services/apiKeyDailyUsageService')

function createPipeline(commands, resolver) {
  const pipeline = {
    hgetall: jest.fn((key) => {
      commands.push(['hgetall', key])
      return pipeline
    }),
    get: jest.fn((key) => {
      commands.push(['get', key])
      return pipeline
    }),
    smembers: jest.fn((key) => {
      commands.push(['smembers', key])
      return pipeline
    }),
    zadd: jest.fn((key, score, member) => {
      commands.push(['zadd', key, score, member])
      return pipeline
    }),
    exec: jest.fn(async () => commands.map(resolver))
  }
  return pipeline
}

function createFixture() {
  const pipelines = []
  const transactionCommands = []
  const transaction = {
    del: jest.fn((...keys) => {
      transactionCommands.push(['del', ...keys])
      return transaction
    }),
    srem: jest.fn((...args) => {
      transactionCommands.push(['srem', ...args])
      return transaction
    }),
    exec: jest.fn(async () =>
      transactionCommands.map(([command]) => [null, command === 'del' ? 8 : 1])
    )
  }

  const client = {
    pipeline: jest.fn(() => {
      const commands = []
      const pipelineIndex = pipelines.length
      const pipeline = createPipeline(commands, ([command, key]) => {
        if (pipelineIndex === 0) {
          if (command === 'hgetall') {
            return [
              null,
              { requests: '5', inputTokens: '100', outputTokens: '50', allTokens: '150' }
            ]
          }
          if (command === 'get') {
            return [null, key.includes(':real:') ? '0.75' : '1.25']
          }
          if (key === 'usage:keymodel:daily:index:2026-07-12') {
            return [null, ['key-1:gpt-5', 'other-key:claude']]
          }
          if (key === 'usage:keymodel:hourly:index:2026-07-12:12') {
            return [null, ['key-1:gpt-5', 'other-key:claude']]
          }
          return [null, []]
        }

        if (pipelineIndex === 1) {
          return [null, key.endsWith(':2026-07-11') ? '2' : null]
        }

        return [null, 1]
      })
      pipelines.push({ commands, pipeline })
      return pipeline
    }),
    multi: jest.fn(() => transaction)
  }

  const monthlyUsageService = { invalidate: jest.fn() }
  const redis = {
    getApiKey: jest.fn(async () => ({ id: 'key-1', name: 'Test Key' })),
    getClientSafe: jest.fn(() => client),
    getDateStringInTimezone: jest.fn((date) => date.toISOString().slice(0, 10))
  }

  return { client, monthlyUsageService, pipelines, redis, transactionCommands }
}

describe('ApiKeyDailyUsageService', () => {
  const now = () => new Date('2026-07-12T12:30:00.000Z')

  test('resets only key-scoped daily and hourly usage and refreshes cost ranks', async () => {
    const fixture = createFixture()
    const service = new ApiKeyDailyUsageService({
      redis: fixture.redis,
      monthlyUsageService: fixture.monthlyUsageService,
      now
    })

    const result = await service.reset('key-1')

    expect(result).toMatchObject({
      keyId: 'key-1',
      date: '2026-07-12',
      deletedKeys: 8,
      resetModelStats: 1,
      previous: { requests: 5, tokens: 150, ratedCost: 1.25, realCost: 0.75 }
    })
    expect(fixture.monthlyUsageService.invalidate).toHaveBeenCalledWith('key-1', '2026-07-12')

    const deletedKeys = fixture.transactionCommands.find(([command]) => command === 'del').slice(1)
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'usage:daily:key-1:2026-07-12',
        'usage:cost:daily:key-1:2026-07-12',
        'usage:cost:real:daily:key-1:2026-07-12',
        'usage:key-1:model:daily:gpt-5:2026-07-12',
        'usage:hourly:key-1:2026-07-12:12',
        'usage:key-1:model:hourly:gpt-5:2026-07-12:12'
      ])
    )
    expect(deletedKeys.some((key) => key.includes(':alltime:'))).toBe(false)
    expect(deletedKeys.some((key) => key.includes(':monthly:'))).toBe(false)
    expect(deletedKeys.some((key) => key.startsWith('rate_limit:'))).toBe(false)

    expect(fixture.pipelines[2].commands).toEqual([
      ['zadd', 'cost_rank:today', 0, 'key-1'],
      ['zadd', 'cost_rank:7days', 2, 'key-1'],
      ['zadd', 'cost_rank:30days', 2, 'key-1']
    ])
    expect(fixture.redis.scanKeys).toBeUndefined()
  })

  test('rejects unknown API keys without changing usage data', async () => {
    const fixture = createFixture()
    fixture.redis.getApiKey.mockResolvedValueOnce({})
    const service = new ApiKeyDailyUsageService({
      redis: fixture.redis,
      monthlyUsageService: fixture.monthlyUsageService,
      now
    })

    await expect(service.reset('missing-key')).rejects.toMatchObject({
      code: 'API_KEY_NOT_FOUND'
    })
    expect(fixture.client.multi).not.toHaveBeenCalled()
  })
})
