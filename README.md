# 微信 AI 助手 (WeChat AI Assistant)

基于 WeFlow 和 Ollama 的微信自动回复机器人，支持实时消息推送、本地 AI 模型、消息合并缓冲、语音/表情包过滤、智能窗口查找。

源代码在bot.py中,有什么不会的让DeepSeek教你
链接https://github.com/sgh6029/wechat-ai-assistant/releases/tag/2.0

## 功能特性

- 🔔 实时接收微信消息（通过 WeFlow 主动推送）
- 🤖 调用本地 Ollama 模型生成智能回复（支持任意模型）
- ⏱️ 消息合并缓冲：同一联系人连续消息统一回复（默认25秒）
- 🎤 自动忽略语音消息、表情包等非文本内容
- 💬 AI 回复风格：简洁、日常、简体中文
- 🖥️ 智能窗口管理：兼容微信主窗口和独立聊天窗口
- 🧠 每个联系人独立对话记忆，支持多轮上下文
- 📦 打包为独立 EXE 文件

## 系统要求

- Windows 10/11
- **[WeFlow](https://weflow.top)**：一个**完全本地运行**的微信聊天记录查看工具。请从[官网](https://weflow.top)下载并安装。
  - 请确保安装后打开 **API服务** 和 **主动推送** 功能。
- **[Ollama](https://ollama.com)**：已安装并下载好模型（例如 `qwen3.5:2b`）
- **Python 3.8+** （仅运行源码时需要，打包 EXE 无需 Python）

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
