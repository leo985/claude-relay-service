const { normalizeUsage } = require('../src/utils/usageNormalizer')

describe('usageNormalizer', () => {
  test('subtracts cached prompt tokens for Azure/OpenAI style usage', () => {
    const usage = normalizeUsage('azure-openai', {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30 }
    })

    expect(usage.totalInputTokens).toBe(100)
    expect(usage.inputTokens).toBe(70)
    expect(usage.cacheReadTokens).toBe(30)
    expect(usage.outputTokens).toBe(20)
    expect(usage.totalTokens).toBe(120)
  })

  test('uses cache_creation breakdown when top-level total is absent', () => {
    const usage = normalizeUsage('ccr', {
      input_tokens: '10',
      output_tokens: '5',
      cache_creation: {
        ephemeral_5m_input_tokens: '3',
        ephemeral_1h_input_tokens: '4'
      },
      cache_read_input_tokens: '2'
    })

    expect(usage.inputTokens).toBe(10)
    expect(usage.outputTokens).toBe(5)
    expect(usage.cacheCreateTokens).toBe(7)
    expect(usage.cacheReadTokens).toBe(2)
    expect(usage.ephemeral5mTokens).toBe(3)
    expect(usage.ephemeral1hTokens).toBe(4)
    expect(usage.totalTokens).toBe(24)
  })
})
