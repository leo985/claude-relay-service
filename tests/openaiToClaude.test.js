const openaiToClaude = require('../src/services/openaiToClaude')

function parseOpenAIStreamChunks(sse) {
  return sse
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk) => !chunk.includes('data: [DONE]'))
    .map((chunk) => {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '))
      return JSON.parse(dataLine.slice(6))
    })
}

describe('OpenAIToClaudeConverter response conversion', () => {
  test('converts Anthropic thinking_delta stream events to reasoning_content', () => {
    const result = openaiToClaude.convertStreamChunk(
      [
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"internal thought"}}',
        '',
        ''
      ].join('\n'),
      'glm-5.2',
      'chatcmpl-test'
    )

    const chunks = parseOpenAIStreamChunks(result)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].choices[0].delta).toEqual({ reasoning_content: 'internal thought' })
  })

  test('drops Anthropic signature_delta stream events instead of emitting empty chunks', () => {
    const result = openaiToClaude.convertStreamChunk(
      [
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}',
        '',
        ''
      ].join('\n'),
      'glm-5.2',
      'chatcmpl-test'
    )

    expect(result).toBe('')
  })

  test('preserves Anthropic non-stream thinking blocks as reasoning_content', () => {
    const result = openaiToClaude.convertResponse(
      {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'internal thought' },
          { type: 'text', text: 'final answer' }
        ],
        stop_reason: 'end_turn'
      },
      'glm-5.2'
    )

    expect(result.choices[0].message).toMatchObject({
      content: 'final answer',
      reasoning_content: 'internal thought'
    })
  })
})
