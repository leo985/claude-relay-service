jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/services/account/ccrAccountService', () => ({}))

jest.mock('../src/services/userMessageQueueService', () => ({
  enqueue: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  buildSafeUpstreamErrorForClient: jest.fn((_status, error) => error),
  markTempUnavailable: jest.fn()
}))

const ccrRelayService = require('../src/services/relay/ccrRelayService')

describe('ccrRelayService usage parsing', () => {
  test('merges Anthropic message_start input/cache usage with message_delta output usage', () => {
    const messageStart = ccrRelayService._parseSSELineForUsage(
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation: {
              ephemeral_5m_input_tokens: 3,
              ephemeral_1h_input_tokens: 7
            }
          }
        }
      })}`
    )
    const messageDelta = ccrRelayService._parseSSELineForUsage(
      `data: ${JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 40 }
      })}`
    )

    const merged = {}
    ccrRelayService._mergeUsageSnapshot(merged, messageStart)
    ccrRelayService._mergeUsageSnapshot(merged, messageDelta)

    expect(merged).toMatchObject({
      input_tokens: 100,
      output_tokens: 40,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 7
      },
      model: 'claude-sonnet-4-5'
    })
  })
})
