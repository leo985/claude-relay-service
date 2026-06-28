const axios = require('axios')
const config = require('../../../config/config')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const { IncrementalSSEParser } = require('../../utils/sseParser')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const apiKeyService = require('../apiKeyService')
const openaiAccountService = require('../account/openaiAccountService')
const unifiedOpenAIScheduler = require('../scheduler/unifiedOpenAIScheduler')
const CodexToOpenAIConverter = require('../codexToOpenAI')
const {
  createRequestDetailMeta,
  extractOpenAICacheReadTokens
} = require('../../utils/requestDetailHelper')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const DEFAULT_MODEL = config.openai?.tokenAnthropicModel || 'gpt-5.4'
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.'
const ACCOUNT_TYPE = 'openai'

function toNonNegativeInt(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

class OpenAITokenAnthropicRelayService {
  _selectUpstreamModel(requestedModel, account = {}) {
    const explicitModel = account.boundModel || account.defaultModel || account.upstreamModel
    if (explicitModel && String(explicitModel).trim()) {
      return String(explicitModel).trim()
    }

    const model = typeof requestedModel === 'string' ? requestedModel.trim() : ''
    if (/^gpt-/i.test(model) || /codex/i.test(model)) {
      return model.replace(/^gpt-5-(?!codex)/i, 'gpt-5')
    }
    return DEFAULT_MODEL
  }

  _extractText(value) {
    if (!value) {
      return ''
    }
    if (typeof value === 'string') {
      return value
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') {
            return item
          }
          if (item?.type === 'text') {
            return item.text || ''
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    return String(value)
  }

  _imageSourceToUrl(source = {}) {
    if (source.type === 'base64' && source.data) {
      const mediaType = source.media_type || 'image/png'
      return `data:${mediaType};base64,${source.data}`
    }
    if (source.type === 'url' && source.url) {
      return source.url
    }
    if (source.url) {
      return source.url
    }
    return null
  }

  _anthropicContentToOpenAIContent(content) {
    if (typeof content === 'string') {
      return content
    }
    if (!Array.isArray(content)) {
      return this._extractText(content)
    }

    const parts = []
    for (const item of content) {
      if (!item || item.type === 'tool_result' || item.type === 'tool_use') {
        continue
      }
      if (item.type === 'text') {
        parts.push({ type: 'text', text: item.text || '' })
      } else if (item.type === 'image') {
        const url = this._imageSourceToUrl(item.source || {})
        if (url) {
          parts.push({ type: 'image_url', image_url: { url } })
        }
      }
    }

    if (parts.length === 1 && parts[0].type === 'text') {
      return parts[0].text
    }
    return parts.length > 0 ? parts : ''
  }

  _toolResultToText(toolResult) {
    const content = toolResult?.content
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') {
            return item
          }
          if (item?.type === 'text') {
            return item.text || ''
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    return content === undefined ? '' : JSON.stringify(content)
  }

  _convertAnthropicMessage(message = {}) {
    const content = Array.isArray(message.content) ? message.content : null
    if (message.role === 'assistant' && content) {
      const text = content
        .filter((item) => item?.type === 'text')
        .map((item) => item.text || '')
        .join('')
      const toolCalls = content
        .filter((item) => item?.type === 'tool_use')
        .map((item) => ({
          id: item.id,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: JSON.stringify(item.input || {})
          }
        }))
      const result = { role: 'assistant', content: text || null }
      if (toolCalls.length > 0) {
        result.tool_calls = toolCalls
      }
      return [result]
    }

    if (message.role === 'user' && content) {
      const nonToolContent = content.filter((item) => item?.type !== 'tool_result')
      const toolResults = content.filter((item) => item?.type === 'tool_result')
      const messages = []
      const convertedContent = this._anthropicContentToOpenAIContent(nonToolContent)
      if (
        (Array.isArray(convertedContent) && convertedContent.length > 0) ||
        (typeof convertedContent === 'string' && convertedContent)
      ) {
        messages.push({ role: 'user', content: convertedContent })
      }
      for (const toolResult of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: toolResult.tool_use_id,
          content: this._toolResultToText(toolResult)
        })
      }
      return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
    }

    return [
      {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: this._anthropicContentToOpenAIContent(message.content)
      }
    ]
  }

  _convertTools(tools = []) {
    return tools
      .filter((tool) => tool && tool.name)
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.input_schema || { type: 'object', properties: {} }
        }
      }))
  }

  _convertToolChoice(toolChoice) {
    if (!toolChoice) {
      return undefined
    }
    if (typeof toolChoice === 'string') {
      return toolChoice
    }
    if (toolChoice.type === 'tool' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } }
    }
    if (toolChoice.type === 'any') {
      return 'required'
    }
    if (toolChoice.type === 'auto') {
      return 'auto'
    }
    if (toolChoice.type === 'none') {
      return 'none'
    }
    return undefined
  }

  _buildCodexRequestBody(req, account = {}) {
    const body = req.body || {}
    const chatBody = {
      model: this._selectUpstreamModel(body.model, account),
      messages: [],
      stream: body.stream === true
    }

    for (const message of body.messages || []) {
      chatBody.messages.push(...this._convertAnthropicMessage(message))
    }
    if (chatBody.messages.length === 0) {
      chatBody.messages.push({ role: 'user', content: '' })
    }

    if (body.max_tokens !== undefined) {
      chatBody.max_completion_tokens = body.max_tokens
    }
    if (body.temperature !== undefined) {
      chatBody.temperature = body.temperature
    }
    if (body.top_p !== undefined) {
      chatBody.top_p = body.top_p
    }
    if (body.stop_sequences !== undefined) {
      chatBody.stop = body.stop_sequences
    }

    const tools = this._convertTools(body.tools || [])
    if (tools.length > 0) {
      chatBody.tools = tools
    }
    const toolChoice = this._convertToolChoice(body.tool_choice)
    if (toolChoice !== undefined) {
      chatBody.tool_choice = toolChoice
    }

    const converter = new CodexToOpenAIConverter()
    const codexBody = converter.buildRequestFromOpenAI(chatBody)
    codexBody.instructions = this._extractText(body.system) || DEFAULT_INSTRUCTIONS
    codexBody.stream = body.stream === true
    codexBody.store = false

    return codexBody
  }

  _buildHeaders(accessToken, account) {
    return {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': account.accountId || account.chatgptUserId || account.id,
      host: 'chatgpt.com',
      accept: 'text/event-stream',
      'content-type': 'application/json'
    }
  }

  _createRequestConfig(account, stream) {
    const requestConfig = {
      headers: {},
      timeout: config.requestTimeout || 600000,
      validateStatus: () => true
    }
    if (stream) {
      requestConfig.responseType = 'stream'
    }
    if (account.proxy) {
      const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
      if (proxyAgent) {
        requestConfig.httpAgent = proxyAgent
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
        logger.info(
          `🌐 Using proxy for token Anthropic fallback: ${ProxyHelper.getProxyDescription(account.proxy)}`
        )
      }
    }
    return requestConfig
  }

  async _ensureAccessToken(account) {
    let currentAccount = account
    if (openaiAccountService.isTokenExpired(currentAccount)) {
      if (!currentAccount.refreshToken) {
        const error = new Error(`Token expired and no refresh token available for ${account.name}`)
        error.statusCode = 403
        throw error
      }
      await openaiAccountService.refreshAccountToken(currentAccount.id)
      currentAccount = await openaiAccountService.getAccount(currentAccount.id)
    }

    const accessToken = openaiAccountService.decrypt(currentAccount.accessToken)
    if (!accessToken) {
      const error = new Error(`OpenAI account ${currentAccount.id} has no valid accessToken`)
      error.statusCode = 403
      throw error
    }
    return { account: currentAccount, accessToken }
  }

  _anthropicSSE(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }

  _writeAnthropicEvent(res, event, data) {
    if (!res.destroyed && !res.writableEnded) {
      res.write(this._anthropicSSE(event, data))
    }
  }

  _mapUsage(usage = {}) {
    return {
      input_tokens: toNonNegativeInt(usage.input_tokens),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: toNonNegativeInt(usage.input_tokens_details?.cached_tokens),
      output_tokens: toNonNegativeInt(usage.output_tokens)
    }
  }

  _safeJsonParse(value, fallback = {}) {
    if (!value) {
      return fallback
    }
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }

  _responseOutputToAnthropicContent(output = []) {
    const content = []
    for (const item of output || []) {
      if (item?.type === 'message') {
        for (const part of item.content || []) {
          if (part?.type === 'output_text' && part.text) {
            content.push({ type: 'text', text: part.text })
          }
        }
      } else if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
        content.push({
          type: 'tool_use',
          id: item.call_id || item.id,
          name: item.name || '',
          input: this._safeJsonParse(item.arguments || item.input, {})
        })
      }
    }
    return content.length > 0 ? content : [{ type: 'text', text: '' }]
  }

  _convertCompletedResponse(responseObj, requestedModel) {
    const content = this._responseOutputToAnthropicContent(responseObj.output || [])
    const hasToolUse = content.some((item) => item.type === 'tool_use')
    return {
      id: responseObj.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: requestedModel || responseObj.model || '',
      content,
      stop_reason:
        responseObj.status === 'incomplete' ? 'max_tokens' : hasToolUse ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: this._mapUsage(responseObj.usage || {})
    }
  }

  async _recordUsage({ req, apiKeyData, account, usageData, actualModel, statusCode }) {
    const inputTokens = toNonNegativeInt(usageData?.input_tokens)
    const outputTokens = toNonNegativeInt(usageData?.output_tokens)
    const cacheReadTokens = extractOpenAICacheReadTokens(usageData || {})
    const actualInputTokens = Math.max(0, inputTokens - cacheReadTokens)
    const model = actualModel || req.body?.model || DEFAULT_MODEL

    const costs = await apiKeyService.recordUsage(
      apiKeyData.id,
      actualInputTokens,
      outputTokens,
      0,
      cacheReadTokens,
      model,
      account.id,
      ACCOUNT_TYPE,
      req._serviceTier || null,
      createRequestDetailMeta(req, {
        requestBody: req.body,
        stream: req.body?.stream === true,
        statusCode
      })
    )

    const totalTokens = actualInputTokens + outputTokens + cacheReadTokens
    await openaiAccountService.updateAccountUsage(account.id, totalTokens)

    if (req.rateLimitInfo && totalTokens > 0) {
      await updateRateLimitCounters(
        req.rateLimitInfo,
        {
          inputTokens: actualInputTokens,
          outputTokens,
          cacheCreateTokens: 0,
          cacheReadTokens,
          totalTokens
        },
        model,
        apiKeyData.id,
        ACCOUNT_TYPE,
        costs
      ).catch((error) => {
        logger.error('❌ Failed to update token Anthropic fallback rate limit counters:', error)
      })
    }
  }

  async _readErrorBody(response) {
    let errorData = response.data
    if (response.data && typeof response.data.pipe === 'function') {
      const chunks = []
      await new Promise((resolve) => {
        response.data.on('data', (chunk) => chunks.push(chunk))
        response.data.on('end', resolve)
        response.data.on('error', resolve)
        setTimeout(resolve, 5000)
      })
      const raw = Buffer.concat(chunks).toString()
      try {
        errorData = JSON.parse(raw)
      } catch {
        errorData = { error: { message: raw || 'Unknown upstream error' } }
      }
    }
    return errorData
  }

  async _handleErrorResponse({ res, account, response }) {
    const errorData = await this._readErrorBody(response)
    if (response.status === 429) {
      const resetsInSeconds =
        errorData?.error?.resets_in_seconds ||
        errorData?.detail?.resets_in_seconds ||
        upstreamErrorHelper.parseRetryAfter(response.headers)
      await unifiedOpenAIScheduler
        .markAccountRateLimited(account.id, ACCOUNT_TYPE, null, resetsInSeconds)
        .catch(() => {})
    }
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      await upstreamErrorHelper
        .markTempUnavailable(account.id, ACCOUNT_TYPE, response.status)
        .catch(() => {})
    }

    return res.status(response.status).json(
      upstreamErrorHelper.buildSafeUpstreamErrorForClient(response.status, errorData, {
        format: 'anthropic'
      })
    )
  }

  async _handleStream({ req, res, response, account, apiKeyData, requestedModel }) {
    const parser = new IncrementalSSEParser()
    const state = {
      messageStarted: false,
      textBlockOpen: false,
      nextIndex: 0,
      responseId: '',
      toolItems: new Map(),
      usageData: null,
      actualModel: null,
      hasToolUse: false
    }

    const ensureMessageStart = () => {
      if (state.messageStarted) {
        return
      }
      state.messageStarted = true
      this._writeAnthropicEvent(res, 'message_start', {
        type: 'message_start',
        message: {
          id: state.responseId || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model: requestedModel || state.actualModel || DEFAULT_MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })
    }

    const ensureTextBlock = () => {
      ensureMessageStart()
      if (state.textBlockOpen) {
        return
      }
      state.textBlockOpen = true
      this._writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: state.nextIndex,
        content_block: { type: 'text', text: '' }
      })
    }

    const closeTextBlock = () => {
      if (!state.textBlockOpen) {
        return
      }
      this._writeAnthropicEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.nextIndex
      })
      state.textBlockOpen = false
      state.nextIndex += 1
    }

    const emitToolUse = (item) => {
      closeTextBlock()
      ensureMessageStart()
      state.hasToolUse = true
      const input = this._safeJsonParse(item.arguments || item.input, {})
      this._writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: state.nextIndex,
        content_block: {
          type: 'tool_use',
          id: item.call_id || item.id,
          name: item.name || '',
          input
        }
      })
      this._writeAnthropicEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.nextIndex
      })
      state.nextIndex += 1
    }

    const processEvent = (data) => {
      if (data.type === 'response.created' && data.response) {
        state.responseId = data.response.id || state.responseId
        state.actualModel = data.response.model || state.actualModel
      } else if (data.type === 'response.output_text.delta' && data.delta) {
        ensureTextBlock()
        this._writeAnthropicEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.nextIndex,
          delta: { type: 'text_delta', text: data.delta }
        })
      } else if (
        data.type === 'response.output_item.added' &&
        (data.item?.type === 'function_call' || data.item?.type === 'custom_tool_call')
      ) {
        state.toolItems.set(data.item.id || data.item.call_id || data.output_index, data.item)
      } else if (data.type === 'response.function_call_arguments.delta') {
        const key = data.item_id || data.output_index
        const item = state.toolItems.get(key) || { id: data.item_id, arguments: '' }
        item.arguments = `${item.arguments || ''}${data.delta || ''}`
        state.toolItems.set(key, item)
      } else if (
        data.type === 'response.output_item.done' &&
        (data.item?.type === 'function_call' || data.item?.type === 'custom_tool_call')
      ) {
        emitToolUse(data.item)
      } else if (data.type === 'response.completed' && data.response) {
        state.responseId = data.response.id || state.responseId
        state.actualModel = data.response.model || state.actualModel
        state.usageData = data.response.usage || state.usageData
      }
    }

    res.status(response.status)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }

    response.data.on('data', (chunk) => {
      try {
        const events = parser.feed(chunk.toString())
        for (const event of events) {
          if (event.type === 'data' && event.data) {
            processEvent(event.data)
          }
        }
      } catch (error) {
        logger.error('Error adapting token Anthropic fallback stream:', error)
      }
    })

    response.data.on('end', async () => {
      try {
        closeTextBlock()
        ensureMessageStart()
        const stopReason = state.hasToolUse ? 'tool_use' : 'end_turn'
        this._writeAnthropicEvent(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: this._mapUsage(state.usageData || {})
        })
        this._writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' })
        res.end()

        await this._recordUsage({
          req,
          apiKeyData,
          account,
          usageData: state.usageData,
          actualModel: state.actualModel,
          statusCode: response.status
        }).catch((error) => {
          logger.error('Failed to record token Anthropic fallback usage:', error)
        })
      } catch (error) {
        logger.error('Error finalizing token Anthropic fallback stream:', error)
        if (!res.headersSent) {
          res.status(500).end()
        } else {
          res.end()
        }
      }
    })

    response.data.on('error', (error) => {
      logger.error('Token Anthropic fallback upstream stream error:', error)
      if (!res.headersSent) {
        res.status(502).json(
          upstreamErrorHelper.buildSafeUpstreamErrorForClient(502, error, {
            format: 'anthropic'
          })
        )
      } else {
        res.end()
      }
    })
  }

  async handleRequest(req, res, account, apiKeyData) {
    const requestedModel = req.body?.model || null
    const { account: currentAccount, accessToken } = await this._ensureAccessToken(account)
    const stream = req.body?.stream === true
    const upstreamBody = this._buildCodexRequestBody(req, currentAccount)
    const requestConfig = this._createRequestConfig(currentAccount, stream)
    requestConfig.headers = this._buildHeaders(accessToken, currentAccount)

    logger.info(
      `🔀 Falling back to OpenAI token Codex account for Anthropic messages: ${currentAccount.name} (${currentAccount.id})`
    )

    const response = await axios.post(CODEX_ENDPOINT, upstreamBody, requestConfig)
    if (response.status >= 400) {
      return this._handleErrorResponse({ res, account: currentAccount, response })
    }

    if (stream && response.data && typeof response.data.pipe === 'function') {
      return this._handleStream({
        req,
        res,
        response,
        account: currentAccount,
        apiKeyData,
        requestedModel
      })
    }

    const responseObj = response.data?.response || response.data
    const clientPayload = this._convertCompletedResponse(responseObj || {}, requestedModel)
    await this._recordUsage({
      req,
      apiKeyData,
      account: currentAccount,
      usageData: responseObj?.usage,
      actualModel: responseObj?.model,
      statusCode: response.status
    }).catch((error) => {
      logger.error('Failed to record token Anthropic fallback usage:', error)
    })
    return res.status(response.status).json(clientPayload)
  }
}

module.exports = new OpenAITokenAnthropicRelayService()
