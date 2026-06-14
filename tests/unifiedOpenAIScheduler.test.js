jest.mock('../src/services/account/openaiAccountService', () => ({
  setAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))

const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

describe('UnifiedOpenAIScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('markAccountRateLimited', () => {
    it('does not disable scheduling again when OpenAI-Responses auto protection is disabled', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'true'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        2
      )
      expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
    })

    it('keeps disabling scheduling for protected OpenAI-Responses accounts', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'false'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          schedulable: 'false'
        })
      )
    })
  })

  describe('_rankOpenAIResponsesAccount image features', () => {
    it('requires image generation support for Images API requests', () => {
      const result = unifiedOpenAIScheduler._rankOpenAIResponsesAccount(
        {
          providerEndpoint: 'responses',
          supportsImageGeneration: false,
          imageBoundModel: 'gpt-image-2'
        },
        'gpt-image-2',
        {
          endpointKind: 'images',
          hasImageGeneration: true,
          imageModel: 'gpt-image-2',
          openaiResponsesOnly: true
        }
      )

      expect(result).toEqual({
        ok: false,
        reason: 'image_generation_not_supported',
        rank: 0
      })
    })

    it('uses imageBoundModel instead of text boundModel for Images API requests', () => {
      const result = unifiedOpenAIScheduler._rankOpenAIResponsesAccount(
        {
          providerEndpoint: 'responses',
          supportsImageGeneration: true,
          boundModel: 'gpt-5.5',
          imageBoundModel: 'gpt-image-2'
        },
        'gpt-image-2',
        {
          endpointKind: 'images',
          hasImageGeneration: true,
          imageModel: 'gpt-image-2',
          openaiResponsesOnly: true
        }
      )

      expect(result.ok).toBe(true)
      expect(result.rank).toBe(3)
    })
  })
})
