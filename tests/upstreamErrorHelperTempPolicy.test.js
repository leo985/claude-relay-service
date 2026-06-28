const pipeline = {
  lpush: jest.fn().mockReturnThis(),
  ltrim: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  hincrby: jest.fn().mockReturnThis(),
  hset: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([])
}

const mockClient = {
  hgetall: jest.fn(),
  del: jest.fn(),
  setex: jest.fn(),
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

const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

describe('upstreamErrorHelper temp-unavailable policy', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockClient.del.mockResolvedValue(1)
    mockClient.setex.mockResolvedValue('OK')
    pipeline.exec.mockResolvedValue([])
  })

  it('loads OpenAI-Responses account policy before marking temp unavailable', async () => {
    mockClient.hgetall.mockResolvedValue({
      disableTempUnavailable: 'true'
    })

    const result = await upstreamErrorHelper.markTempUnavailable(
      'account-1',
      'openai-responses',
      529
    )

    expect(mockClient.hgetall).toHaveBeenCalledWith('openai_responses_account:account-1')
    expect(mockClient.del).toHaveBeenCalledWith('temp_unavailable:openai-responses:account-1')
    expect(mockClient.setex).not.toHaveBeenCalled()
    expect(pipeline.lpush).toHaveBeenCalledWith(
      'error_history:openai-responses:account-1',
      expect.any(String)
    )
    expect(pipeline.hincrby).toHaveBeenCalledWith(
      'account_error_stats:daily:openai-responses:account-1:2026-06-23',
      'type:overload',
      1
    )
    expect(result).toMatchObject({
      success: true,
      skipped: true,
      reason: 'account_temp_unavailable_disabled'
    })
  })
})
