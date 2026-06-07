<template>
  <div class="tutorial-content">
    <!-- 第一步：安装 Node.js -->
    <NodeInstallTutorial :platform="platform" :step-number="1" tool-name="WorkBuddy (Droid)" />

    <!-- 第二步：在 CRS 中添加 Droid 账户 -->
    <div class="mb-4 sm:mb-10 sm:mb-6">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-green-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >2</span
        >
        添加 Droid 账户
      </h4>
      <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
        在 CRS 管理后台添加 Factory / Droid 账户，支持 OAuth 和 API Key 两种认证方式。
      </p>

      <div
        class="rounded-xl border border-green-100 bg-gradient-to-r from-green-50 to-emerald-50 p-4 dark:border-green-500/40 dark:from-green-950/30 dark:to-emerald-950/30 sm:p-6"
      >
        <h5
          class="mb-2 flex items-center text-base font-semibold text-gray-800 dark:text-gray-200 sm:mb-3 sm:text-lg"
        >
          <i class="fas fa-user-plus mr-2 text-green-600" />
          添加账户步骤
        </h5>

        <ol
          class="ml-2 list-inside list-decimal space-y-2 text-sm text-gray-700 dark:text-gray-300 sm:ml-4 sm:space-y-3 sm:text-base"
        >
          <li>登录 CRS 管理后台（当前页面）</li>
          <li>点击左侧菜单中的 <strong>「Droid 账户」</strong></li>
          <li>点击 <strong>「添加账户」</strong> 按钮</li>
          <li>选择认证方式并完成配置：</li>
        </ol>

        <div class="mt-4 space-y-3">
          <!-- OAuth 方式 -->
          <div
            class="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-500/40 dark:bg-blue-950/30 sm:p-4"
          >
            <h6 class="mb-2 text-sm font-medium text-blue-800 dark:text-blue-300 sm:text-base">
              <i class="fas fa-lock mr-1" /> 方式一：OAuth 授权（推荐）
            </h6>
            <ul class="space-y-1 text-xs text-blue-700 dark:text-blue-300 sm:text-sm">
              <li>• 点击「生成授权链接」按钮</li>
              <li>在弹出的页面中登录 Factory / Droid 账户</li>
              <li>确认授权访问权限</li>
              <li>回到本页面点击「完成授权」获取凭证</li>
            </ul>
          </div>

          <!-- API Key 方式 -->
          <div
            class="rounded-lg border border-orange-200 bg-orange-50 p-3 dark:border-orange-500/40 dark:bg-orange-950/30 sm:p-4"
          >
            <h6 class="mb-2 text-sm font-medium text-orange-800 dark:text-orange-300 sm:text-base">
              <i class="fas fa-key mr-1" /> 方式二：API Key
            </h6>
            <ul class="space-y-1 text-xs text-orange-700 dark:text-orange-300 sm:text-sm">
              <li>• 直接输入一个或多个 Factory.ai API Key</li>
              <li>• 支持多 Key 自动轮换，提高可用性</li>
              <li>• 可选配置代理地址</li>
            </ul>
          </div>
        </div>

        <div
          class="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-500/40 dark:bg-yellow-950/30 sm:p-4"
        >
          <h6 class="mb-2 text-sm font-medium text-yellow-800 dark:text-yellow-300 sm:text-base">
            <i class="fas fa-lightbulb mr-1" /> 提示
          </h6>
          <ul class="space-y-1 text-xs text-yellow-700 dark:text-yellow-300 sm:text-sm">
            <li>• 如果你的网络环境无法直接访问 Factory.ai，请配置代理</li>
            <li>• OAuth 方式的 Token 会自动刷新（每 6 小时），无需手动维护</li>
            <li>• 建议至少添加 2 个账户以实现故障自动切换</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 第三步：创建带 Droid 权限的 API Key -->
    <div class="mb-4 sm:mb-10 sm:mb-6">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-purple-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >3</span
        >
        创建 API Key
      </h4>
      <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
        创建 API Key 并启用 Droid 权限，用于客户端连接认证。
      </p>

      <div
        class="rounded-xl border border-purple-100 bg-gradient-to-r from-purple-50 to-pink-50 p-4 dark:border-purple-500/40 dark:from-purple-950/30 dark:to-pink-950/30 sm:p-6"
      >
        <h5
          class="mb-2 flex items-center text-base font-semibold text-gray-800 dark:text-gray-200 sm:mb-3 sm:text-lg"
        >
          <i class="fas fa-key mr-2 text-purple-600" />
          创建步骤
        </h5>

        <ol
          class="ml-2 list-inside list-decimal space-y-2 text-sm text-gray-700 dark:text-gray-300 sm:ml-4 sm:space-y-3 sm:text-base"
        >
          <li>点击左侧菜单中的 <strong>「API Keys」</strong></li>
          <li>点击 <strong>「新建 Key」</strong> 按钮</li>
          <li>填写名称（如 "我的 WorkBuddy Key"）</li>
          <li><strong>关键：在权限部分勾选「Droid」权限</strong></li>
          <li>
            点击保存，复制生成的
            <code class="rounded bg-purple-100 px-1 dark:bg-purple-900">cr_</code> 开头的密钥
          </li>
        </ol>

        <div
          class="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-500/40 dark:bg-red-950/30 sm:p-4"
        >
          <h6 class="mb-2 text-sm font-medium text-red-800 dark:text-red-300 sm:text-base">
            <i class="fas fa-exclamation-triangle mr-1" /> 重要提醒
          </h6>
          <p class="text-sm text-red-700 dark:text-red-300">
            如果创建 API Key 时未勾选 <strong>Droid 权限</strong>，使用 WorkBuddy 连接时会收到
            <code class="rounded bg-red-100 px-1 dark:bg-red-900">403 permission_denied</code>
            错误。请在 API Keys 列表中编辑已有 Key 补充权限。
          </p>
        </div>
      </div>
    </div>

    <!-- 第四步：配置 WorkBuddy -->
    <div class="mb-4 sm:mb-10 sm:mb-6">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >4</span
        >
        配置 WorkBuddy
      </h4>
      <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
        配置 WorkBuddy 的自定义模型文件，将请求指向 CRS 中转服务。
      </p>

      <div
        class="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-blue-50 p-4 dark:border-indigo-500/40 dark:from-indigo-950/30 dark:to-blue-950/30 sm:p-6"
      >
        <h5
          class="mb-2 flex items-center text-base font-semibold text-gray-800 dark:text-gray-200 sm:mb-3 sm:text-lg"
        >
          <i class="fas fa-cog mr-2 text-indigo-600" />
          编辑配置文件
        </h5>
        <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
          WorkBuddy 使用
          <code class="rounded bg-gray-100 px-1 dark:bg-gray-800">{{ configPath }}</code>
          保存自定义模型配置：
        </p>

        <div
          class="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs text-green-400 sm:p-4 sm:text-sm"
        >
          <div
            v-for="(line, index) in configLines"
            :key="line + index"
            class="whitespace-pre text-gray-300"
          >
            {{ line }}
          </div>
        </div>

        <p class="mt-3 text-sm text-indigo-700 dark:text-indigo-300">
          💡 请将
          <code class="rounded bg-indigo-100 px-1 dark:bg-indigo-900">"你的API密钥"</code>
          替换为上一步创建的实际 API Key（<code
            class="rounded bg-indigo-100 px-1 dark:bg-indigo-900"
            >cr_</code
          >
          开头）。
        </p>

        <!-- 一键写入命令 -->
        <div
          class="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-500/40 dark:bg-indigo-950/30 sm:p-4"
        >
          <h6 class="mb-2 text-sm font-medium text-indigo-800 dark:text-indigo-300 sm:text-base">
            一键写入命令
          </h6>
          <p class="mb-2 text-xs text-indigo-600 dark:text-indigo-400">
            复制以下命令到终端执行即可自动写入配置：
          </p>
          <div
            class="overflow-x-auto rounded bg-gray-900 p-2 font-mono text-xs text-green-400 sm:p-3 sm:text-sm"
          >
            <div class="whitespace-pre-wrap break-all text-gray-300">{{ configWriteCmd }}</div>
          </div>
        </div>
      </div>

      <!-- 支持的端点说明 -->
      <div
        class="mt-4 rounded-lg border border-cyan-200 bg-cyan-50 p-3 dark:border-cyan-500/40 dark:bg-cyan-950/30 sm:p-4"
      >
        <h6 class="mb-2 text-sm font-medium text-cyan-800 dark:text-cyan-300 sm:text-base">
          <i class="fas fa-network-wired mr-1" /> 支持的端点
        </h6>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs text-cyan-700 dark:text-cyan-300 sm:text-sm">
            <thead>
              <tr class="border-b border-cyan-200 dark:border-cyan-700">
                <th class="pb-2 pr-4 font-semibold">端点类型</th>
                <th class="pb-2 pr-4 font-semibold">路径</th>
                <th class="pb-2 pr-4 font-semibold">协议</th>
                <th class="pb-2 font-semibold">适用模型</th>
              </tr>
            </thead>
            <tbody>
              <tr class="border-b border-cyan-100 dark:border-cyan-800">
                <td class="py-2 pr-4">Claude (Anthropic)</td>
                <td class="py-2 pr-4"><code class="text-xs">/droid/claude/v1/messages</code></td>
                <td class="py-2 pr-4">Anthropic Messages</td>
                <td class="py-2">Claude Opus/Sonnet</td>
              </tr>
              <tr class="border-b border-cyan-100 dark:border-cyan-800">
                <td class="py-2 pr-4">OpenAI Responses</td>
                <td class="py-2 pr-4"><code class="text-xs">/droid/openai/v1/responses</code></td>
                <td class="py-2 pr-4">OpenAI Responses</td>
                <td class="py-2">GPT-5 等</td>
              </tr>
              <tr>
                <td class="py-2 pr-4">Chat Completions</td>
                <td class="py-2 pr-4">
                  <code class="text-xs">/droid/comm/v1/chat/completions</code>
                </td>
                <td class="py-2 pr-4">OpenAI Chat</td>
                <td class="py-2">通用兼容模型</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 模型映射说明 -->
      <div
        class="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-3 dark:border-violet-500/40 dark:bg-violet-950/30 sm:p-4"
      >
        <h6 class="mb-2 text-sm font-medium text-violet-800 dark:text-violet-300 sm:text-base">
          <i class="fas fa-exchange-alt mr-1" /> 自动模型映射
        </h6>
        <p class="mb-2 text-sm text-violet-700 dark:text-violet-300">
          服务会自动将以下模型名映射为完整版本号，无需手动指定：
        </p>
        <ul class="list-inside space-y-1 text-xs text-violet-600 dark:text-violet-400 sm:text-sm">
          <li>
            • <code class="rounded bg-violet-100 px-1 dark:bg-violet-900">claude-haiku-*</code> →
            <code class="rounded bg-violet-100 px-1 dark:bg-violet-900"
              >claude-sonnet-4-20250514</code
            >
            （Anthropic 端点）
          </li>
          <li>
            • <code class="rounded bg-violet-100 px-1 dark:bg-violet-900">gpt-5</code> →
            <code class="rounded bg-violet-100 px-1 dark:bg-violet-900">gpt-5-2025-08-07</code>
            （OpenAI 端点）
          </li>
        </ul>
      </div>
    </div>

    <!-- 第五步：开始使用 -->
    <div class="mb-6 sm:mb-8">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >5</span
        >
        开始使用 WorkBuddy
      </h4>
      <div
        class="rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-yellow-50 p-4 dark:border-orange-500/40 dark:from-orange-950/30 dark:to-yellow-950/30 sm:p-6"
      >
        <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
          完成以上配置后，启动 WorkBuddy 即可开始使用：
        </p>

        <div class="space-y-4">
          <div>
            <h6 class="mb-2 text-sm font-medium text-gray-800 dark:text-gray-300 sm:text-base">
              启动 WorkBuddy
            </h6>
            <div
              class="overflow-x-auto rounded bg-gray-900 p-2 font-mono text-xs text-green-400 sm:p-3 sm:text-sm"
            >
              <div class="whitespace-nowrap text-gray-300">droid</div>
            </div>
          </div>

          <div>
            <h6 class="mb-2 text-sm font-medium text-gray-800 dark:text-gray-300 sm:text-base">
              在特定项目中使用
            </h6>
            <div
              class="overflow-x-auto rounded bg-gray-900 p-2 font-mono text-xs text-green-400 sm:p-3 sm:text-sm"
            >
              <div class="mb-2"># 进入你的项目目录</div>
              <div class="whitespace-nowrap text-gray-300">
                cd
                {{
                  platform === 'windows' ? 'C:\\path\\to\\your\\project' : '/path/to/your/project'
                }}
              </div>
              <div class="mb-2 mt-2"># 启动 WorkBuddy</div>
              <div class="whitespace-nowrap text-gray-300">droid</div>
            </div>
          </div>
        </div>

        <div
          class="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-500/40 dark:bg-blue-950/30 sm:p-4"
        >
          <h6 class="mb-2 text-sm font-medium text-blue-800 dark:text-blue-300 sm:text-base">
            <i class="fas fa-info-circle mr-1" /> 使用提示
          </h6>
          <ul class="space-y-1 text-xs text-blue-700 dark:text-blue-300 sm:text-sm">
            <li>• 首次启动后，在 WorkBuddy 中选择「自定义模型」即可看到配置的模型列表</li>
            <li>• 请求会通过 CRS 自动调度到可用的 Droid 账户</li>
            <li>• 如果某个账户出现异常，系统会自动切换到其他可用账户</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 故障排除 -->
    <div class="mb-8">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <i class="fas fa-wrench mr-2 text-red-600 sm:mr-3" />
        常见问题解决
      </h4>
      <div class="space-y-4">
        <details
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            收到 403 permission_denied 错误
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <p class="mb-2 text-sm">这表示 API Key 缺少 Droid 权限。解决方法：</p>
            <ol class="list-inside list-decimal space-y-1 text-sm">
              <li>进入 CRS 管理后台 → API Keys 页面</li>
              <li>找到你使用的 API Key，点击编辑</li>
              <li>在权限部分勾选 <strong>Droid</strong></li>
              <li>保存后重新尝试连接</li>
            </ol>
          </div>
        </details>

        <details
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            自定义模型不显示或无法选择
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <p class="mb-2 text-sm">检查以下几点：</p>
            <ul class="list-inside list-disc space-y-1 text-sm">
              <li>
                确认配置文件路径正确：<code class="rounded bg-gray-200 px-1 dark:bg-gray-700">{{
                  configPath
                }}</code>
              </li>
              <li>确认 JSON 格式正确（注意末尾逗号、引号等）</li>
              <li>确认 base_url 可以从本地访问（检查防火墙/网络）</li>
              <li>重启 WorkBuddy 使配置生效</li>
            </ul>
          </div>
        </details>

        <details
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            请求超时或连接失败
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <p class="mb-2 text-sm">可能的原因和解决方案：</p>
            <ul class="list-inside list-disc space-y-1 text-sm">
              <li><strong>网络问题</strong>：确保可以访问 CRS 服务地址</li>
              <li><strong>代理设置</strong>：如果需要代理访问外网，在 Droid 账户配置中设置代理</li>
              <li><strong>账户状态</strong>：检查管理后台中 Droid 账户是否处于活跃状态</li>
              <li>
                <strong>Token 过期</strong>：OAuth 账户的 Token 会自动刷新，如遇问题可手动重新授权
              </li>
            </ul>
          </div>
        </details>

        <details
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            如何验证配置是否正确？
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <p class="mb-2 text-sm">可以使用 curl 测试连接：</p>
            <div
              class="overflow-x-auto rounded bg-gray-900 p-2 font-mono text-xs text-green-400 sm:p-3 sm:text-sm"
            >
              <div class="whitespace-nowrap text-gray-300">
                curl -X POST "{{ droidClaudeBaseUrl }}/v1/messages" \
              </div>
              <div class="whitespace-nowrap text-gray-300">
                -H "Content-Type: application/json" \
              </div>
              <div class="whitespace-nowrap text-gray-300">
                -H "Authorization: Bearer 你的API密钥" \
              </div>
              <div class="whitespace-nowrap text-gray-300">
                -d
                '{"model":"claude-sonnet-4-5-20250929","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
              </div>
            </div>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              将 "你的API密钥" 替换为实际的 cr_ 开头密钥。如果返回正常的 JSON 响应说明配置成功。
            </p>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useTutorialUrls } from '@/utils/useTutorialUrls'
import NodeInstallTutorial from './NodeInstallTutorial.vue'

const props = defineProps({
  platform: {
    type: String,
    required: true,
    validator: (value) => ['windows', 'macos', 'linux'].includes(value)
  }
})

const { droidClaudeBaseUrl, droidOpenaiBaseUrl } = useTutorialUrls()

const configPath = computed(() =>
  props.platform === 'windows'
    ? 'C:\\Users\\你的用户名\\.factory\\config.json'
    : '~/.factory/config.json'
)

const configLines = computed(() => [
  '{',
  '  "custom_models": [',
  '    {',
  '      "model_display_name": "Sonnet 4.5 [CRS]",',
  '      "model": "claude-sonnet-4-5-20250929",',
  `      "base_url": "${droidClaudeBaseUrl.value}",`,
  '      "api_key": "你的API密钥",',
  '      "provider": "anthropic",',
  '      "max_tokens": 8192',
  '    },',
  '    {',
  '      "model_display_name": "GPT-5 Codex [CRS]",',
  '      "model": "gpt-5-codex",',
  `      "base_url": "${droidOpenaiBaseUrl.value}",`,
  '      "api_key": "你的API密钥",',
  '      "provider": "openai",',
  '      "max_tokens": 16384',
  '    }',
  '  ]',
  '}'
])

const configWriteCmd = computed(() => {
  const content = JSON.stringify(
    {
      custom_models: [
        {
          model_display_name: 'Sonnet 4.5 [CRS]',
          model: 'claude-sonnet-4-5-20250929',
          base_url: droidClaudeBaseUrl.value,
          api_key: '你的API密钥',
          provider: 'anthropic',
          max_tokens: 8192
        },
        {
          model_display_name: 'GPT-5 Codex [CRS]',
          model: 'gpt-5-codex',
          base_url: droidOpenaiBaseUrl.value,
          api_key: '你的API密钥',
          provider: 'openai',
          max_tokens: 16384
        }
      ]
    },
    null,
    2
  )

  if (props.platform === 'windows') {
    return `New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.factory" | Out-Null; '${content}' | Set-Content -Path "$env:USERPROFILE\\.factory\\config.json" -Force`
  }

  const escaped = content.replace(/'/g, "'\\''")
  return `mkdir -p ~/.factory && echo '${escaped}' > ~/.factory/config.json`
})
</script>
