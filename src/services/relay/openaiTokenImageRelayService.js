/**
 * token 方式（OAuth/ChatGPT）OpenAI 账号的图片生成中继。
 *
 * 把标准的 /images/generations 请求适配成 codex/responses 流式调用 +
 * image_generation 工具，读完整条 SSE 流后返回标准 {data:[{b64_json}]}。
 *
 * 已验证的上游契约（见项目记忆 token-account-image-gen-contract.md）：
 *   POST https://chatgpt.com/backend-api/codex/responses
 *   model 必须是普通模型（gpt-5.4）；stream 必须 true；
 *   instructions 必填；input 必须是数组；图片在 response.completed 的
 *   response.output[] 里（type:image_generation 的 b64_json）。
 *
 * 与 openaiImageRelayService（responses 账号、API Key、非流式、/v1/images/generations）
 * 是完全不同的上游路径，故独立实现；usage 解析复用 utils/openaiImageUsage。
 */

const axios = require('axios')
const logger = require('../../utils/logger')
const ProxyHelper = require('../../utils/proxyHelper')
const { IncrementalSSEParser } = require('../../utils/sseParser')
const apiKeyService = require('../apiKeyService')
const openaiAccountService = require('../account/openaiAccountService')
const unifiedOpenAIScheduler = require('../scheduler/unifiedOpenAIScheduler')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  createRequestDetailMeta,
  extractOpenAICacheReadTokens
} = require('../../utils/requestDetailHelper')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const config = require('../../../config/config')

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
// token 账号图片生成使用的模型（可通过 OPENAI_TOKEN_IMAGE_MODEL 配置，默认 gpt-5.4）
const IMAGE_MODEL = config.openai?.tokenImageModel || 'gpt-5.4'
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.'
const IMAGE_TIMEOUT_MS = 150000
const ACCOUNT_TYPE = 'openai'

function toNonNegativeInt(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

class OpenAITokenImageRelayService {
  // 从 /images/generations 请求体构造 codex/responses 请求体
  _buildRequestBody(req) {
    const body = req.body || {}
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) {
      const error = new Error('prompt is required for image generation')
      error.statusCode = 400
      error.code = 'invalid_request_error'
      throw error
    }

    // MVP：codex image_generation 工具单次只产 1 张图，n>1 暂不支持
    const n = Math.max(1, parseInt(body.n, 10) || 1)
    if (n > 1) {
      const error = new Error(
        'Token-mode image generation currently supports only n=1 (multiple images not yet supported)'
      )
      error.statusCode = 400
      error.code = 'unsupported_n'
      throw error
    }

    const tool = { type: 'image_generation' }
    if (body.size) {
      tool.size = body.size
    }
    if (body.quality) {
      tool.quality = body.quality
    }

    return {
      model: IMAGE_MODEL,
      instructions: body.instructions || DEFAULT_INSTRUCTIONS,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }]
        }
      ],
      tools: [tool],
      stream: true,
      store: false
    }
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

  _createProxyConfig(account) {
    const requestOptions = {}
    if (account.proxy) {
      const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
      if (proxyAgent) {
        requestOptions.httpAgent = proxyAgent
        requestOptions.httpsAgent = proxyAgent
        requestOptions.proxy = false
        logger.info(
          `🌐 Using proxy for token-mode image generation: ${ProxyHelper.getProxyDescription(account.proxy)}`
        )
      }
    }
    return requestOptions
  }

  // 从 response.completed 的 response.output 中取图片 base64
  _findImageItem(responseObj) {
    const output = responseObj?.output
    if (!Array.isArray(output)) {
      return null
    }
    return output.find((item) => item && item.type === 'image_generation' && item.b64_json) || null
  }

  // 读取上游 SSE 流，捕获最终图片 base64 + usage + 实际模型
  _consumeStream(stream) {
    return new Promise((resolve, reject) => {
      const parser = new IncrementalSSEParser()
      let imageB64 = null
      let usageData = null
      let actualModel = null
      const cleanup = () => {
        stream.removeAllListeners('data')
        stream.removeAllListeners('end')
        stream.removeAllListeners('error')
      }

      stream.on('data', (chunk) => {
        try {
          const events = parser.feed(chunk.toString())
          for (const event of events) {
            if (event.type !== 'data' || !event.data) {
              continue
            }
            const { data } = event
            if (data.type === 'response.completed' && data.response) {
              actualModel = data.response.model || actualModel
              if (data.response.usage) {
                usageData = data.response.usage
              }
              const item = this._findImageItem(data.response)
              if (item?.b64_json) {
                imageB64 = item.b64_json
              }
            } else if (
              data.type === 'response.output_item.done' &&
              data.item?.type === 'image_generation' &&
              data.item.b64_json
            ) {
              imageB64 = data.item.b64_json
            }
          }
        } catch (error) {
          logger.error('Error parsing token-mode image SSE chunk:', error)
        }
      })

      stream.on('end', () => {
        cleanup()
        resolve({ imageB64, usageData, actualModel })
      })

      stream.on('error', (err) => {
        cleanup()
        reject(err)
      })
    })
  }

  // 把错误响应（可能为流）读成 JSON
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
      const fullResponse = Buffer.concat(chunks).toString()
      try {
        errorData = JSON.parse(fullResponse)
      } catch {
        errorData = { error: { message: fullResponse || 'Unknown upstream error' } }
      }
    }
    return errorData
  }

  async _handleErrorResponse({ res, account, response }) {
    const errorData = await this._readErrorBody(response)
    const autoProtectionDisabled =
      account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'

    if (response.status === 429) {
      const resetsInSeconds =
        errorData?.error?.resets_in_seconds ||
        errorData?.detail?.resets_in_seconds ||
        upstreamErrorHelper.parseRetryAfter(response.headers)
      await unifiedOpenAIScheduler
        .markAccountRateLimited(account.id, ACCOUNT_TYPE, null, resetsInSeconds)
        .catch(() => {})
      if (!autoProtectionDisabled) {
        await upstreamErrorHelper
          .markTempUnavailable(account.id, ACCOUNT_TYPE, 429, resetsInSeconds)
          .catch(() => {})
      }
    } else if (response.status === 401 || response.status === 403 || response.status >= 500) {
      if (!autoProtectionDisabled) {
        await upstreamErrorHelper
          .markTempUnavailable(account.id, ACCOUNT_TYPE, response.status)
          .catch(() => {})
      }
    }

    logger.warn('Token-mode image upstream error', {
      accountId: account.id,
      status: response.status,
      errorData
    })

    if (res.headersSent) {
      return res.end()
    }
    return res
      .status(response.status)
      .json(upstreamErrorHelper.sanitizeErrorForClient(errorData, { statusCode: response.status }))
  }

  async _recordUsage({ req, account, apiKeyData, usageData, actualModel, statusCode }) {
    // token 账号的图片生成与文本走同一条 codex/responses 上游，usage 形态一致
    // （input_tokens/output_tokens），且 gpt-5.4 只有文本 token 定价（无 image-token
    // 专用价）。因此按文本 token 计费，与 handleResponses 的记录方式保持一致。
    const model = actualModel || IMAGE_MODEL

    const totalInputTokens = toNonNegativeInt(usageData?.input_tokens)
    const outputTokens = toNonNegativeInt(usageData?.output_tokens)
    const cacheReadTokens = extractOpenAICacheReadTokens(usageData || {})
    const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

    if (!usageData) {
      logger.warn('📊 Token-mode image completed without usage; recording zero usage', {
        accountId: account.id,
        model
      })
    }

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
        stream: true,
        statusCode
      })
    )

    const usageSummary = {
      totalInputTokens: actualInputTokens + cacheReadTokens,
      inputTokens: actualInputTokens,
      outputTokens,
      cacheCreateTokens: 0,
      cacheReadTokens,
      totalTokens: actualInputTokens + outputTokens + cacheReadTokens
    }
    await openaiAccountService.updateAccountUsage(account.id, usageSummary.totalTokens)

    if (req.rateLimitInfo && usageSummary.totalTokens > 0) {
      try {
        await updateRateLimitCounters(
          req.rateLimitInfo,
          usageSummary,
          model,
          apiKeyData.id,
          ACCOUNT_TYPE,
          costs
        )
      } catch (error) {
        logger.error('❌ Failed to update token-mode image rate limit counters:', error)
      }
    }

    return { usageSummary, costs }
  }

  async handleGenerations(req, res, account, apiKeyData, accessToken) {
    let abortController = null
    let handleClientDisconnect = null

    try {
      if (req.body?.stream === true) {
        return res.status(400).json({
          error: {
            message: 'Image streaming is not supported by this relay yet',
            type: 'invalid_request_error',
            code: 'image_stream_not_supported'
          }
        })
      }

      const upstreamBody = this._buildRequestBody(req)

      abortController = new AbortController()
      handleClientDisconnect = () => {
        if (abortController && !abortController.signal.aborted) {
          logger.info('🔌 Client disconnected, aborting token-mode image generation')
          abortController.abort()
        }
      }
      req.once('aborted', handleClientDisconnect)
      res.once('close', () => {
        if (!res.writableEnded) {
          handleClientDisconnect()
        }
      })

      const headers = this._buildHeaders(accessToken, account)

      logger.info('🖼️ Token-mode image generation request', {
        accountId: account.id,
        accountName: account.name,
        model: IMAGE_MODEL,
        size: req.body?.size,
        quality: req.body?.quality
      })

      const response = await axios({
        method: 'POST',
        url: CODEX_ENDPOINT,
        headers,
        data: upstreamBody,
        timeout: IMAGE_TIMEOUT_MS,
        responseType: 'stream',
        validateStatus: () => true,
        signal: abortController.signal,
        ...this._createProxyConfig(account)
      })

      if (response.status >= 400) {
        return this._handleErrorResponse({ res, account, response })
      }

      const { imageB64, usageData, actualModel } = await this._consumeStream(response.data)

      await openaiAccountService.updateAccount(account.id, {
        lastUsedAt: new Date().toISOString()
      })

      await this._recordUsage({
        req,
        account,
        apiKeyData,
        usageData,
        actualModel,
        statusCode: response.status
      })

      if (!imageB64) {
        logger.error('Token-mode image stream completed without an image item', {
          accountId: account.id
        })
        if (!res.headersSent) {
          return res.status(502).json({
            error: {
              message: 'Upstream completed without returning an image',
              type: 'upstream_error',
              code: 'no_image_returned'
            }
          })
        }
        return res.end()
      }

      return res.status(200).json({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: imageB64 }]
      })
    } catch (error) {
      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }

      logger.error('Token-mode image generation relay error:', {
        message: error.message,
        code: error.code,
        status: error.response?.status
      })

      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        await upstreamErrorHelper.markTempUnavailable(account.id, ACCOUNT_TYPE, 504).catch(() => {})
        if (!res.headersSent) {
          return res.status(504).json({
            error: {
              message: 'Image generation timed out',
              type: 'upstream_error',
              code: 'timeout'
            }
          })
        }
        return res.end()
      }

      if (res.headersSent) {
        return res.end()
      }

      if (error.statusCode && !error.response) {
        return res.status(error.statusCode).json({
          error: {
            message: error.message || 'Invalid request',
            type: error.code || 'invalid_request_error',
            code: error.code || 'invalid_request'
          }
        })
      }

      const status = error.statusCode || error.response?.status || 500
      return res
        .status(status)
        .json(
          upstreamErrorHelper.buildSafeUpstreamErrorForClient(status, error.response?.data || error)
        )
    } finally {
      if (handleClientDisconnect) {
        req.removeListener('aborted', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)
      }
    }
  }
}

module.exports = new OpenAITokenImageRelayService()
