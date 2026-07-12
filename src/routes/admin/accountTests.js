const express = require('express')

const { authenticateAdmin } = require('../../middleware/auth')
const accountAgentTestService = require('../../services/accountAgentTestService')
const logger = require('../../utils/logger')

const router = express.Router()

router.get('/account-tests/agents', authenticateAdmin, (req, res) =>
  res.json({
    success: true,
    data: accountAgentTestService.getAgentProfiles()
  })
)

router.get('/account-tests/results', authenticateAdmin, async (req, res) => {
  try {
    return res.json({
      success: true,
      data: await accountAgentTestService.getLatestResults()
    })
  } catch (error) {
    logger.error('Failed to load latest account test results', { message: error.message })
    return res.status(500).json({
      success: false,
      error: 'Failed to load latest account test results',
      message: error.message
    })
  }
})

router.get('/account-tests/batch/latest', authenticateAdmin, async (req, res) => {
  try {
    return res.json({
      success: true,
      data: await accountAgentTestService.getLatestBatchResult()
    })
  } catch (error) {
    logger.error('Failed to load latest batch account test result', { message: error.message })
    return res.status(500).json({
      success: false,
      error: 'Failed to load latest batch account test result',
      message: error.message
    })
  }
})

router.get('/account-tests/batch/jobs/:jobId', authenticateAdmin, (req, res) => {
  try {
    return res.json({
      success: true,
      data: accountAgentTestService.getBatchTestJob(req.params.jobId)
    })
  } catch (error) {
    const statusCode = error.statusCode || 500
    return res.status(statusCode).json({
      success: false,
      error: 'Failed to load batch account test progress',
      message: error.message
    })
  }
})

router.get(
  '/account-tests/:platform/:accountId/capabilities',
  authenticateAdmin,
  async (req, res) => {
    try {
      const data = await accountAgentTestService.getCapabilities(
        req.params.platform,
        req.params.accountId
      )
      return res.json({ success: true, data })
    } catch (error) {
      const statusCode = error.statusCode || 500
      logger.warn('Failed to load account test capabilities', {
        platform: req.params.platform,
        accountId: req.params.accountId,
        message: error.message
      })
      return res.status(statusCode).json({
        success: false,
        error: 'Failed to load account test capabilities',
        message: error.message
      })
    }
  }
)

router.post('/account-tests/batch/jobs', authenticateAdmin, (req, res) => {
  try {
    const job = accountAgentTestService.startBatchTestJob({
      accounts: req.body?.accounts,
      agents: req.body?.agents,
      prompt: req.body?.prompt,
      maxTokens: req.body?.maxTokens,
      concurrency: req.body?.concurrency,
      includeInactive: req.body?.includeInactive
    })

    return res.status(job.reused ? 200 : 202).json({
      success: true,
      data: job,
      message: job.reused ? 'A batch account test is already running' : 'Batch account test started'
    })
  } catch (error) {
    const statusCode = error.statusCode || 500
    logger.error('Failed to start batch account test job', { message: error.message })
    return res.status(statusCode).json({
      success: false,
      error: 'Failed to start batch account test',
      message: error.message
    })
  }
})

router.post('/account-tests/batch', authenticateAdmin, async (req, res) => {
  try {
    const result = await accountAgentTestService.testAccountsBatch({
      accounts: req.body?.accounts,
      agents: req.body?.agents,
      prompt: req.body?.prompt,
      maxTokens: req.body?.maxTokens,
      concurrency: req.body?.concurrency,
      includeInactive: req.body?.includeInactive
    })

    return res.json({
      success: true,
      data: result,
      message: `Batch account test completed: ${result.successCount}/${result.testCount} passed`
    })
  } catch (error) {
    const statusCode = error.statusCode || 500
    logger.error('Batch account agent test request failed', {
      message: error.message
    })
    return res.status(statusCode).json({
      success: false,
      error: 'Batch account test failed',
      message: error.message
    })
  }
})

router.post('/account-tests/:platform/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const result = await accountAgentTestService.testAccount({
      platform: req.params.platform,
      accountId: req.params.accountId,
      agent: req.body?.agent,
      model: req.body?.model,
      prompt: req.body?.prompt,
      maxTokens: req.body?.maxTokens
    })

    // The admin operation succeeded even when the upstream test did not. Keep the
    // upstream status in data so the UI can show 429 details and refresh account state.
    return res.json({
      success: result.success,
      data: result,
      message: result.success ? 'Account test passed' : result.error
    })
  } catch (error) {
    const statusCode = error.statusCode || 500
    logger.error('Account agent test request failed', {
      platform: req.params.platform,
      accountId: req.params.accountId,
      message: error.message
    })
    return res.status(statusCode).json({
      success: false,
      error: 'Account test failed',
      message: error.message
    })
  }
})

module.exports = router
