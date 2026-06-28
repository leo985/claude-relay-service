class OpenAIResponsesAdapters {
  constructor() {
    this._defaultReasoningEffort = 'medium'
  }

  buildResponsesAdapterContext(responsesBody = {}) {
    const body = responsesBody && typeof responsesBody === 'object' ? responsesBody : {}
    const toolTypes = {}

    for (const tool of body.tools || []) {
      const name = this._responsesToolName(tool)
      if (name && typeof tool?.type === 'string') {
        toolTypes[name] = tool.type
      }
    }

    return { toolTypes }
  }

  buildChatCompletionsRequestFromResponses(responsesBody = {}) {
    const body = responsesBody && typeof responsesBody === 'object' ? responsesBody : {}
    const messages = []

    const instructions = this._extractText(body.instructions)
    if (instructions) {
      messages.push({ role: 'system', content: instructions })
    }

    messages.push(...this._responsesInputToChatMessages(body.input))
    if (messages.length === 0) {
      messages.push({ role: 'user', content: '' })
    }

    const result = {
      model: body.model,
      messages
    }

    this._copyIfPresent(body, result, 'stream')
    this._copyIfPresent(body, result, 'temperature')
    this._copyIfPresent(body, result, 'top_p')
    this._copyIfPresent(body, result, 'user')
    this._copyIfPresent(body, result, 'stop')
    this._copyIfPresent(body, result, 'metadata')

    if (body.max_output_tokens !== undefined) {
      result.max_tokens = body.max_output_tokens
    }
    if (body.max_completion_tokens !== undefined) {
      result.max_completion_tokens = body.max_completion_tokens
    }
    if (body.reasoning && typeof body.reasoning === 'object' && body.reasoning.effort) {
      result.reasoning_effort = body.reasoning.effort
    } else if (body.reasoning_effort) {
      result.reasoning_effort = body.reasoning_effort
    }

    const tools = this._responsesToolsToChatTools(body.tools || [])
    if (tools.length > 0) {
      result.tools = tools
    }
    if (body.tool_choice !== undefined) {
      result.tool_choice = this._responsesToolChoiceToChat(body.tool_choice)
    }
    if (body.text?.format) {
      result.response_format = this._responsesTextFormatToChat(body.text.format)
    }

    return result
  }

  buildAnthropicMessagesRequestFromResponses(responsesBody = {}) {
    const chatBody = this.buildChatCompletionsRequestFromResponses(responsesBody)
    const systemParts = []
    const messages = []

    for (const message of chatBody.messages || []) {
      if (message.role === 'system' || message.role === 'developer') {
        const systemText = this._extractText(message.content)
        if (systemText) {
          systemParts.push(systemText)
        }
        continue
      }

      if (message.role === 'tool') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content: this._extractText(message.content)
            }
          ]
        })
        continue
      }

      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        const content = []
        const text = this._extractText(message.content)
        if (text) {
          content.push({ type: 'text', text })
        }
        for (const toolCall of message.tool_calls) {
          const args = toolCall.function?.arguments
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function?.name || '',
            input: this._safeJsonParse(args, {})
          })
        }
        messages.push({ role: 'assistant', content })
        continue
      }

      const role = message.role === 'assistant' ? 'assistant' : 'user'
      messages.push({ role, content: this._chatContentToAnthropic(message.content) })
    }

    if (messages.length === 0) {
      messages.push({ role: 'user', content: '' })
    }

    const result = {
      model: chatBody.model,
      messages,
      max_tokens: chatBody.max_tokens || chatBody.max_completion_tokens || 4096,
      stream: chatBody.stream === true
    }

    if (systemParts.length > 0) {
      result.system = systemParts.join('\n\n')
    }
    this._copyIfPresent(chatBody, result, 'temperature')
    this._copyIfPresent(chatBody, result, 'top_p')
    this._copyIfPresent(chatBody, result, 'stop', 'stop_sequences')

    const tools = this._chatToolsToAnthropicTools(chatBody.tools || [])
    if (tools.length > 0) {
      result.tools = tools
    }
    if (chatBody.tool_choice !== undefined) {
      result.tool_choice = this._chatToolChoiceToAnthropic(chatBody.tool_choice)
    }

    const reasoningEffort = this._resolveAnthropicThinkingEffort(responsesBody)
    if (reasoningEffort && result.max_tokens > 1024) {
      result.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(
          this._reasoningEffortToBudget(reasoningEffort),
          result.max_tokens - 1
        )
      }
    }

    return result
  }

  /**
   * 从 Responses 请求体中解析出 Anthropic thinking 应使用的 effort。
   * 仅当客户端明确表达 reasoning 意图（effort / summary / include）且未显式禁用时返回 effort，
   * 否则返回 null（不启用 thinking）。
   */
  _resolveAnthropicThinkingEffort(responsesBody = {}) {
    if (!responsesBody || typeof responsesBody !== 'object') {
      return null
    }

    const { reasoning } = responsesBody
    if (reasoning !== undefined && reasoning !== null) {
      if (typeof reasoning === 'object') {
        const summary = String(reasoning.summary || '').toLowerCase()
        if (summary === 'none' || summary === 'off' || summary === 'disabled') {
          return null
        }
        const effort = reasoning.effort
          ? String(reasoning.effort).toLowerCase()
          : this._defaultReasoningEffort
        return this._isValidReasoningEffort(effort) ? effort : this._defaultReasoningEffort
      }
      const effort = String(reasoning).toLowerCase()
      if (effort === 'disabled' || effort === 'none' || effort === 'off') {
        return null
      }
      return this._isValidReasoningEffort(effort) ? effort : this._defaultReasoningEffort
    }

    if (responsesBody.reasoning_effort) {
      const effort = String(responsesBody.reasoning_effort).toLowerCase()
      return this._isValidReasoningEffort(effort) ? effort : this._defaultReasoningEffort
    }

    if (Array.isArray(responsesBody.include)) {
      const wantsReasoning = responsesBody.include.some(
        (item) => typeof item === 'string' && item.toLowerCase().startsWith('reasoning')
      )
      if (wantsReasoning) {
        return this._defaultReasoningEffort
      }
    }

    return null
  }

  _isValidReasoningEffort(effort) {
    return effort === 'low' || effort === 'medium' || effort === 'high'
  }

  convertChatCompletionToResponse(chatResponse = {}, requestedModel = null, context = {}) {
    const adapterContext = this._normalizeAdapterContext(context)
    const choice = Array.isArray(chatResponse.choices) ? chatResponse.choices[0] || {} : {}
    const message = choice.message || {}
    const output = []
    const text = this._extractText(message.content)
    const reasoningText = this._extractReasoningText(message)

    if (reasoningText) {
      output.push(this._buildReasoningResponseItem({ text: reasoningText }))
    }

    if (
      text ||
      (!reasoningText && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0))
    ) {
      output.push({
        id: this._makeId('msg'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: text ? [{ type: 'output_text', text, annotations: [] }] : []
      })
    }

    for (const toolCall of message.tool_calls || []) {
      if (toolCall.type && toolCall.type !== 'function') {
        continue
      }
      output.push(this._chatToolCallToResponseItem(toolCall, adapterContext))
    }

    const finishReason = choice.finish_reason || 'stop'
    const response = {
      id: this._normalizeResponseId(chatResponse.id),
      object: 'response',
      created_at: chatResponse.created || Math.floor(Date.now() / 1000),
      status: finishReason === 'length' ? 'incomplete' : 'completed',
      model: requestedModel || chatResponse.model || '',
      output,
      parallel_tool_calls: true,
      tool_choice: 'auto'
    }

    if (finishReason === 'length') {
      response.incomplete_details = { reason: 'max_output_tokens' }
    }

    const usage = this._chatUsageToResponsesUsage(chatResponse.usage)
    if (usage) {
      response.usage = usage
    }

    return response
  }

  convertClaudeMessageToResponse(claudeResponse = {}, requestedModel = null, context = {}) {
    const adapterContext = this._normalizeAdapterContext(context)
    const output = []
    const textParts = []
    const thinkingParts = []
    const redactedThinkingParts = []
    const toolItems = []

    const contentItems =
      typeof claudeResponse.content === 'string'
        ? [claudeResponse.content]
        : Array.isArray(claudeResponse.content)
          ? claudeResponse.content
          : []

    for (const item of contentItems) {
      if (typeof item === 'string') {
        textParts.push(item)
      } else if (item?.type === 'text') {
        textParts.push(item.text || '')
      } else if (item?.type === 'tool_use') {
        toolItems.push(this._anthropicToolUseToResponseItem(item, adapterContext))
      } else if (item?.type === 'thinking') {
        const thinkingText = item.thinking || item.text || ''
        if (thinkingText) {
          thinkingParts.push(thinkingText)
        }
      } else if (item?.type === 'redacted_thinking') {
        const encryptedContent =
          item.data || item.encrypted_content || item.thinking || item.text || ''
        if (encryptedContent) {
          redactedThinkingParts.push(encryptedContent)
        }
      }
    }

    if (thinkingParts.length > 0 || redactedThinkingParts.length > 0) {
      output.push(
        this._buildReasoningResponseItem({
          text: thinkingParts.join(''),
          encryptedContent: redactedThinkingParts.join('')
        })
      )
    }

    if (textParts.length > 0 || (output.length === 0 && toolItems.length === 0)) {
      output.push({
        id: this._makeId('msg'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content:
          textParts.length > 0
            ? [{ type: 'output_text', text: textParts.join(''), annotations: [] }]
            : []
      })
    }
    output.push(...toolItems)

    const status = claudeResponse.stop_reason === 'max_tokens' ? 'incomplete' : 'completed'
    const response = {
      id: this._normalizeResponseId(claudeResponse.id),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: requestedModel || claudeResponse.model || '',
      output,
      parallel_tool_calls: true,
      tool_choice: 'auto'
    }

    if (status === 'incomplete') {
      response.incomplete_details = { reason: 'max_output_tokens' }
    }

    const usage = this._anthropicUsageToResponsesUsage(claudeResponse.usage)
    if (usage) {
      response.usage = usage
    }

    return response
  }

  createChatToResponsesStreamState(context = {}) {
    return {
      adapterContext: this._normalizeAdapterContext(context),
      responseId: '',
      createdAt: Math.floor(Date.now() / 1000),
      model: '',
      outputIndexCounter: 0,
      reasoningStarted: false,
      reasoningItemId: '',
      reasoningOutputIndex: null,
      reasoningText: '',
      messageStarted: false,
      messageItemId: '',
      messageOutputIndex: null,
      text: '',
      toolCalls: new Map(),
      finishReason: null,
      usage: null,
      completed: false
    }
  }

  convertChatStreamChunkToResponses(eventData = {}, requestedModel = null, state) {
    if (!state || state.completed) {
      return []
    }
    if (eventData.error) {
      return [this._sse('error', { type: 'error', error: eventData.error })]
    }

    if (eventData.id && !state.responseId) {
      state.responseId = this._normalizeResponseId(eventData.id)
    }
    if (eventData.created) {
      state.createdAt = eventData.created
    }
    if (eventData.model) {
      state.model = requestedModel || eventData.model
    }
    if (eventData.usage) {
      state.usage = this._chatUsageToResponsesUsage(eventData.usage)
    }

    const chunks = this._ensureResponseCreated(state, requestedModel)
    const choices = Array.isArray(eventData.choices) ? eventData.choices : []
    for (const choice of choices) {
      const delta = choice.delta || {}
      const reasoningDelta = this._extractReasoningText(delta)
      if (reasoningDelta) {
        chunks.push(...this._ensureReasoningOutput(state))
        state.reasoningText += reasoningDelta
        chunks.push(
          this._sse('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: state.reasoningItemId,
            output_index: state.reasoningOutputIndex,
            summary_index: 0,
            delta: reasoningDelta
          })
        )
      }

      if (delta.content) {
        chunks.push(...this._ensureMessageOutput(state))
        state.text += delta.content
        chunks.push(
          this._sse('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: state.messageItemId,
            output_index: state.messageOutputIndex,
            content_index: 0,
            delta: delta.content
          })
        )
      }

      for (const toolCall of delta.tool_calls || []) {
        const toolIndex = Number.isInteger(toolCall.index) ? toolCall.index : 0
        const existing = state.toolCalls.get(toolIndex) || {
          id: toolCall.id || this._makeId('call'),
          name: '',
          arguments: '',
          announced: false,
          outputIndex: this._nextOutputIndex(state)
        }
        if (toolCall.id) {
          existing.id = toolCall.id
        }
        if (toolCall.function?.name) {
          existing.name = toolCall.function.name
        }
        state.toolCalls.set(toolIndex, existing)

        if (!existing.announced && existing.name) {
          existing.announced = true
          const item = this._buildStreamingToolItem(existing, state.adapterContext, {
            inProgress: true
          })
          chunks.push(
            this._sse('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: existing.outputIndex,
              item
            })
          )
        }

        if (toolCall.function?.arguments) {
          existing.arguments += toolCall.function.arguments
          if (!this._isCustomToolName(existing.name, state.adapterContext)) {
            chunks.push(
              this._sse('response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta',
                item_id: existing.id,
                output_index: existing.outputIndex,
                delta: toolCall.function.arguments
              })
            )
          }
        }
      }

      if (choice.finish_reason) {
        state.finishReason = choice.finish_reason
      }
    }

    return chunks
  }

  finalizeChatToResponsesStream(requestedModel = null, state) {
    if (!state || state.completed) {
      return []
    }
    const chunks = this._ensureResponseCreated(state, requestedModel)

    const output = []

    if (state.reasoningStarted) {
      const reasoningItem = this._buildReasoningResponseItem({
        id: state.reasoningItemId,
        text: state.reasoningText
      })
      output.push(reasoningItem)
      chunks.push(
        this._sse('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          item_id: state.reasoningItemId,
          output_index: state.reasoningOutputIndex,
          summary_index: 0,
          text: state.reasoningText
        })
      )
      chunks.push(
        this._sse('response.reasoning_summary_part.done', {
          type: 'response.reasoning_summary_part.done',
          item_id: state.reasoningItemId,
          output_index: state.reasoningOutputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: state.reasoningText }
        })
      )
      chunks.push(
        this._sse('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: state.reasoningOutputIndex,
          item: reasoningItem
        })
      )
    }

    if (state.messageStarted) {
      const messageItem = {
        id: state.messageItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: state.text, annotations: [] }]
      }
      output.push(messageItem)
      chunks.push(
        this._sse('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: state.messageItemId,
          output_index: state.messageOutputIndex,
          content_index: 0,
          text: state.text
        })
      )
      chunks.push(
        this._sse('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: state.messageItemId,
          output_index: state.messageOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: state.text, annotations: [] }
        })
      )
      chunks.push(
        this._sse('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: state.messageOutputIndex,
          item: messageItem
        })
      )
    }

    for (const [index, toolCall] of state.toolCalls.entries()) {
      const item = this._buildStreamingToolItem(toolCall, state.adapterContext)
      output.push(item)
      const outputIndex = Number.isInteger(toolCall.outputIndex) ? toolCall.outputIndex : index
      if (item.type === 'custom_tool_call') {
        chunks.push(
          this._sse('response.custom_tool_call_input.done', {
            type: 'response.custom_tool_call_input.done',
            item_id: toolCall.id,
            output_index: outputIndex,
            input: item.input || ''
          })
        )
      } else {
        chunks.push(
          this._sse('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            item_id: toolCall.id,
            output_index: outputIndex,
            arguments: toolCall.arguments || '{}'
          })
        )
      }
      chunks.push(
        this._sse('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item
        })
      )
    }

    const status = state.finishReason === 'length' ? 'incomplete' : 'completed'
    const response = {
      id: state.responseId || this._makeId('resp'),
      object: 'response',
      created_at: state.createdAt || Math.floor(Date.now() / 1000),
      status,
      model: state.model || requestedModel || '',
      output
    }
    if (status === 'incomplete') {
      response.incomplete_details = { reason: 'max_output_tokens' }
    }
    if (state.usage) {
      response.usage = state.usage
    }

    state.completed = true
    chunks.push(this._sse('response.completed', { type: 'response.completed', response }))
    return chunks
  }

  _responsesInputToChatMessages(input) {
    if (input === undefined || input === null) {
      return []
    }
    if (typeof input === 'string') {
      return [{ role: 'user', content: input }]
    }
    if (!Array.isArray(input)) {
      return [{ role: 'user', content: this._extractText(input) }]
    }

    const messages = []
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item })
        continue
      }
      if (!item || typeof item !== 'object') {
        continue
      }
      if (item.type === 'message' || item.role) {
        const role = this._responsesRoleToChat(item.role || 'user')
        messages.push({ role, content: this._responsesContentToChatContent(item.content, role) })
        continue
      }
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id || item.id || this._makeId('call'),
              type: 'function',
              function: {
                name: item.name || '',
                arguments: this._stringifyArguments(item.arguments)
              }
            }
          ]
        })
        continue
      }
      if (item.type === 'custom_tool_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id || item.id || this._makeId('call'),
              type: 'function',
              function: {
                name: item.name || '',
                arguments: this._customInputToChatArguments(item.input)
              }
            }
          ]
        })
        continue
      }
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
        })
        continue
      }
      if (item.type === 'custom_tool_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
        })
        continue
      }
      if (item.type === 'input_text' || item.type === 'output_text') {
        messages.push({ role: 'user', content: item.text || '' })
      }
    }
    return messages
  }

  _responsesRoleToChat(role) {
    if (role === 'developer') {
      return 'system'
    }
    if (role === 'system') {
      return 'system'
    }
    if (role === 'assistant') {
      return 'assistant'
    }
    if (role === 'tool') {
      return 'tool'
    }
    return 'user'
  }

  _responsesContentToChatContent(content, role = 'user') {
    if (typeof content === 'string') {
      return content
    }
    const items = Array.isArray(content) ? content : content ? [content] : []
    const parts = []
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        if (item !== undefined && item !== null) {
          parts.push({ type: 'text', text: String(item) })
        }
        continue
      }
      if (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') {
        parts.push({ type: 'text', text: item.text || '' })
      } else if (item.type === 'input_image' || item.type === 'image_url') {
        const url = item.image_url?.url || item.image_url || item.url
        if (url) {
          parts.push({ type: 'image_url', image_url: { url } })
        }
      }
    }
    if (parts.every((part) => part.type === 'text')) {
      return parts.map((part) => part.text).join('')
    }
    if (role !== 'user') {
      return parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    }
    return parts
  }

  _responsesToolName(tool) {
    return tool?.name || tool?.function?.name || ''
  }

  _customToolDescription(tool) {
    const description = tool.description || tool.function?.description || ''
    const adapterHint =
      'Adapter note: provide the raw custom tool input in the JSON string field "input".'
    return description ? `${description}\n\n${adapterHint}` : adapterHint
  }

  _responsesCustomToolParameters(tool) {
    if (tool.parameters && typeof tool.parameters === 'object') {
      return tool.parameters
    }
    if (tool.input_schema && typeof tool.input_schema === 'object') {
      return tool.input_schema
    }
    if (tool.function?.parameters && typeof tool.function.parameters === 'object') {
      return tool.function.parameters
    }
    return {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Raw input for the custom Responses tool.'
        }
      },
      required: ['input']
    }
  }

  _responsesToolsToChatTools(tools) {
    const result = []
    for (const tool of tools || []) {
      if (!tool || typeof tool !== 'object') {
        continue
      }
      if (tool.type === 'custom') {
        const name = this._responsesToolName(tool)
        if (!name) {
          continue
        }
        result.push({
          type: 'function',
          function: {
            name,
            description: this._customToolDescription(tool),
            parameters: this._responsesCustomToolParameters(tool)
          }
        })
        continue
      }
      if (tool.type !== 'function') {
        continue
      }
      result.push({
        type: 'function',
        function: {
          name: tool.name || tool.function?.name || '',
          description: tool.description || tool.function?.description || '',
          parameters: tool.parameters ||
            tool.function?.parameters || { type: 'object', properties: {} },
          ...(tool.strict !== undefined || tool.function?.strict !== undefined
            ? { strict: tool.strict ?? tool.function.strict }
            : {})
        }
      })
    }
    return result
  }

  _responsesToolChoiceToChat(toolChoice) {
    if (typeof toolChoice === 'string') {
      return toolChoice
    }
    if (toolChoice?.type === 'function' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } }
    }
    if (toolChoice?.type === 'function' && toolChoice.function?.name) {
      return { type: 'function', function: { name: toolChoice.function.name } }
    }
    if (toolChoice?.type === 'custom' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } }
    }
    return 'auto'
  }

  _responsesTextFormatToChat(format) {
    if (!format || typeof format !== 'object') {
      return undefined
    }
    if (format.type === 'text') {
      return { type: 'text' }
    }
    if (format.type === 'json_schema') {
      return {
        type: 'json_schema',
        json_schema: {
          name: format.name || 'response_schema',
          strict: format.strict,
          schema: format.schema || {}
        }
      }
    }
    return undefined
  }

  _chatContentToAnthropic(content) {
    if (typeof content === 'string') {
      return content
    }
    if (!Array.isArray(content)) {
      return this._extractText(content)
    }
    const result = []
    for (const part of content) {
      if (part?.type === 'text') {
        result.push({ type: 'text', text: part.text || '' })
      } else if (part?.type === 'image_url') {
        const imageUrl = part.image_url?.url || part.image_url
        if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
          const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
          if (match) {
            result.push({
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] }
            })
          }
        }
      }
    }
    return result.length === 1 && result[0].type === 'text' ? result[0].text : result
  }

  _chatToolsToAnthropicTools(tools) {
    return (tools || [])
      .filter((tool) => tool?.type === 'function' && tool.function)
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} }
      }))
  }

  _chatToolChoiceToAnthropic(toolChoice) {
    if (toolChoice === 'none') {
      return { type: 'none' }
    }
    if (toolChoice === 'required') {
      return { type: 'any' }
    }
    if (toolChoice?.type === 'function' && toolChoice.function?.name) {
      return { type: 'tool', name: toolChoice.function.name }
    }
    return { type: 'auto' }
  }

  _ensureResponseCreated(state, requestedModel) {
    if (state.responseCreated) {
      return []
    }
    state.responseCreated = true
    state.responseId = state.responseId || this._makeId('resp')
    return [
      this._sse('response.created', {
        type: 'response.created',
        response: {
          id: state.responseId,
          object: 'response',
          created_at: state.createdAt || Math.floor(Date.now() / 1000),
          status: 'in_progress',
          model: state.model || requestedModel || '',
          output: []
        }
      })
    ]
  }

  _ensureReasoningOutput(state) {
    if (state.reasoningStarted) {
      return []
    }
    state.reasoningStarted = true
    state.reasoningItemId = state.reasoningItemId || this._makeId('rs')
    state.reasoningOutputIndex = this._nextOutputIndex(state)
    return [
      this._sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: state.reasoningOutputIndex,
        item: {
          id: state.reasoningItemId,
          type: 'reasoning',
          status: 'in_progress',
          summary: []
        }
      }),
      this._sse('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        item_id: state.reasoningItemId,
        output_index: state.reasoningOutputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' }
      })
    ]
  }

  _ensureMessageOutput(state) {
    if (state.messageStarted) {
      return []
    }
    state.messageStarted = true
    state.messageItemId = state.messageItemId || this._makeId('msg')
    state.messageOutputIndex = this._nextOutputIndex(state)
    return [
      this._sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: state.messageOutputIndex,
        item: {
          id: state.messageItemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: []
        }
      }),
      this._sse('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: state.messageItemId,
        output_index: state.messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      })
    ]
  }

  _chatUsageToResponsesUsage(usage) {
    if (!usage) {
      return undefined
    }
    const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0)
    const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0)
    const result = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: Number(usage.total_tokens || inputTokens + outputTokens)
    }
    const cachedTokens =
      usage.prompt_tokens_details?.cached_tokens || usage.input_tokens_details?.cached_tokens
    if (cachedTokens !== undefined) {
      result.input_tokens_details = { cached_tokens: Number(cachedTokens) || 0 }
    }
    const reasoningTokens =
      usage.completion_tokens_details?.reasoning_tokens ||
      usage.output_tokens_details?.reasoning_tokens
    if (reasoningTokens !== undefined) {
      result.output_tokens_details = { reasoning_tokens: Number(reasoningTokens) || 0 }
    }
    return result
  }

  _anthropicUsageToResponsesUsage(usage) {
    if (!usage) {
      return undefined
    }
    const inputTokens = Number(usage.input_tokens || 0)
    const outputTokens = Number(usage.output_tokens || 0)
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  }

  _extractText(value) {
    if (value === undefined || value === null) {
      return ''
    }
    if (typeof value === 'string') {
      return value
    }
    if (Array.isArray(value)) {
      return value.map((item) => this._extractText(item)).join('')
    }
    if (typeof value === 'object') {
      return value.text || value.content || JSON.stringify(value)
    }
    return String(value)
  }

  _extractReasoningText(value = {}) {
    if (!value || typeof value !== 'object') {
      return ''
    }
    let candidate = value.reasoning_content ?? value.reasoning_summary ?? value.reasoning?.summary
    if (candidate === undefined && value.reasoning && typeof value.reasoning === 'object') {
      candidate = value.reasoning.content ?? value.reasoning.text
    } else if (candidate === undefined && typeof value.reasoning === 'string') {
      candidate = value.reasoning
    }
    if (candidate === undefined || candidate === null) {
      return ''
    }
    return this._extractText(candidate)
  }

  _buildReasoningResponseItem({ id = null, text = '', encryptedContent = '' } = {}) {
    const item = {
      id: id || this._makeId('rs'),
      type: 'reasoning',
      status: 'completed',
      summary: []
    }
    if (text) {
      item.summary.push({ type: 'summary_text', text })
    }
    if (encryptedContent) {
      item.encrypted_content = encryptedContent
    }
    return item
  }

  _nextOutputIndex(state) {
    const next = Number.isInteger(state.outputIndexCounter) ? state.outputIndexCounter : 0
    state.outputIndexCounter = next + 1
    return next
  }

  _copyIfPresent(from, to, field, targetField = field) {
    if (from[field] !== undefined) {
      to[targetField] = from[field]
    }
  }

  _safeJsonParse(value, fallback) {
    if (value === undefined || value === null || value === '') {
      return fallback
    }
    if (typeof value !== 'string') {
      return value
    }
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }

  _stringifyArguments(value) {
    if (typeof value === 'string') {
      return value
    }
    return JSON.stringify(value ?? {})
  }

  _normalizeAdapterContext(context = {}) {
    const rawToolTypes = context?.toolTypes
    const toolTypes =
      rawToolTypes instanceof Map
        ? Object.fromEntries(rawToolTypes.entries())
        : rawToolTypes && typeof rawToolTypes === 'object'
          ? { ...rawToolTypes }
          : {}

    return { toolTypes }
  }

  _isCustomToolName(name, context = {}) {
    return !!name && this._normalizeAdapterContext(context).toolTypes[name] === 'custom'
  }

  _customInputToChatArguments(input) {
    if (typeof input === 'string') {
      return JSON.stringify({ input })
    }
    if (input === undefined || input === null) {
      return JSON.stringify({ input: '' })
    }
    return JSON.stringify({ input: this._stringifyArguments(input) })
  }

  _chatToolArgumentsToCustomInput(value) {
    if (value === undefined || value === null || value === '') {
      return ''
    }

    if (typeof value !== 'string') {
      if (typeof value === 'object' && !Array.isArray(value) && value.input !== undefined) {
        return typeof value.input === 'string' ? value.input : this._stringifyArguments(value.input)
      }
      return this._stringifyArguments(value)
    }

    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'string') {
        return parsed
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.input !== undefined) {
          return typeof parsed.input === 'string'
            ? parsed.input
            : this._stringifyArguments(parsed.input)
        }
        return JSON.stringify(parsed)
      }
      return String(parsed ?? '')
    } catch {
      return value
    }
  }

  _chatToolCallToResponseItem(toolCall, context = {}) {
    const id = toolCall.id || this._makeId('call')
    const name = toolCall.function?.name || ''
    if (this._isCustomToolName(name, context)) {
      return {
        id,
        type: 'custom_tool_call',
        status: 'completed',
        call_id: id,
        name,
        input: this._chatToolArgumentsToCustomInput(toolCall.function?.arguments)
      }
    }

    return {
      id,
      type: 'function_call',
      status: 'completed',
      call_id: id,
      name,
      arguments: this._stringifyArguments(toolCall.function?.arguments)
    }
  }

  _anthropicToolUseToResponseItem(toolUse, context = {}) {
    const id = toolUse.id || this._makeId('call')
    const name = toolUse.name || ''
    if (this._isCustomToolName(name, context)) {
      return {
        id,
        type: 'custom_tool_call',
        status: 'completed',
        call_id: id,
        name,
        input: this._chatToolArgumentsToCustomInput(toolUse.input || {})
      }
    }

    return {
      id,
      type: 'function_call',
      status: 'completed',
      call_id: id,
      name,
      arguments: this._stringifyArguments(toolUse.input || {})
    }
  }

  _buildStreamingToolItem(toolCall, context = {}, { inProgress = false } = {}) {
    const id = toolCall.id || this._makeId('call')
    const name = toolCall.name || ''
    const status = inProgress ? 'in_progress' : 'completed'
    if (this._isCustomToolName(name, context)) {
      return {
        id,
        type: 'custom_tool_call',
        status,
        call_id: id,
        name,
        input: inProgress ? '' : this._chatToolArgumentsToCustomInput(toolCall.arguments)
      }
    }

    return {
      id,
      type: 'function_call',
      status,
      call_id: id,
      name,
      arguments: inProgress ? '' : toolCall.arguments || '{}'
    }
  }

  _reasoningEffortToBudget(effort) {
    switch (String(effort).toLowerCase()) {
      case 'low':
        return 1024
      case 'high':
        return 8192
      case 'medium':
      default:
        return 4096
    }
  }

  _normalizeResponseId(id) {
    if (id && String(id).startsWith('resp_')) {
      return String(id)
    }
    return id ? `resp_${String(id).replace(/^(chatcmpl-|msg_)/, '')}` : this._makeId('resp')
  }

  _makeId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 12)}`
  }

  _sse(event, payload) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  }
}

module.exports = OpenAIResponsesAdapters
