const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const { filterForOpenAI } = require('../../utils/headerFilter')
const openaiResponsesAccountService = require('../account/openaiResponsesAccountService')
const apiKeyService = require('../apiKeyService')
const unifiedOpenAIScheduler = require('../scheduler/unifiedOpenAIScheduler')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { createRequestDetailMeta } = require('../../utils/requestDetailHelper')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const { RESERVED_CUSTOM_HEADERS, clonePlainObject } = require('../../utils/openaiCompatible')
const config = require('../../../config/config')

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = toNumber(value)
    if (parsed > 0) {
      return parsed
    }
  }
  return 0
}

class OpenAIImageRelayService {
  constructor() {
    this.defaultTimeout = config.requestTimeout || 300000
  }

  _buildTargetUrl(baseApi, targetPath) {
    const normalizedBaseApi = (baseApi || '').replace(/\/+$/, '')
    const normalizedTargetPath = this._stripDuplicatedVersionPath(normalizedBaseApi, targetPath)
    return `${normalizedBaseApi}${normalizedTargetPath}`
  }

  _stripDuplicatedVersionPath(baseApi, targetPath) {
    const safePath = targetPath || ''
    const normalizedTargetPath = safePath.startsWith('/') ? safePath : `/${safePath}`

    if (/\/v\d+$/i.test(baseApi) && /^\/v\d+\//i.test(normalizedTargetPath)) {
      return normalizedTargetPath.replace(/^\/v\d+/i, '')
    }

    return normalizedTargetPath
  }

  _buildUpstreamHeaders(req, fullAccount, options = {}) {
    const headers = {
      ...filterForOpenAI(req.headers || {}),
      Authorization: `Bearer ${fullAccount.apiKey}`
    }

    if (options.contentType) {
      headers['Content-Type'] = options.contentType
    } else {
      headers['Content-Type'] = 'application/json'
    }

    if (fullAccount.userAgent) {
      headers['User-Agent'] = fullAccount.userAgent
    } else if (req.headers?.['user-agent']) {
      headers['User-Agent'] = req.headers['user-agent']
    }

    const extraHeaders = fullAccount.customHeaders || {}
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (RESERVED_CUSTOM_HEADERS.has(key.toLowerCase())) {
        logger.warn('Skipping reserved custom header', { key })
        continue
      }
      headers[key] = value
    }

    return headers
  }

  _createProxyConfig(fullAccount) {
    const requestOptions = {}
    if (fullAccount.proxy) {
      const proxyAgent = ProxyHelper.createProxyAgent(fullAccount.proxy)
      if (proxyAgent) {
        requestOptions.httpAgent = proxyAgent
        requestOptions.httpsAgent = proxyAgent
        requestOptions.proxy = false
        logger.info(
          `🌐 Using proxy for OpenAI Images: ${ProxyHelper.getProxyDescription(fullAccount.proxy)}`
        )
      }
    }
    return requestOptions
  }

  _extractImageUsage(usageData = {}) {
    if (!usageData || typeof usageData !== 'object') {
      return {
        kind: 'image',
        inputTextTokens: 0,
        inputImageTokens: 0,
        outputImageTokens: 0,
        cacheReadTextTokens: 0,
        cacheReadImageTokens: 0,
        totalTokens: 0,
        rawUsage: usageData || null
      }
    }

    const inputDetails = usageData.input_tokens_details || usageData.prompt_tokens_details || {}
    const outputDetails =
      usageData.output_tokens_details || usageData.completion_tokens_details || {}
    const cacheDetails = usageData.cache_read_input_tokens_details || {}

    let inputTextTokens = firstNumber(
      inputDetails.text_tokens,
      inputDetails.input_text_tokens,
      usageData.input_text_tokens,
      usageData.prompt_text_tokens
    )
    const inputImageTokens = firstNumber(
      inputDetails.image_tokens,
      inputDetails.input_image_tokens,
      usageData.input_image_tokens,
      usageData.prompt_image_tokens
    )
    const outputImageTokens = firstNumber(
      outputDetails.image_tokens,
      outputDetails.output_image_tokens,
      usageData.output_image_tokens,
      usageData.output_tokens,
      usageData.completion_tokens
    )
    const cacheReadTextTokens = firstNumber(
      inputDetails.cached_text_tokens,
      cacheDetails.text_tokens,
      usageData.cache_read_text_tokens
    )
    const cacheReadImageTokens = firstNumber(
      inputDetails.cached_image_tokens,
      cacheDetails.image_tokens,
      usageData.cache_read_image_tokens
    )

    if (!inputTextTokens && !inputImageTokens) {
      inputTextTokens = firstNumber(usageData.input_tokens, usageData.prompt_tokens)
    }

    const knownTotal =
      inputTextTokens +
      inputImageTokens +
      outputImageTokens +
      cacheReadTextTokens +
      cacheReadImageTokens
    const totalTokens = firstNumber(usageData.total_tokens, knownTotal)

    return {
      kind: 'image',
      inputTextTokens: inputTextTokens || (knownTotal ? 0 : toNumber(usageData.input_tokens)),
      inputImageTokens,
      outputImageTokens,
      cacheReadTextTokens,
      cacheReadImageTokens,
      totalTokens,
      rawUsage: usageData
    }
  }

  _usageSummaryForRateLimits(imageUsage = {}) {
    const inputTokens = toNumber(imageUsage.inputTextTokens) + toNumber(imageUsage.inputImageTokens)
    const outputTokens = toNumber(imageUsage.outputImageTokens)
    const cacheReadTokens =
      toNumber(imageUsage.cacheReadTextTokens) + toNumber(imageUsage.cacheReadImageTokens)
    return {
      totalInputTokens: inputTokens + cacheReadTokens,
      inputTokens,
      outputTokens,
      cacheCreateTokens: 0,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens
    }
  }

  async _recordImageUsage({
    req,
    account,
    apiKeyData,
    model,
    responseData,
    statusCode,
    operation
  }) {
    const usageData = responseData?.usage || responseData?.response?.usage || null
    const imageUsage = usageData
      ? this._extractImageUsage(usageData)
      : this._extractImageUsage(null)

    if (!usageData) {
      logger.warn('📊 OpenAI Images response completed without usage; recording zero usage', {
        accountId: account.id,
        model,
        operation
      })
    }

    const costs = await apiKeyService.recordImageUsage({
      keyId: apiKeyData.id,
      imageUsage,
      model,
      accountId: account.id,
      accountType: 'openai-responses',
      requestMeta: createRequestDetailMeta(req, {
        requestBody: req._openaiImageRequestDetailBody || req.body,
        stream: false,
        statusCode
      })
    })

    const usageSummary = this._usageSummaryForRateLimits(imageUsage)
    await openaiResponsesAccountService.updateAccountUsage(account.id, usageSummary.totalTokens)

    const dailyQuota = parseFloat(account.dailyQuota) || 0
    if (dailyQuota > 0 && costs?.realCost > 0) {
      await openaiResponsesAccountService.updateUsageQuota(account.id, costs.realCost)
    }

    if (usageSummary.totalTokens > 0) {
      await this._applyRateLimitTracking(req, usageSummary, model, costs, operation)
    }

    return { imageUsage, usageSummary, costs }
  }

  async _applyRateLimitTracking(req, usageSummary, model, costs, context) {
    if (!req?.rateLimitInfo) {
      return
    }

    try {
      await updateRateLimitCounters(
        req.rateLimitInfo,
        usageSummary,
        model,
        req.apiKey?.id,
        'openai-responses',
        costs
      )
    } catch (error) {
      logger.error(`❌ Failed to update OpenAI image rate limit counters (${context}):`, error)
    }
  }

  async _handleErrorResponse({ res, account, response, sessionHash, operation }) {
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

    if (response.status === 429) {
      const resetsInSeconds =
        errorData?.error?.resets_in_seconds || upstreamErrorHelper.parseRetryAfter(response.headers)
      await unifiedOpenAIScheduler.markAccountRateLimited(
        account.id,
        'openai-responses',
        sessionHash,
        resetsInSeconds
      )
      const autoProtectionDisabled =
        account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
      if (!autoProtectionDisabled) {
        await upstreamErrorHelper
          .markTempUnavailable(account.id, 'openai-responses', 429, resetsInSeconds)
          .catch(() => {})
      }
    } else if (response.status === 401 || response.status === 403 || response.status >= 500) {
      const autoProtectionDisabled =
        account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
      if (!autoProtectionDisabled) {
        await upstreamErrorHelper
          .markTempUnavailable(account.id, 'openai-responses', response.status)
          .catch(() => {})
      }
      if (sessionHash) {
        await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
      }
    }

    logger.warn('OpenAI Images upstream error', {
      operation,
      accountId: account.id,
      status: response.status,
      errorData
    })

    return res.status(response.status).json(upstreamErrorHelper.sanitizeErrorForClient(errorData))
  }

  async _getFullAccount(account) {
    const fullAccount = await openaiResponsesAccountService.getAccount(account.id, {
      includeSecretHeaders: true
    })
    if (!fullAccount) {
      const error = new Error('Account not found')
      error.statusCode = 404
      throw error
    }
    return fullAccount
  }

  async handleGenerations(req, res, account, apiKeyData) {
    let abortController = null
    let handleClientDisconnect = null
    const sessionHash = null

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

      const fullAccount = await this._getFullAccount(account)
      abortController = new AbortController()
      handleClientDisconnect = () => {
        if (abortController && !abortController.signal.aborted) {
          abortController.abort()
        }
      }
      // close fires on IncomingMessage after 'end' (Node destroys the consumed
      // stream). For real client disconnects, use 'aborted'; for the response
      // side, only abort if we haven't finished writing yet.
      req.once('aborted', handleClientDisconnect)
      res.once('close', () => {
        if (!res.writableEnded) {
          handleClientDisconnect()
        }
      })

      const body = clonePlainObject(req.body || {})
      const requestedModel = body.model || 'gpt-image-2'
      const upstreamModel = fullAccount.imageBoundModel?.trim() || requestedModel
      body.model = upstreamModel
      req._openaiImageRequestDetailBody = body

      const targetUrl = this._buildTargetUrl(fullAccount.baseApi, '/v1/images/generations')
      const headers = this._buildUpstreamHeaders(req, fullAccount)

      logger.info('🖼️ OpenAI image generation request', {
        accountId: account.id,
        accountName: account.name,
        targetUrl,
        requestedModel,
        upstreamModel,
        size: body.size,
        quality: body.quality,
        n: body.n || 1
      })

      const response = await axios({
        method: 'POST',
        url: targetUrl,
        headers,
        data: body,
        timeout: this.defaultTimeout,
        responseType: 'json',
        validateStatus: () => true,
        signal: abortController.signal,
        ...this._createProxyConfig(fullAccount)
      })

      if (response.status >= 400) {
        return this._handleErrorResponse({
          req,
          res,
          account,
          response,
          sessionHash,
          operation: 'generations'
        })
      }

      await openaiResponsesAccountService.updateAccount(account.id, {
        lastUsedAt: new Date().toISOString()
      })

      await this._recordImageUsage({
        req,
        account,
        apiKeyData,
        model: upstreamModel,
        responseData: response.data,
        statusCode: response.status,
        operation: 'generations'
      })

      return res.status(response.status).json(response.data)
    } catch (error) {
      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }

      logger.error('OpenAI image generation relay error:', {
        message: error.message,
        code: error.code,
        status: error.response?.status
      })

      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        await upstreamErrorHelper
          .markTempUnavailable(account.id, 'openai-responses', 503)
          .catch(() => {})
      }

      if (res.headersSent) {
        return res.end()
      }

      return res.status(error.statusCode || error.response?.status || 500).json({
        error: {
          message: error.message || 'Internal server error',
          type: error.code || 'api_error',
          code: error.code || 'internal_error'
        }
      })
    } finally {
      if (handleClientDisconnect) {
        req.removeListener('aborted', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)
      }
    }
  }

  async handleEdits(req, res, account, apiKeyData) {
    let abortController = null
    let handleClientDisconnect = null
    const contentType = req.headers?.['content-type'] || ''
    const sessionHash = null

    try {
      if (!/^multipart\/form-data/i.test(contentType)) {
        return res.status(415).json({
          error: {
            message: 'Image edits require multipart/form-data in MVP',
            type: 'invalid_request_error',
            code: 'unsupported_media_type'
          }
        })
      }

      const fullAccount = await this._getFullAccount(account)
      abortController = new AbortController()
      handleClientDisconnect = () => {
        if (abortController && !abortController.signal.aborted) {
          abortController.abort()
        }
      }
      // close fires on IncomingMessage after 'end' (when Node destroys the
      // consumed stream), so it's not a reliable client-disconnect signal for
      // multipart. Use 'aborted' instead, which only fires when the client
      // actually disconnects.
      req.once('aborted', handleClientDisconnect)
      res.once('close', () => {
        if (!res.writableEnded) {
          handleClientDisconnect()
        }
      })

      const targetUrl = this._buildTargetUrl(fullAccount.baseApi, '/v1/images/edits')
      const headers = this._buildUpstreamHeaders(req, fullAccount, { contentType })
      req._openaiImageRequestDetailBody = {
        multipart: true,
        contentType,
        contentLength: req.headers?.['content-length'] || null,
        modelHint: fullAccount.imageBoundModel || 'multipart:model-field'
      }

      logger.info('🖼️ OpenAI image edit request', {
        accountId: account.id,
        accountName: account.name,
        targetUrl,
        contentLength: req.headers?.['content-length'] || 'unknown'
      })

      const response = await axios({
        method: 'POST',
        url: targetUrl,
        headers,
        data: req,
        timeout: this.defaultTimeout,
        responseType: 'json',
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
        signal: abortController.signal,
        ...this._createProxyConfig(fullAccount)
      })

      if (response.status >= 400) {
        return this._handleErrorResponse({
          req,
          res,
          account,
          response,
          sessionHash,
          operation: 'edits'
        })
      }

      await openaiResponsesAccountService.updateAccount(account.id, {
        lastUsedAt: new Date().toISOString()
      })

      const model = response.data?.model || fullAccount.imageBoundModel || 'gpt-image-2'
      await this._recordImageUsage({
        req,
        account,
        apiKeyData,
        model,
        responseData: response.data,
        statusCode: response.status,
        operation: 'edits'
      })

      return res.status(response.status).json(response.data)
    } catch (error) {
      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }

      logger.error('OpenAI image edit relay error:', {
        message: error.message,
        code: error.code,
        status: error.response?.status
      })

      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        await upstreamErrorHelper
          .markTempUnavailable(account.id, 'openai-responses', 503)
          .catch(() => {})
      }

      if (res.headersSent) {
        return res.end()
      }

      return res.status(error.statusCode || error.response?.status || 500).json({
        error: {
          message: error.message || 'Internal server error',
          type: error.code || 'api_error',
          code: error.code || 'internal_error'
        }
      })
    } finally {
      if (handleClientDisconnect) {
        req.removeListener('aborted', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)
      }
    }
  }
}

module.exports = new OpenAIImageRelayService()
