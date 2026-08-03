const redis = require('../models/redis')
const LRUCache = require('../utils/lruCache')

const DEFAULT_MULTIPLIER = 1
const MIN_MULTIPLIER = 0.01
const MAX_MULTIPLIER = 100
const CACHE_TTL_MS = 60 * 1000

class ApiKeyBillingMultiplierService {
  constructor(options = {}) {
    this.redis = options.redis || redis
    this.cache = options.cache || new LRUCache(2000)
  }

  async getMultiplier(keyId) {
    const normalizedKeyId = this._normalizeKeyId(keyId, false)
    if (!normalizedKeyId) {
      return DEFAULT_MULTIPLIER
    }

    const storageKey = this._getStorageKey(normalizedKeyId)
    const cached = this.cache.get(storageKey)
    if (cached !== undefined) {
      return cached
    }

    const client = this.redis.getClientSafe()
    const value = this._parseStoredMultiplier(await client.get(storageKey))
    this.cache.set(storageKey, value, CACHE_TTL_MS)
    return value
  }

  async getConfig(keyId) {
    const normalizedKeyId = await this._validateApiKey(keyId)
    const multiplier = await this.getMultiplier(normalizedKeyId)
    return {
      keyId: normalizedKeyId,
      multiplier,
      isCustom: multiplier !== DEFAULT_MULTIPLIER
    }
  }

  async setMultiplier(keyId, multiplier) {
    const normalizedKeyId = await this._validateApiKey(keyId)
    const normalizedMultiplier = this._normalizeMultiplier(multiplier)
    const storageKey = this._getStorageKey(normalizedKeyId)
    const client = this.redis.getClientSafe()

    if (normalizedMultiplier === DEFAULT_MULTIPLIER) {
      await client.del(storageKey)
    } else {
      await client.set(storageKey, String(normalizedMultiplier))
    }
    this.cache.set(storageKey, normalizedMultiplier, CACHE_TTL_MS)

    return {
      keyId: normalizedKeyId,
      multiplier: normalizedMultiplier,
      isCustom: normalizedMultiplier !== DEFAULT_MULTIPLIER,
      updatedAt: new Date().toISOString()
    }
  }

  _normalizeMultiplier(value) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < MIN_MULTIPLIER || parsed > MAX_MULTIPLIER) {
      const error = new Error(
        `Billing multiplier must be between ${MIN_MULTIPLIER} and ${MAX_MULTIPLIER}`
      )
      error.code = 'INVALID_BILLING_MULTIPLIER'
      throw error
    }
    return Math.round(parsed * 1000000) / 1000000
  }

  _parseStoredMultiplier(value) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < MIN_MULTIPLIER || parsed > MAX_MULTIPLIER) {
      return DEFAULT_MULTIPLIER
    }
    return parsed
  }

  _normalizeKeyId(keyId, throwOnError = true) {
    const normalizedKeyId = String(keyId || '').trim()
    if (!normalizedKeyId || normalizedKeyId.length > 200 || /[\r\n\0]/.test(normalizedKeyId)) {
      if (!throwOnError) {
        return null
      }
      const error = new Error('Invalid API key ID')
      error.code = 'INVALID_API_KEY_ID'
      throw error
    }
    return normalizedKeyId
  }

  async _validateApiKey(keyId) {
    const normalizedKeyId = this._normalizeKeyId(keyId)
    const client = this.redis.getClientSafe()
    if (!(await client.exists(`apikey:${normalizedKeyId}`))) {
      const error = new Error('API key not found')
      error.code = 'API_KEY_NOT_FOUND'
      throw error
    }
    return normalizedKeyId
  }

  _getStorageKey(keyId) {
    return `api_key_billing_multiplier:${keyId}`
  }
}

module.exports = new ApiKeyBillingMultiplierService()
module.exports.ApiKeyBillingMultiplierService = ApiKeyBillingMultiplierService
module.exports.DEFAULT_MULTIPLIER = DEFAULT_MULTIPLIER
module.exports.MIN_MULTIPLIER = MIN_MULTIPLIER
module.exports.MAX_MULTIPLIER = MAX_MULTIPLIER
