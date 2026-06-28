const logger = require('../utils/logger')

/**
 * 模型服务
 * 管理系统支持的 AI 模型列表
 * 与 pricingService 独立，专注于"支持哪些模型"而不是"如何计费"
 *
 * 支持两种来源：
 * 1. 页面配置（Redis key: system:models_config）—— 存在则优先使用
 * 2. 默认硬编码列表（getDefaultModels）
 */
class ModelService {
  constructor() {
    this.supportedModels = this.getDefaultModels()
    this.CONFIG_KEY = 'system:models_config'
    this.cachedConfig = null
    this.cacheExpiry = 0
    this.CACHE_TTL = 10 * 1000 // 10 秒缓存，配置更新后基本实时生效
  }

  /**
   * 初始化模型服务
   */
  async initialize() {
    const totalModels = Object.values(this.supportedModels).reduce(
      (sum, config) => sum + config.models.length,
      0
    )
    logger.success(`Model service initialized with ${totalModels} default models`)
  }

  /**
   * 获取默认支持的模型配置（硬编码兜底）
   */
  getDefaultModels() {
    return {
      claude: {
        provider: 'anthropic',
        description: 'Claude models from Anthropic',
        models: [
          'claude-opus-4-5-20251101',
          'claude-haiku-4-5-20251001',
          'claude-sonnet-4-5-20250929',
          'claude-opus-4-1-20250805',
          'claude-sonnet-4-20250514',
          'claude-opus-4-20250514',
          'claude-3-7-sonnet-20250219',
          'claude-3-5-sonnet-20241022',
          'claude-3-5-haiku-20241022',
          'claude-3-opus-20240229',
          'claude-3-haiku-20240307'
        ]
      },
      openai: {
        provider: 'openai',
        description: 'OpenAI GPT models',
        models: [
          'gpt-5.1-2025-11-13',
          'gpt-5.1-codex-mini',
          'gpt-5.1-codex',
          'gpt-5.1-codex-max',
          'gpt-5-2025-08-07',
          'gpt-5-codex',
          'gpt-5.3-codex',
          'gpt-5.3-codex-spark',
          'gpt-5.4',
          'gpt-5.4-pro'
        ]
      },
      gemini: {
        provider: 'google',
        description: 'Google Gemini models',
        models: [
          'gemini-2.5-pro',
          'gemini-3-pro-preview',
          'gemini-3.1-pro-preview',
          'gemini-2.5-flash'
        ]
      }
    }
  }

  /**
   * 从 Redis 读取页面配置的自定义模型列表
   * @returns {Promise<Array<{id, provider}>|null>} 自定义模型数组，未配置返回 null
   */
  async getCustomModels() {
    try {
      // 检查内存缓存
      if (this.cachedConfig !== null && Date.now() < this.cacheExpiry) {
        return this.cachedConfig
      }

      const redis = require('../models/redis')
      const configStr = await redis.client.get(this.CONFIG_KEY)
      if (!configStr) {
        this.cachedConfig = null
        this.cacheExpiry = Date.now() + this.CACHE_TTL
        return null
      }

      const parsed = JSON.parse(configStr)
      // 兼容两种存储格式：
      // 1. { models: [{id, provider}, ...], updatedAt }
      // 2. 旧版 [{id, provider}, ...]
      const models = Array.isArray(parsed) ? parsed : parsed.models
      if (!Array.isArray(models)) {
        this.cachedConfig = null
        this.cacheExpiry = Date.now() + this.CACHE_TTL
        return null
      }

      const normalized = models
        .filter((m) => m && typeof m.id === 'string' && m.id.trim())
        .map((m) => ({
          id: m.id.trim(),
          provider: (m.provider || 'other').trim()
        }))

      this.cachedConfig = normalized
      this.cacheExpiry = Date.now() + this.CACHE_TTL
      return normalized
    } catch (error) {
      logger.error('读取自定义模型配置失败:', error)
      return null
    }
  }

  /**
   * 保存自定义模型配置到 Redis
   * @param {Array<{id, provider}>} models
   * @param {string} updatedBy
   */
  async saveCustomModels(models, updatedBy = 'admin') {
    const redis = require('../models/redis')
    const payload = {
      models: models
        .filter((m) => m && typeof m.id === 'string' && m.id.trim())
        .map((m) => ({ id: m.id.trim(), provider: (m.provider || 'other').trim() })),
      updatedAt: new Date().toISOString(),
      updatedBy
    }
    await redis.client.set(this.CONFIG_KEY, JSON.stringify(payload))
    // 立即刷新缓存
    this.cachedConfig = payload.models
    this.cacheExpiry = Date.now() + this.CACHE_TTL
    logger.info(`✅ 自定义模型配置已保存，共 ${payload.models.length} 个模型`)
  }

  /**
   * 清除自定义模型配置（恢复默认）
   */
  async clearCustomModels() {
    const redis = require('../models/redis')
    await redis.client.del(this.CONFIG_KEY)
    this.cachedConfig = null
    this.cacheExpiry = 0
    logger.info('✅ 自定义模型配置已清除，恢复默认模型列表')
  }

  /**
   * 获取所有支持的模型（OpenAI API 格式）
   * 优先使用页面配置，未配置时使用默认列表
   */
  async getAllModels() {
    // 优先使用页面配置
    const customModels = await this.getCustomModels()
    if (customModels && customModels.length > 0) {
      const now = Math.floor(Date.now() / 1000)
      return customModels
        .map((m) => ({
          id: m.id,
          object: 'model',
          created: now,
          owned_by: m.provider
        }))
        .sort((a, b) => {
          if (a.owned_by !== b.owned_by) {
            return a.owned_by.localeCompare(b.owned_by)
          }
          return a.id.localeCompare(b.id)
        })
    }

    // 回退到默认列表
    return this.getDefaultAllModels()
  }

  /**
   * 获取默认模型列表（同步，硬编码）
   */
  getDefaultAllModels() {
    const models = []
    const now = Math.floor(Date.now() / 1000)

    for (const [_service, config] of Object.entries(this.supportedModels)) {
      for (const modelId of config.models) {
        models.push({
          id: modelId,
          object: 'model',
          created: now,
          owned_by: config.provider
        })
      }
    }

    return models.sort((a, b) => {
      if (a.owned_by !== b.owned_by) {
        return a.owned_by.localeCompare(b.owned_by)
      }
      return a.id.localeCompare(b.id)
    })
  }

  /**
   * 按 provider 获取模型
   * @param {string} provider - 'anthropic', 'openai', 'google' 等
   */
  async getModelsByProvider(provider) {
    return (await this.getAllModels()).filter((m) => m.owned_by === provider)
  }

  /**
   * 检查模型是否被支持
   * @param {string} modelId - 模型 ID
   */
  async isModelSupported(modelId) {
    if (!modelId) {
      return false
    }
    return (await this.getAllModels()).some((m) => m.id === modelId)
  }

  /**
   * 获取模型的 provider
   * @param {string} modelId - 模型 ID
   */
  async getModelProvider(modelId) {
    const model = (await this.getAllModels()).find((m) => m.id === modelId)
    return model ? model.owned_by : null
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    const totalModels = Object.values(this.supportedModels).reduce(
      (sum, config) => sum + config.models.length,
      0
    )

    return {
      initialized: true,
      totalModels,
      providers: Object.keys(this.supportedModels)
    }
  }

  /**
   * 清理资源（保留接口兼容性）
   */
  cleanup() {
    logger.debug('📋 Model service cleanup (no-op)')
  }
}

module.exports = new ModelService()
