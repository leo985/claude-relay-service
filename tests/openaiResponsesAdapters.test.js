const OpenAIResponsesAdapters = require('../src/services/openaiResponsesAdapters')

function parseSSEPayload(chunk) {
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(dataLine.slice(5).trim())
}

describe('OpenAIResponsesAdapters', () => {
  let adapters

  beforeEach(() => {
    adapters = new OpenAIResponsesAdapters()
  })

  test('converts Responses requests to Chat Completions requests', () => {
    const result = adapters.buildChatCompletionsRequestFromResponses({
      model: 'gpt-5.5',
      instructions: 'be concise',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }]
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'look up data',
          parameters: { type: 'object', properties: { q: { type: 'string' } } }
        }
      ],
      tool_choice: { type: 'function', name: 'lookup' },
      max_output_tokens: 123,
      stream: true
    })

    expect(result).toMatchObject({
      model: 'gpt-5.5',
      stream: true,
      max_tokens: 123,
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' }
      ],
      tools: [
        {
          type: 'function',
          function: expect.objectContaining({ name: 'lookup' })
        }
      ],
      tool_choice: { type: 'function', function: { name: 'lookup' } }
    })
  })

  test('maps Responses custom tools onto Chat function tools and skips unsupported built-ins', () => {
    const result = adapters.buildChatCompletionsRequestFromResponses({
      model: 'gpt-5.5',
      input: 'edit file',
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'Apply a patch',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' }
        },
        { type: 'web_search' }
      ],
      tool_choice: { type: 'custom', name: 'apply_patch' }
    })

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'apply_patch',
        parameters: {
          type: 'object',
          properties: { input: expect.objectContaining({ type: 'string' }) },
          required: ['input']
        }
      }
    })
    expect(result.tools[0].function.description).toContain('raw custom tool input')
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'apply_patch' } })
  })

  test('round-trips Responses custom tool calls through Chat messages and responses', () => {
    const chatRequest = adapters.buildChatCompletionsRequestFromResponses({
      model: 'gpt-5.5',
      input: [
        {
          type: 'custom_tool_call',
          call_id: 'call_patch',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch'
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_patch',
          output: 'Done'
        }
      ]
    })

    expect(chatRequest.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_patch',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' })
            }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_patch', content: 'Done' }
    ])

    const context = adapters.buildResponsesAdapterContext({
      tools: [{ type: 'custom', name: 'apply_patch' }]
    })
    const response = adapters.convertChatCompletionToResponse(
      {
        id: 'chatcmpl-1',
        created: 123,
        model: 'glm-5.2',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_patch',
                  type: 'function',
                  function: {
                    name: 'apply_patch',
                    arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' })
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      'gpt-5.5',
      context
    )

    expect(response.output).toEqual([
      {
        id: 'call_patch',
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call_patch',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch'
      }
    ])
  })

  test('streams custom Chat tool calls back as Responses custom tool calls', () => {
    const state = adapters.createChatToResponsesStreamState({
      toolTypes: { apply_patch: 'custom' }
    })

    const chunks = adapters.convertChatStreamChunkToResponses(
      {
        id: 'chatcmpl-1',
        created: 123,
        model: 'glm-5.2',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_patch',
                  type: 'function',
                  function: {
                    name: 'apply_patch',
                    arguments: JSON.stringify({ input: 'patch' })
                  }
                }
              ]
            }
          }
        ]
      },
      'gpt-5.5',
      state
    )
    const finalChunks = adapters.finalizeChatToResponsesStream('gpt-5.5', state)
    const output = [...chunks, ...finalChunks].join('\n')

    expect(output).toContain('"type":"custom_tool_call"')
    expect(output).toContain('"type":"response.custom_tool_call_input.done"')
    expect(output).toContain('"input":"patch"')
    expect(output).not.toContain('response.function_call_arguments.delta')
  })

  test('converts Responses requests to Anthropic Messages requests for passthrough accounts', () => {
    const result = adapters.buildAnthropicMessagesRequestFromResponses({
      model: 'glm-5.2',
      instructions: 'system prompt',
      input: 'say hi',
      max_output_tokens: 456,
      stream: true
    })

    expect(result).toMatchObject({
      model: 'glm-5.2',
      system: 'system prompt',
      max_tokens: 456,
      stream: true,
      messages: [{ role: 'user', content: 'say hi' }]
    })
  })

  test('enables Anthropic thinking when Responses client requests reasoning summary without effort', () => {
    const result = adapters.buildAnthropicMessagesRequestFromResponses({
      model: 'glm-5.2',
      input: 'say hi',
      reasoning: { summary: 'auto' },
      max_output_tokens: 4096,
      stream: true
    })

    expect(result.thinking).toBeDefined()
    expect(result.thinking.type).toBe('enabled')
    expect(result.thinking.budget_tokens).toBeGreaterThan(0)
    expect(result.thinking.budget_tokens).toBeLessThan(result.max_tokens)
  })

  test('enables Anthropic thinking when Responses client requests reasoning via include array', () => {
    const result = adapters.buildAnthropicMessagesRequestFromResponses({
      model: 'glm-5.2',
      input: 'say hi',
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 8192,
      stream: true
    })

    expect(result.thinking).toBeDefined()
    expect(result.thinking.type).toBe('enabled')
  })

  test('preserves explicit reasoning effort when enabling Anthropic thinking', () => {
    const result = adapters.buildAnthropicMessagesRequestFromResponses({
      model: 'glm-5.2',
      input: 'say hi',
      reasoning: { effort: 'low', summary: 'auto' },
      max_output_tokens: 4096,
      stream: true
    })

    expect(result.thinking).toBeDefined()
    expect(result.thinking.budget_tokens).toBe(1024)
  })

  test('does not enable Anthropic thinking when reasoning is explicitly disabled', () => {
    const result = adapters.buildAnthropicMessagesRequestFromResponses({
      model: 'glm-5.2',
      input: 'say hi',
      reasoning: { effort: 'low', summary: 'none' },
      max_output_tokens: 4096,
      stream: true
    })

    expect(result.thinking).toBeUndefined()
  })

  test('converts Chat Completions responses to Responses payloads', () => {
    const result = adapters.convertChatCompletionToResponse(
      {
        id: 'chatcmpl-1',
        created: 123,
        model: 'glm-5.2',
        choices: [
          {
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      },
      'gpt-5.5'
    )

    expect(result).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'gpt-5.5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done', annotations: [] }]
        }
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
    })
  })

  test('preserves Chat Completions reasoning_content in Responses payloads', () => {
    const result = adapters.convertChatCompletionToResponse(
      {
        id: 'chatcmpl-1',
        created: 123,
        model: 'glm-5.2',
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning_content: 'think first',
              content: 'final answer'
            },
            finish_reason: 'stop'
          }
        ]
      },
      'gpt-5.5'
    )

    expect(result.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'think first' }]
    })
    expect(result.output[1]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'final answer', annotations: [] }]
    })
  })

  test('streams Chat reasoning_content as Responses reasoning summary deltas', () => {
    const state = adapters.createChatToResponsesStreamState()

    const chunks = adapters.convertChatStreamChunkToResponses(
      {
        id: 'chatcmpl-1',
        created: 123,
        model: 'glm-5.2',
        choices: [
          {
            delta: { reasoning_content: 'hidden thought' }
          }
        ]
      },
      'gpt-5.5',
      state
    )
    const finalChunks = adapters.finalizeChatToResponsesStream('gpt-5.5', state)
    const output = [...chunks, ...finalChunks].join('\n')
    const completed = finalChunks.find((chunk) => chunk.includes('event: response.completed'))
    const completedPayload = parseSSEPayload(completed)

    expect(output).toContain('response.reasoning_summary_text.delta')
    expect(output).toContain('"delta":"hidden thought"')
    expect(output).toContain('response.reasoning_summary_text.done')
    expect(completedPayload.response.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'hidden thought' }]
    })
  })

  test('converts Anthropic Messages responses to Responses payloads', () => {
    const result = adapters.convertClaudeMessageToResponse(
      {
        id: 'msg_1',
        model: 'glm-5.2',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 6 }
      },
      'gpt-5.5'
    )

    expect(result).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'gpt-5.5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello', annotations: [] }]
        }
      ],
      usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 }
    })
  })

  test('preserves Anthropic thinking blocks in Responses payloads', () => {
    const result = adapters.convertClaudeMessageToResponse(
      {
        id: 'msg_1',
        model: 'glm-5.2',
        content: [
          { type: 'thinking', thinking: 'private thought' },
          { type: 'redacted_thinking', data: 'sealed' },
          { type: 'text', text: 'hello' }
        ],
        stop_reason: 'end_turn'
      },
      'gpt-5.5'
    )

    expect(result.output[0]).toMatchObject({
      type: 'reasoning',
      encrypted_content: 'sealed',
      summary: [{ type: 'summary_text', text: 'private thought' }]
    })
    expect(result.output[1]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'hello', annotations: [] }]
    })
  })
})
