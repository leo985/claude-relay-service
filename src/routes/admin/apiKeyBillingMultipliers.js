const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const apiKeyBillingMultiplierService = require('../../services/apiKeyBillingMultiplierService')
const logger = require('../../utils/logger')

const router = express.Router()

const getErrorStatus = (error) => {
  if (error.code === 'API_KEY_NOT_FOUND') return 404
  if (['INVALID_API_KEY_ID', 'INVALID_BILLING_MULTIPLIER'].includes(error.code)) return 400
  return 500
}

router.get('/api-keys/:keyId/billing-multiplier', authenticateAdmin, async (req, res) => {
  try {
    const data = await apiKeyBillingMultiplierService.getConfig(req.params.keyId)
    return res.json({ success: true, data })
  } catch (error) {
    const statusCode = getErrorStatus(error)
    if (statusCode === 500) {
      logger.error('Failed to load API key billing multiplier:', error)
    }
    return res.status(statusCode).json({ success: false, error: error.message })
  }
})

router.put('/api-keys/:keyId/billing-multiplier', authenticateAdmin, async (req, res) => {
  try {
    const data = await apiKeyBillingMultiplierService.setMultiplier(
      req.params.keyId,
      req.body?.multiplier
    )
    logger.info(`Admin updated hidden billing multiplier for API key ${data.keyId}`)
    return res.json({ success: true, data })
  } catch (error) {
    const statusCode = getErrorStatus(error)
    if (statusCode === 500) {
      logger.error('Failed to update API key billing multiplier:', error)
    }
    return res.status(statusCode).json({ success: false, error: error.message })
  }
})

module.exports = router
