# WeFlow Bot —— 给 WeFlow 加一个微信 AI 助手侧边栏

> 在 [WeFlow](https://github.com/hicccc77/WeFlow)（Electron 写的微信聊天记录工具）里注入一个
> 「Bot」页签，实现自动回复、群聊 @ 响应、定时消息、聊天归档、本地检索、插件、文档解析等功能。
>
> 全部逻辑写在一个注入脚本里，**不修改 WeFlow 的 app.asar 内容**，只在主 bundle 末尾
> 追加一行 bootstrap，用来 `require` 同目录下的 `hook.js`。

---

## 功能

| 分类 | 能力 |
|---|---|
| 自动回复 | 私聊 / 群聊，私聊陌生人可拦；按会话限速、冷却 |
| 群聊 | 只有 @ 我、关键词、拍一拍才回；**可切换「全局统一」或「按群单独设置」**（每个群独立提示词、触发方式、合并延迟、每分钟上限） |
| 多人并发 @ | 按发言人分开合并，各自回复，不互相顶掉；合并文本带「发言人：内容」 |
| 被 @ 后持续激活 | 20 条 / 5 分钟（可调），结束条件可选 |
| 定时消息 | 内置调度器，规则可无限加，每条独立设置（每天/每周/间隔），支持干跑 |
| 聊天归档 | 每个联系人/群一个文件夹 `名字__会话id/messages.ndjson`，自动增量拉取、到上限自动压缩、可一键打开或直接编辑 |
| 本地检索 | 模型内置 `search_history` 工具，问「上次谁说过什么」直接翻本地归档，不走网络 |
| 上下文 | 每会话独立摘要失败自动压缩归档；200k/500k/1M 可配，超限自动压缩 |
| 联网 | DeepSeek 官方 `deepseek_web_search` / 通义百炼 `enable_search`，也可用自建搜索 API |
| 视觉 | 图片、表情包交给视觉模型；表情包可标记 + 按语义挑选，支持以文件或图片形式发送 |
| 插件 | 从 GitHub 下载安装，子进程隔离，可设「完全访问 / 仅可读 / 工作区外浏览」 |
| 文档 | 内置 docx / pptx 解析、zip 读写、聊天纪要 |
| 隐私 | 一键关闭 WeFlow 自带的数据上报（25 个 IPC 通道）与本地统计聚合 |

## 安装

### 方式一：便携包（推荐）

下载完整 WeFlow 便携包，解压后直接双击 `WeFlow\WeFlow.exe`。
Bot 已内置，侧边栏会自动出现「Bot」。

### 方式二：装到已有的 WeFlow 上

```powershell
# 1. 生成 payload
.\build-payload.ps1

# 2. 把 payload 里的文件放到 WeFlow\resources\wfai\
# 3. 以管理员身份运行
.\installer\install.cmd
```

安装脚本会：

1. 备份 `resources\app.asar` → `app.asar.before-wfai`
2. 在 asar 主 bundle 末尾追加一行 bootstrap（其余字节不动）
3. 把 Bot 文件复制到 `resources\wfai`
4. 首次安装生成配置模板（**API Key 留空**）

> asar 补丁是**纯 PowerShell** 实现的（`tools/patch-asar.ps1`），不需要 Node.js。
> 原理：把改好的主文件追加到 payload 末尾，只改这一个条目的 offset/size，
> 其它文件一个字节都不动。

## 配置

配置在 `%APPDATA%\weflow\wfai\config.json`（或在 `resources\wfai\config.json` 放一份即变便携模式）。

首次使用进 WeFlow → Bot → 设置，填 AI 的 API Key 并保存。

支持的服务商：

- **DeepSeek**（`https://api.deepseek.com`）—— 含服务端联网搜索、深度思考
- **阿里云百炼**（compatible-mode）—— 含 `enable_search`
- **任意 OpenAI 兼容接口**
- **本地 Ollama**

## 目录

```
weflow-bot/
  src/            hook.js（主进程侧车）+ ui.js（面板）+ send.ps1（发送）
  src/lib/        zip / ooxml / 插件宿主
  src/plugins/    chat-digest / docx / pptx
  installer/      安装与卸载脚本
  tools/          asar 补丁、窗口置顶、图片缩放
  docs/           开发与修复记录（踩过的坑都写在这儿）
```

## 已知限制

- 发送依赖键盘/剪贴板模拟（`send.ps1`），需要微信窗口能被正常激活
- 只支持 Windows
- 朋友圈图片暂不支持
- 微信 4.x 是 Qt 应用，没有 UIA 树，只能靠窗口标题匹配 + 输入框坐标点击

## 协议

本仓库为个人自用工具，遵循原项目 WeFlow 的开源协议。
不包含任何 API Key、token 或个人数据。
