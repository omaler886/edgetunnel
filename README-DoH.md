# DoH 转发代理 (Cloudflare Workers)

基于 Cloudflare Workers 的 **DNS over HTTPS (DoH) 转发代理**，聚合 4 大公共 DoH 上游，支持 ECS 就近解析、ECH 配置注入、智能负载均衡、响应缓存，以及带鉴权的图形化管理面板。

> 与仓库根目录的 `edgetunnel 2.1`（VLESS/Trojan 代理）是**两个独立 Worker**，可分别部署。

---

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🌐 **多上游转发** | Cloudflare 1.1.1.1 / Google 8.8.8.8 / OpenDNS / Quad9 9.9.9.9 |
| 📍 **ECS 注入** | 自动根据客户端真实 IP (`CF-Connecting-IP`) 注入 EDNS Client Subnet，上游返回就近 CDN 结果 |
| 🔐 **ECH 支持** | 为 HTTPS (type 65) 查询合成包含 ECHConfigList 的 SVCB 记录 |
| ⚖️ **智能负载均衡** | 轮询 + 加权（`WEIGHTS` 环境变量）+ 自动故障转移（连续失败 3 次标记不健康，60s 自动恢复） |
| 🚀 **响应缓存** | Cloudflare Cache API，TTL 跟随上游响应最小 TTL，命中不重复回源 |
| 🔄 **故障转移** | 某上游失败自动切换下一个 |
| 📋 **JSON DoH API** | 兼容 Google / Cloudflare 的 `application/dns-json` 格式 |
| 📊 **图形面板** | 鉴权保护的分区视角 + 上游视角 + 分区域名 Top 榜 + 实时速率/QPS |
| 🏷️ **边缘节点分区** | 按 `LAX/HKG/NRT/SJC...` 边缘节点聚合最近解析记录 |

---

## 🚀 快速部署

### 方式一：Wrangler CLI（推荐）

```bash
# 1. 克隆项目
git clone <your-repo-url>
cd <dir>

# 2. 部署
npx wrangler deploy -c wrangler-doh.toml
```

### 方式二：Cloudflare Dashboard

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → **创建 Worker**
2. 代码编辑器里粘贴 `doh.js` 内容
3. 保存后进入 **设置 → 变量**，按需配置环境变量
4. （推荐）绑定自定义域名，避免 `*.workers.dev` 在大陆被墙

---

## ⚙️ 环境变量（Dashboard → Settings → Variables）

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `DASH_TOKEN` | 推荐 | — | 面板 /`/info`/`/monitor` 的访问令牌（必填则面板加密，DoH 解析本身不开） |
| `UPSTREAMS` | 否 | 全部 | 指定上游，逗号分隔：`cloudflare,google,opendns,quad9` |
| `WEIGHTS` | 否 | 等权 | 上游权重，如 `cloudflare:5,google:3,opendns:1,quad9:1`；未配置的上游不参与 |
| `ECS` | 否 | `true` | 是否启用 ECS 注入（`false` 关闭） |
| `ECS_V4` | 否 | `24` | IPv4 子网前缀长度 |
| `ECS_V6` | 否 | `56` | IPv6 子网前缀长度 |
| `ECH_CONFIG` | 否 | — | ECH 配置（base64 编码的 ECHConfigList） |
| `ECH_DOMAINS` | 否 | 全部 | 需注入 ECH 的域名，逗号分隔 |
| `ECH_TTL` | 否 | `300` | 合成 ECH 记录 TTL 秒 |
| `CACHE_TTL` | 否 | `60` | 默认缓存秒数上限 |
| `RECENT_LIMIT` | 否 | `2000` | 最近解析记录条数上限（100~10000） |
| `TOKEN` | 否 | — | 旧版：DoH 请求 Token（用 `DASH_TOKEN` 后可不配） |

> ⚠️ `WEIGHTS`、`ECS`、`UPSTREAMS` 等变更即时生效，无需重新部署；`DASH_TOKEN` 需重部署（通过 Dashboard 变量或 `wrangler secret`）。

---

## 📡 端点

| 端点 | 用途 |
|------|------|
| `GET /dns-query?dns=<base64url>` | DoH wire format (RFC 8484)，**浏览器标准路径**（Chrome/Edge/Firefox 强制要求） |
| `POST /dns-query` | DoH wire format (RFC 8484) |
| `GET/POST /sync?dns=` | 隐藏别名路径（与 `/dns-query` 同功能，供 Clash/sing-box 等使用） |
| `GET /fetch?name=&type=` | JSON DoH API（`application/dns-json`） |
| `GET /` | **图形面板**（需 `DASH_TOKEN`） |
| `GET /info` | 统计 JSON（需 `DASH_TOKEN`） |
| `GET /monitor` | 上游健康 JSON（需 `DASH_TOKEN`） |
| `GET /key` | ECH 配置文本 |

**面板鉴权方式**（任一）：
```
URL 参数:  /?token=<DASH_TOKEN>
HTTP Header: Authorization: Bearer <DASH_TOKEN>
Cookie:      dash_token=<DASH_TOKEN>   （面板登录后自动写入）
```

---

## 🖥️ 图形面板

打开 `https://<your-domain>/?token=<DASH_TOKEN>`：

- **顶部状态卡**：总请求 / 全局 QPS（Analytics Engine）/ QPS(1min/5min) / 缓存命中率 / ECS / ECH / 运行时长
- **分区 Tab**：`[HKG 106] [LAX 62] [SJC 4]...` → 点击查看该边缘节点解析的**域名列表**（调用次数 + 类型分布 + 频率条 + 最后时间 + 搜索过滤）
- **分区 Top 榜**：每个边缘节点 Top 10 域名
- **最近解析**：每条带 `HKG/LAX/SJC` 标签 + 域名 + 类型 + 时间 + 一键复制
- **Upstreams 表**：上游、状态、调用次数、错误、平均延迟、1min 调用占比、成功率、权重配置

> 数据来源说明：
> - **最近解析 / 分区**：持久化到 KV（全局共享，最多 `RECENT_LIMIT` 条）
> - **速率 / QPS(1min/5min)**：单边缘节点内存环形缓冲（跨节点不共享）
> - **全局 QPS**：`Analytics Engine`（`doh_qps` dataset），需先在 [Dashboard 启用 Analytics Engine](https://dash.cloudflare.com/<account-id>/workers/analytics-engine)

---

## 💻 客户端配置

### Chrome / Edge / Firefox（必须用 `/dns-query`）
```
https://<your-domain>/dns-query
```

### Clash / Mihomo（可用隐藏路径）
```yaml
dns:
  enable: true
  nameserver:
    - https://<your-domain>/sync
```

### sing-box
```json
{
  "dns": {
    "servers": [
      { "tag": "doh", "address": "https://<your-domain>/dns-query", "detour": "direct" }
    ]
  }
}
```

### Windows 11
设置 → 网络 → DNS → 手动 → HTTPS 模板填：
```
https://<your-domain>/dns-query
```

---

## 🔧 工作原理

### ECS 注入（RFC 7871）
1. 从 `CF-Connecting-IP` 获取客户端真实 IP
2. 生成 EDNS Client Subnet option（IPv4 /24、IPv6 /56，可用 `ECS_V4/V6` 调）
3. 注入到 DNS 查询的 OPT 记录（无 OPT 则新建一个）
4. 上游根据 ECS 返回就近解析结果

### ECH（Encrypted Client Hello）
1. 客户端发起 HTTPS (type 65) DNS 查询
2. 若域名匹配 `ECH_DOMAINS`，Worker 合成含 ECHConfigList 的 SVCB 记录响应
3. 客户端用该配置在 TLS 握手时加密 ClientHello

### 缓存
- 缓存键 = `域名 + 类型 + class + 客户端子网`（不同 ECS 不同缓存，保证就近结果正确）
- TTL 取上游响应最小 TTL，封顶 `CACHE_TTL`
- 缓存版本 `v2`，显式保留 `Content-Type: application/dns-message`（关键，否则浏览器拒绝）

---

## 🔬 实测表现

| 机器 | 线路 | 单线程 QPS | 多线程 QPS (10并发) |
|------|------|-----------|---------------------|
| 香港 hk3 | 香港 | ~9-14 | ~36 |
| ntt2 | NTT | ~6 | ~27 |
| 杭州电信 | 大陆 | ~0.4-0.8 | ~2-9（受大陆-边缘 RTT 限制） |

污染检测：google/youtube/facebook/x.com 在 4 台机器全部返回真实 IP（无污染），且不同节点返回就近 IP（ECS 生效证明）。

> 实际 QPS 受边缘节点与网络影响波动，多线程并发提升明显；大陆建议配本地缓存 DNS 使用。

---

## 📁 文件说明

| 文件 | 说明 |
|------|------|
| `doh.js` | DoH 转发代理 Worker 主代码（含面板/统计/缓存/权重/ECS/ECH） |
| `wrangler-doh.toml` | Wrangler 配置（KV + Analytics Engine 绑定声明） |
| `README-DoH.md` | 本文档 |
| `doh-*.sh` | QPS / 污染 / 对比测试脚本（跑在远程 VPS 上） |

---

## 🧪 测试脚本用法

```bash
# 单机全量测试（污染检测 + 单线程 QPS + 多线程 QPS）
bash doh-test.sh https://<your-domain>/dns-query 200 600 20

# 三端点对比（你的代理 vs CF 官方 vs Google 官方）
bash doh-compare.sh 100 10
```

---

## 📄 License

与仓库根目录相同（MIT）。
