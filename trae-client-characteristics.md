# Trae CN 客户端特征分析报告

> 分析日期: 2026-07-06  
> 分析对象: Trae CN 客户端 (本机 macOS)  
> 目的: 为中转服务器模拟 Trae 客户端提供技术参考

---

## 1. 认证方式

### 1.1 JWT Token 存储

- **存储路径**: `~/.trae-cn/trae-jwt-token`
- **Token 结构**: RS256 签名的 JWT
- **Payload 内容**:
  ```json
  {
    "data": {
      "id": "4434767686937723",
      "tenant_id": "7o2d894p7dr0o4",
      "type": "user",
      "user_id": "4434767686937723"
    },
    "exp": <expiry_timestamp>,
    "iat": <issued_at_timestamp>,
    "iss": "trae"
  }
  ```

### 1.2 Token 传递方式

- 通过 `x-cloudide-token` header 传递
- 或通过 cookie 方式传递

---

## 2. HTTP Headers（必须携带）

| Header | 示例值 | 说明 |
|--------|--------|------|
| `x-app-id` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` | 固定 App ID（UUID 格式） |
| `x-device-id` | `1373729801692056` | 设备 ID（数字格式，需生成或复用） |
| `x-machine-id` | `781f5835360718480f4c2748d250995fc725beec59c12cadff38e4da60774e92` | 机器 ID（SHA256 hash，64 字符） |
| `x-device-brand` | `Mac16,5` | 设备品牌/型号 |
| `x-device-cpu` | `Apple` | CPU 类型 |
| `x-device-type` | `mac` | 设备类型（mac/windows/linux） |
| `x-os-version` | `macOS 15.6.1` | 操作系统版本 |
| `x-ide-version` | `3.3.70` | IDE 版本号 |
| `x-ide-version-type` | `stable` | 版本类型（stable/dev） |
| `x-ide-version-code` | `20260625` | 版本代码（日期格式） |
| `x-app-version-code` | `20260625` | App 版本代码 |
| `x-app-version` | `default` | App 版本 |
| `request-traffic-type` | `prod` | 流量类型 |
| `Content-Type` | `application/json` | 内容类型 |
| `User-Agent` | `TraeClient/TTNet` | **关键 UA 标识** |

---

## 3. API Endpoints

### 3.1 核心 API 域名

| 域名 | 用途 |
|------|------|
| `https://trae-api-cn.mchost.guru` | AI Agent API（主要对话/推理接口） |
| `https://api.trae.cn` | CloudIDE API（用户信息、Token 生成） |
| `https://api.trae.com.cn` | iCube API（配置查询、原生接口） |
| `https://mcs.zijieapi.com` | 监控/埋点上报 |

### 3.2 关键 API 路径

| 路径 | 用途 |
|------|------|
| `/api/ide/v1/batch_get_detail_param` | 获取模型配置参数 |
| `/api/v1/commercial/chat_mode` | 获取对话模式配置 |
| `/api/agent/v3/query_history_state` | 查询历史会话状态 |
| `/api/agent/v3/sync_history_state` | 同步历史会话状态 |
| `/api/ide/v1/privacy/query` | 隐私设置查询 |
| `/cloudide/api/v3/trae/GetUserInfo` | 获取用户信息 |
| `/cloudide/api/v3/trae/GenerateTempToken` | 生成临时 Token |
| `/icube/api/v1/native/config/query` | 动态配置查询 |

---

## 4. URL Query 参数

配置查询请求携带的标准参数：

```
mid=<machine_id>
did=<device_id>
uid=<user_id>
userRegion=CN
packageType=stable_cn
productCode=TRAE
platform=Mac
arch=arm64
tenant=marscode
appVersion=3.3.70
buildVersion=2.3.46696
traeVersionCode=20250325
```

---

## 5. TTNet 网络层配置

Trae 使用字节跳动 TTNet 网络库：

```json
{
  "ttnetConfig": {
    "ttnetBinaryPath": "/Applications/Trae CN.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libsscronet.dylib",
    "ttnetParams": {
      "appId": "787976",
      "deviceId": "1373729801692056",
      "appName": "trae",
      "versionCode": "3003070",
      "isMainProcess": false
    },
    "params": {
      "storagePath": "~/Library/Application Support/Trae CN/ModularData/ttnet",
      "userAgent": "TraeClient/TTNet",
      "enableCaStore": true
    }
  },
  "slardarConfig": {
    "slardarAppID": 787976
  }
}
```

---

## 6. SSE 流式响应格式

### 6.1 事件类型

| 事件 | 说明 |
|------|------|
| `progress_notice` | 进度通知（如 Processing_xxx） |
| `thought` | 思考过程输出 |
| `reasoning` | 推理内容 |

### 6.2 数据格式示例

```
event: progress_notice
data: "Processing_1783331419"
id: 3
retry: null
```

### 6.3 TimingCost 指标

日志中包含详细的性能指标：

```json
{
  "config_name": "glm-5.2",
  "gateway_preprocess_timing": 200,
  "gateway_server_processing_time": 4708,
  "first_sse_event_time": 3045,
  "platform_first_token_timing": 4410,
  "provider_model_name": "glm-5.2"
}
```

---

## 7. 自定义模型配置格式

用户配置自定义 OpenAI Compatible 模型时的格式：

```json
{
  "provider": "custom_openai_compatible",
  "config_name": "custom_openai_compatible//glm-latest",
  "model_name": "custom_openai_compatible//glm-latest",
  "display_model_name": "glm-latest",
  "base_url": "https://xxx/api/v1/chat/completions",
  "multimodal": true,
  "prompt_max_tokens": 184000,
  "max_tokens": 16000,
  "max_turn": 200,
  "use_remote_service": false
}
```

> 注意：使用自定义模型时，Trae 会直接请求用户配置的 `base_url`，而不是通过 Trae 后端转发。

---

## 8. 客户端元信息

### 8.1 应用信息

- **应用名称**: Trae CN
- **应用版本**: 3.3.70
- **VSCode 版本**: 1.107.1
- **构建版本**: 2.3.46696
- **构建时间**: 2026-06-25T15:43:51.918Z
- **Quality**: stable
- **Provider**: Yinli

### 8.2 功能场景（functions）

支持的功能场景列表：
- `ui_builder_v2`, `solo_coder`, `chat_v3`, `solo_builder`, `builder_v3`
- `builder`, `chat`, `inline_chat`, `git_ai`, `custom_agent_generation`
- `utils`, `code_reviewer`, `code_review_summary`, `solo_agent`
- `multimodal`, `system_diagnosis`

---

## 9. 模拟 Trae 客户端建议

### 9.1 最小实现方案

```python
import requests
import uuid
import hashlib

class TraeClientSimulator:
    """模拟 Trae CN 客户端"""
    
    API_BASE = "https://trae-api-cn.mchost.guru"
    CLOUDIDE_BASE = "https://api.trae.cn"
    
    def __init__(self, jwt_token: str):
        self.token = jwt_token
        self.device_id = str(int(uuid.uuid4().int % 10**16))  # 生成设备 ID
        self.machine_id = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
        
    def _build_headers(self, include_token: bool = True) -> dict:
        headers = {
            "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
            "x-device-id": self.device_id,
            "x-machine-id": self.machine_id,
            "x-device-brand": "Mac16,5",
            "x-device-cpu": "Apple",
            "x-device-type": "mac",
            "x-os-version": "macOS 15.6.1",
            "x-ide-version": "3.3.70",
            "x-ide-version-type": "stable",
            "x-ide-version-code": "20260625",
            "x-app-version-code": "20260625",
            "request-traffic-type": "prod",
            "Content-Type": "application/json",
            "User-Agent": "TraeClient/TTNet",
        }
        if include_token:
            headers["x-cloudide-token"] = self.token
        return headers
    
    def get_user_info(self):
        """获取用户信息"""
        url = f"{self.CLOUDIDE_BASE}/cloudide/api/v3/trae/GetUserInfo"
        payload = {"ReqSource": "IDE", "IDEVersion": "3.3.70"}
        return requests.post(url, headers=self._build_headers(), json=payload)
    
    def get_model_config(self, functions: list):
        """获取模型配置"""
        url = f"{self.API_BASE}/api/ide/v1/batch_get_detail_param"
        payload = {
            "functions": functions,
            "agent_type": "",
            "current_config_info": {"config_name": "", "is_custom_model": False},
            "mode_type": "Manual",
            "access_type": "Default"
        }
        return requests.post(url, headers=self._build_headers(), json=payload)
    
    def chat_stream(self, session_id: str, message: str):
        """流式对话（需要进一步抓包确定完整参数）"""
        url = f"{self.API_BASE}/api/agent/v3/chat"
        # 具体请求体参数需要通过抓包获取
        payload = {
            "session_id": session_id,
            "message": message,
            # ... 其他参数待补充
        }
        return requests.post(url, headers=self._build_headers(), json=payload, stream=True)


# 使用示例
if __name__ == "__main__":
    # 从 ~/.trae-cn/trae-jwt-token 读取 token
    token = open("~/.trae-cn/trae-jwt-token").read().strip()
    client = TraeClientSimulator(token)
    
    # 测试用户信息
    resp = client.get_user_info()
    print(resp.json())
```

### 9.2 关键实现要点

1. **认证获取**: 需要通过 Trae 正常登录流程获取有效 JWT Token
2. **标识一致性**: 保持 `device_id` 和 `machine_id` 在同一会话中一致
3. **Headers 完整性**: 必须携带所有 `x-*` headers，否则可能被识别为非法请求
4. **User-Agent**: 使用 `TraeClient/TTNet` 是关键标识
5. **域名选择**: CN 区域使用 `trae-api-cn.mchost.guru`

### 9.3 风险提示

- 模拟客户端可能违反 Trae 服务条款
- Token 有效期有限（通常 7 天），需要定期刷新
- 服务端可能有 IP/设备指纹验证机制

---

## 10. 附录：日志文件路径

| 文件 | 路径 |
|------|------|
| JWT Token | `~/.trae-cn/trae-jwt-token` |
| 主进程日志 | `~/Library/Application Support/Trae CN/logs/<session>/main.log` |
| AI Agent 日志 | `~/Library/Application Support/Trae CN/logs/<session>/Modular/ai-agent_*.log` |
| 动态配置日志 | `~/Library/Application Support/Trae CN/logs/<session>/dynamicConfig.log` |
| AI Code Client | `~/Library/Application Support/Trae CN/logs/<session>/window*/exthost/trae.ai-code-completion/*.log` |
| 用户设置 | `~/Library/Application Support/Trae CN/User/settings.json` |
| Skill 配置 | `~/.trae-cn/skill-config.json` |

---

*报告生成完成*
