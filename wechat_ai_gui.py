import os
import sys
import json
import threading
import subprocess
import tkinter as tk
from tkinter import ttk, scrolledtext, filedialog, messagebox
from datetime import datetime
import time
import requests
import pyautogui
import pyperclip
import pygetwindow as gw
from collections import defaultdict
from duckduckgo_search import DDGS   # 用于免费联网搜索

# ====================== 默认配置 ======================
DEFAULT_CONFIG = {
    "current_preset": "default",
    "api_presets": {
        "default": {
            "service_name": "默认 (本地 Ollama)",
            "ai_service_type": "ollama",
            "ollama_url": "http://127.0.0.1:11434/api/generate",
            "ollama_model": "qwen3.5:2b-q4_K_M",
            "ollama_api_key": "",
            "openai_base_url": "https://api.openai.com/v1",
            "openai_api_key": "",
            "openai_model": "gpt-3.5-turbo",
            "deepseek_thinking_enabled": False,
            "deepseek_reasoning_effort": "medium",
            # 工具设置
            "tools_enabled": {
                "get_weather": True,
                "web_search": True
            },
            "web_search_engine": "duckduckgo",   # "duckduckgo" 或 "bing"
            "bing_api_key": ""
        }
    },
    "weflow_base_url": "http://127.0.0.1:5031",
    "access_token": "",
    "buffer_seconds": 25,
    "ai_timeout": 120,
    "max_history_len": 20,
    "custom_system_prompt": "你是一个日常聊天助手，请用简洁、自然的日常口吻回复，回复内容必须使用简体中文。除非用户明确要求详细回答，否则尽量简短。不要使用表情符号。直接返回回复内容，不要加任何额外说明。",
    "weflow_path": "",
    "ollama_path": "",
    "wechat_path": ""
}
CONFIG_FILE = "config.json"

# ====================== 工具实现（可自定义） ======================
def get_weather(location: str) -> str:
    """模拟天气查询，可替换为真实 API"""
    # 这里可以换成和风天气、OpenWeatherMap 等
    return f"{location} 当前天气：晴朗，24°C，湿度60%。"

def web_search_duckduckgo(query: str, max_results: int = 3) -> str:
    """使用 DuckDuckGo 免费搜索"""
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
            if not results:
                return "未找到相关结果。"
            snippets = [f"{r['title']}: {r['body']}" for r in results]
            return "\n".join(snippets)
    except Exception as e:
        return f"搜索失败：{str(e)}"

def web_search_bing(query: str, api_key: str, max_results: int = 3) -> str:
    """使用 Bing Search API (需要 api_key)"""
    try:
        url = "https://api.bing.microsoft.com/v7.0/search"
        headers = {"Ocp-Apim-Subscription-Key": api_key}
        params = {"q": query, "count": max_results}
        resp = requests.get(url, headers=headers, params=params, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            webpages = data.get("webPages", {}).get("value", [])
            if not webpages:
                return "未找到相关结果。"
            snippets = [f"{item['name']}: {item['snippet']}" for item in webpages]
            return "\n".join(snippets)
        else:
            return f"Bing 搜索失败：HTTP {resp.status_code}"
    except Exception as e:
        return f"Bing 搜索异常：{str(e)}"

# ====================== 工具映射与声明 ======================
def get_tools_schema(config):
    """根据配置生成工具列表（只返回启用的工具）"""
    tools_enabled = config.get("tools_enabled", {})
    schemas = []
    if tools_enabled.get("get_weather", True):
        schemas.append({
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "获取指定城市的天气情况",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "城市名称"}
                    },
                    "required": ["location"]
                }
            }
        })
    if tools_enabled.get("web_search", True):
        schemas.append({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "搜索互联网上的实时信息",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "搜索关键词"}
                    },
                    "required": ["query"]
                }
            }
        })
    return schemas

def execute_tool_call(tool_name, tool_args, config):
    """执行工具调用，根据配置选择不同的搜索引擎"""
    if tool_name == "get_weather":
        return get_weather(tool_args.get("location", ""))
    elif tool_name == "web_search":
        query = tool_args.get("query", "")
        engine = config.get("web_search_engine", "duckduckgo")
        if engine == "duckduckgo":
            return web_search_duckduckgo(query)
        elif engine == "bing":
            api_key = config.get("bing_api_key", "")
            if not api_key:
                return "未配置 Bing API Key，请在工具设置中填写。"
            return web_search_bing(query, api_key)
        else:
            return f"未知搜索引擎: {engine}"
    else:
        return f"未知工具: {tool_name}"

# ====================== AI 调用封装（支持工具调用） ======================
def call_ollama(config, full_prompt, timeout):
    url = config["ollama_url"]
    headers = {"Content-Type": "application/json"}
    api_key = config.get("ollama_api_key", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {"model": config["ollama_model"], "prompt": full_prompt, "stream": False}
    resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    if resp.status_code == 200:
        return resp.json().get("response", "").strip()
    else:
        raise Exception(f"Ollama 返回 {resp.status_code}")

def call_openai_with_tools(config, messages, timeout):
    """发送消息并处理工具调用循环"""
    url = config["openai_base_url"].rstrip('/') + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {config['openai_api_key']}",
        "Content-Type": "application/json"
    }
    tools = get_tools_schema(config)
    current_messages = messages.copy()
    max_iterations = 5
    for _ in range(max_iterations):
        payload = {
            "model": config["openai_model"],
            "messages": current_messages,
            "stream": False
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if config.get("deepseek_thinking_enabled", False):
            reasoning = config.get("deepseek_reasoning_effort", "medium")
            if reasoning in ["low", "medium", "high"]:
                payload["reasoning_effort"] = reasoning
        resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
        if resp.status_code != 200:
            raise Exception(f"API 返回 {resp.status_code}: {resp.text}")
        data = resp.json()
        message = data["choices"][0]["message"]
        if not message.get("tool_calls"):
            return message.get("content", "")
        # 有工具调用
        current_messages.append(message)
        for tool_call in message["tool_calls"]:
            func_name = tool_call["function"]["name"]
            func_args = json.loads(tool_call["function"]["arguments"])
            result = execute_tool_call(func_name, func_args, config)
            current_messages.append({
                "role": "tool",
                "tool_call_id": tool_call["id"],
                "content": result
            })
    return "工具调用次数过多，请稍后再试。"

def call_openai_simple(config, messages, timeout):
    """不带工具调用的普通请求（用于历史上下文等）"""
    url = config["openai_base_url"].rstrip('/') + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {config['openai_api_key']}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": config["openai_model"],
        "messages": messages,
        "stream": False
    }
    if config.get("deepseek_thinking_enabled", False):
        reasoning = config.get("deepseek_reasoning_effort", "medium")
        if reasoning in ["low", "medium", "high"]:
            payload["reasoning_effort"] = reasoning
    resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    if resp.status_code != 200:
        raise Exception(f"API 返回 {resp.status_code}: {resp.text}")
    return resp.json()["choices"][0]["message"]["content"]

def get_ai_reply_by_config(config, system_prompt, user_msg, timeout):
    """统一入口：根据配置和是否启用工具返回回复"""
    full_prompt = f"{system_prompt}\n\n用户：{user_msg}\n助手："
    if config["ai_service_type"] == "ollama":
        return call_ollama(config, full_prompt, timeout)
    else:
        # 云端模式：支持工具调用
        messages = [{"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_msg}]
        # 检查是否有任何工具启用
        tools_enabled = config.get("tools_enabled", {})
        if any(tools_enabled.values()):
            return call_openai_with_tools(config, messages, timeout)
        else:
            return call_openai_simple(config, messages, timeout)
# ====================== 状态检测函数 ======================
def check_weflow_api(url, token):
    try:
        test_url = f"{url}/api/v1/messages?limit=1"
        headers = {"Authorization": f"Bearer {token}"}
        resp = requests.get(test_url, timeout=5)
        if resp.status_code == 200:
            return "✅ WeFlow API: 正常", "green"
        elif resp.status_code == 401:
            return "❌ WeFlow API: Token 错误", "red"
        else:
            return f"⚠️ WeFlow API: HTTP {resp.status_code}", "orange"
    except requests.ConnectionError:
        return "❌ WeFlow API: 无法连接 (服务未启动或地址错误)", "red"
    except Exception as e:
        return f"⚠️ WeFlow API: {str(e)[:50]}", "orange"

def check_ollama_service(base_url, api_key=""):
    try:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        resp = requests.get(f"{base_url}/api/tags", headers=headers, timeout=5)
        if resp.status_code == 200:
            return "✅ Ollama 服务: 运行中", "green"
        else:
            return f"⚠️ Ollama 服务: 状态码 {resp.status_code}", "orange"
    except:
        return "❌ Ollama 服务: 未运行或地址错误", "red"

def check_ollama_model(base_url, model_name, api_key=""):
    try:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        resp = requests.get(f"{base_url}/api/tags", headers=headers, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            models = data.get("models", [])
            for m in models:
                if m.get("name") == model_name:
                    return f"✅ Ollama 模型 {model_name}: 已安装", "green"
            return f"❌ Ollama 模型 {model_name}: 未找到，请先 pull", "red"
        else:
            return f"⚠️ Ollama 模型: 无法查询", "orange"
    except:
        return "⚠️ Ollama 模型: 无法查询 (服务未运行)", "orange"

def check_openai_connection(base_url, api_key, model):
    if not api_key:
        return "⚠️ OpenAI API Key: 未填写（请填写）", "orange"
    try:
        url = base_url.rstrip('/') + "/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        payload = {"model": model, "messages": [{"role": "user", "content": "test"}], "max_tokens": 1}
        resp = requests.post(url, json=payload, headers=headers, timeout=5)
        if resp.status_code == 200:
            return f"✅ OpenAI API ({model}): 连接正常", "green"
        elif resp.status_code == 401:
            return f"❌ OpenAI API: API Key 错误", "red"
        else:
            return f"⚠️ OpenAI API: HTTP {resp.status_code}", "orange"
    except Exception as e:
        return f"❌ OpenAI API: {str(e)[:50]}", "red"

def check_wechat_running():
    try:
        wins = gw.getWindowsWithTitle("微信")
        if wins:
            return "✅ 微信进程: 运行中 (窗口可见)", "green"
        else:
            return "❌ 微信进程: 未运行或窗口不可见", "red"
    except:
        return "⚠️ 微信进程: 检测失败", "orange"

def check_access_token(token):
    if not token:
        return "❌ Access Token: 未填写", "red"
    else:
        return "✅ Access Token: 已填写", "green"

def check_model_name(service_type, ollama_model, openai_model):
    if service_type == "ollama":
        if not ollama_model:
            return "❌ Ollama 模型名称: 未填写", "red"
        else:
            return f"✅ Ollama 模型名称: {ollama_model}", "green"
    else:
        if not openai_model:
            return "❌ OpenAI 模型名称: 未填写", "red"
        else:
            return f"✅ OpenAI 模型名称: {openai_model}", "green"
# ====================== AI 助手核心类 (v2.0 支持工具调用) ======================
class WeChatAIAssistant:
    def __init__(self, config, log_callback):
        self.config = config
        self.log = log_callback
        self.running = False
        self.thread = None
        self.processed_ids = set()
        self.start_timestamp = int(time.time())
        self.pending_buffers = {}
        self.buffer_lock = threading.Lock()
        self.ai_processing_lock = threading.Lock()
        self.chat_histories = defaultdict(list)   # 存储格式：[{"user_msg":..., "assistant_reply":...}]

    def log_message(self, msg, level="INFO"):
        self.log(f"[{level}] {msg}")

    # ---------- 窗口查找与发送（与 v1.1 完全相同）----------
    def find_chat_window(self, contact, exclude_window=None):
        all_windows = gw.getAllWindows()
        for win in all_windows:
            if not win.visible:
                continue
            if exclude_window and win == exclude_window:
                continue
            title = win.title
            if contact in title and title != "微信":
                return win, True
        for win in all_windows:
            if win.title == "微信" and win.visible:
                return win, False
        return None, False

    def send_to_wechat(self, contact, message):
        win, is_direct = self.find_chat_window(contact)
        if win is None:
            self.log_message("未找到微信窗口，请确认微信已登录", "ERROR")
            return False
        try:
            if win.isMinimized:
                win.restore()
            win.activate()
            time.sleep(0.3)
        except Exception as e:
            self.log_message(f"无法激活窗口: {e}", "ERROR")
            return False

        if not is_direct:
            self.log_message(f"在主窗口搜索联系人: {contact}")
            try:
                pyautogui.hotkey('ctrl', 'f')
                time.sleep(0.3)
                pyautogui.hotkey('ctrl', 'a')
                pyautogui.press('delete')
                time.sleep(0.1)
                pyperclip.copy(contact)
                pyautogui.hotkey('ctrl', 'v')
                time.sleep(1.0)
                pyautogui.press('enter')
                time.sleep(1.5)
                start_time = time.time()
                new_win = None
                while time.time() - start_time < 5:
                    new_win, is_direct = self.find_chat_window(contact, exclude_window=win)
                    if new_win and is_direct:
                        break
                    time.sleep(0.3)
                if new_win and is_direct:
                    win = new_win
                    self.log_message(f"已定位到独立聊天窗口: {win.title}")
                    if win.isMinimized:
                        win.restore()
                    win.activate()
                    time.sleep(0.3)
                    is_direct = True
                else:
                    self.log_message("未检测到独立窗口，尝试在主窗口输入", "WARN")
            except Exception as e:
                self.log_message(f"搜索联系人失败: {e}", "ERROR")
                return False

        try:
            left, top, width, height = win.left, win.top, win.width, win.height
            if is_direct:
                click_x = left + width // 2
                click_y = top + height - 70
                pyautogui.click(click_x, click_y)
                time.sleep(0.2)
            else:
                click_x = left + width - 250
                click_y = top + height - 60
                pyautogui.click(click_x, click_y)
                time.sleep(0.2)
                pyautogui.click(click_x, click_y)
                time.sleep(0.1)
            pyautogui.hotkey('ctrl', 'a')
            pyautogui.press('delete')
            time.sleep(0.1)
            pyperclip.copy(message)
            pyautogui.hotkey('ctrl', 'v')
            time.sleep(0.2)
            pyautogui.press('enter')
            self.log_message(f"已回复 {contact}: {message[:50]}...")
            return True
        except Exception as e:
            self.log_message(f"发送失败: {e}", "ERROR")
            return False

    def should_ignore_message(self, data):
        content = data.get("content", "")
        msg_type = data.get("type", 0) or data.get("msgType", 0)
        if msg_type in (34, 47):
            return True
        if content and ("[语音]" in content or "[表情]" in content):
            return True
        if not content or content.strip() == "":
            return True
        return False

    # ---------- 消息处理核心（与 v1.1 相同）----------
    def process_sender(self, sender):
        with self.buffer_lock:
            if sender not in self.pending_buffers:
                return
            entry = self.pending_buffers[sender]
            if entry["processing"]:
                return
            if not entry["messages"]:
                return
            messages = entry["messages"][:20]
            entry["messages"] = entry["messages"][20:]
            entry["processing"] = True
            if entry["timer"]:
                entry["timer"].cancel()
                entry["timer"] = None

        with self.ai_processing_lock:
            combined = "\n".join(messages)
            self.log_message(f"📦 合并 {len(messages)} 条消息，准备回复 {sender}")
            self.log_message(f"🤖 AI 正在思考...")
            reply = self.get_ai_reply(sender, combined)
            if reply:
                self.log_message(f"🤖 AI 回复: {reply}")
                self.log_message(f"✍️ 正在发送回复...")
                self.send_to_wechat(sender, reply)
                self.log_message(f"✅ 回复完毕")
            else:
                self.log_message("⚠️ AI 未返回有效回复，不发送", "WARN")

        with self.buffer_lock:
            if sender not in self.pending_buffers:
                return
            entry = self.pending_buffers[sender]
            entry["processing"] = False
            if entry["messages"]:
                self.log_message(f"🔄 还有 {len(entry['messages'])} 条消息等待处理，稍后继续...")
                if entry["timer"]:
                    entry["timer"].cancel()
                timer = threading.Timer(0.5, lambda: self.process_sender(sender))
                timer.daemon = True
                timer.start()
                entry["timer"] = timer
            else:
                if entry["timer"]:
                    entry["timer"].cancel()
                    entry["timer"] = None

    def add_to_buffer(self, sender, content):
        with self.buffer_lock:
            if sender not in self.pending_buffers:
                self.pending_buffers[sender] = {
                    "messages": [],
                    "timer": None,
                    "processing": False
                }
            entry = self.pending_buffers[sender]
            entry["messages"].append(content)

            if len(entry["messages"]) >= 30:
                self.log_message(f"⚠️ {sender} 积压消息已达 {len(entry['messages'])} 条，强制立即回复")
                if entry["timer"]:
                    entry["timer"].cancel()
                    entry["timer"] = None
                if not entry["processing"]:
                    threading.Thread(target=self.process_sender, args=(sender,), daemon=True).start()
                return

            if not entry["processing"]:
                if entry["timer"]:
                    entry["timer"].cancel()
                self.log_message(f"⏳ 收到来自 {sender} 的消息，等待 {self.config['buffer_seconds']} 秒后统一回复...")
                timer = threading.Timer(self.config["buffer_seconds"], lambda: self.process_sender(sender))
                timer.daemon = True
                timer.start()
                entry["timer"] = timer
            else:
                self.log_message(f"📥 收到来自 {sender} 的新消息，已加入队列（AI 正在处理）")

    # ---------- SSE 监听（与 v1.1 相同）----------
    def listen_sse(self):
        sse_url = f"{self.config['weflow_base_url']}/api/v1/push/messages?access_token={self.config['access_token']}"
        self.log_message(f"正在连接 WeFlow 推送服务: {sse_url}")
        headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache"}
        try:
            response = requests.get(sse_url, headers=headers, stream=True, timeout=None)
            if response.status_code != 200:
                self.log_message(f"连接失败，状态码: {response.status_code}", "ERROR")
                return
            self.log_message("✅ 已连接到 WeFlow 推送服务，等待新消息...")
            self.log_message(f"忽略 {datetime.fromtimestamp(self.start_timestamp)} 之前的历史消息")
            self.log_message(f"消息合并缓冲时间: {self.config['buffer_seconds']} 秒")
            for line in response.iter_lines(decode_unicode=True):
                if not self.running:
                    break
                if not line:
                    continue
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                    if event_type == "message.revoke":
                        self.log_message("收到撤回消息通知")
                elif line.startswith("data:"):
                    data_str = line[5:].strip()
                    if not data_str:
                        continue
                    try:
                        data = json.loads(data_str)
                        msg_timestamp = data.get("timestamp", 0)
                        if msg_timestamp < self.start_timestamp:
                            continue
                        raw_id = data.get("rawid")
                        if raw_id in self.processed_ids:
                            continue
                        self.processed_ids.add(raw_id)
                        if self.should_ignore_message(data):
                            continue
                        content = data.get("content", "")
                        sender = data.get("sourceName", "") or data.get("talkerName", "") or "未知"
                        if content and sender:
                            self.log_message(f"📩 收到来自 {sender} 的消息: {content[:50]}")
                            self.add_to_buffer(sender, content)
                    except Exception:
                        pass
        except Exception as e:
            self.log_message(f"SSE 连接异常: {e}", "ERROR")
            # v1.1 原版不自动重连，直接结束

    # ---------- 启动与停止 ----------
    def start(self):
        if self.running:
            self.log_message("AI 助手已在运行中", "WARN")
            return
        self.running = True
        self.processed_ids.clear()
        self.start_timestamp = int(time.time())
        self.pending_buffers.clear()
        self.chat_histories.clear()
        self.log_message("启动 AI 助手...")
        self.thread = threading.Thread(target=self.listen_sse, daemon=True)
        self.thread.start()

    def stop(self):
        if not self.running:
            self.log_message("AI 助手未运行", "WARN")
            return
        self.running = False
        self.log_message("正在停止 AI 助手...")
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=3)
        self.log_message("AI 助手已停止")

    # ---------- AI 调用与历史管理（支持工具调用）----------
    def build_prompt_with_history(self, sender, new_user_msg):
        history = self.chat_histories.get(sender, [])
        max_len = self.config.get("max_history_len", 20)
        # 取最近 max_len 条记录
        recent = history[-max_len:] if len(history) > max_len else history
        messages = []
        system_prompt = self.config.get("custom_system_prompt", DEFAULT_CONFIG["custom_system_prompt"])
        messages.append({"role": "system", "content": system_prompt})
        for turn in recent:
            messages.append({"role": "user", "content": turn["user_msg"]})
            messages.append({"role": "assistant", "content": turn["assistant_reply"]})
        messages.append({"role": "user", "content": new_user_msg})
        return messages

    def update_history(self, sender, user_msg, assistant_reply):
        self.chat_histories[sender].append({
            "user_msg": user_msg,
            "assistant_reply": assistant_reply
        })
        max_len = self.config.get("max_history_len", 20)
        if len(self.chat_histories[sender]) > max_len:
            self.chat_histories[sender] = self.chat_histories[sender][-max_len:]

    def get_ai_reply(self, sender, user_msg):
        try:
            if self.config["ai_service_type"] == "ollama":
                # Ollama 不支持工具调用，使用普通模式
                system = self.config.get("custom_system_prompt", "")
                full_prompt = f"{system}\n\n用户：{user_msg}\n助手："
                reply = call_ollama(self.config, full_prompt, self.config.get("ai_timeout", 120))
                if reply:
                    self.update_history(sender, user_msg, reply)
                return reply
            else:
                # 云端模式：支持工具调用
                messages = self.build_prompt_with_history(sender, user_msg)
                # 检查是否有任何工具启用
                tools_enabled = self.config.get("tools_enabled", {})
                if any(tools_enabled.values()):
                    reply = call_openai_with_tools(self.config, messages, self.config.get("ai_timeout", 120))
                else:
                    reply = call_openai_simple(self.config, messages, self.config.get("ai_timeout", 120))
                if reply:
                    self.update_history(sender, user_msg, reply)
                return reply
        except Exception as e:
            self.log_message(f"AI 调用失败: {e}", "ERROR")
            return None

# ====================== 图形界面 Application ======================
class Application(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("微信 AI 助手 V2.0")
        self.geometry("1200x800")
        self.minsize(1000, 700)
        self.config = self.load_config()
        self.assistant = None
        self.create_widgets()
        self.protocol("WM_DELETE_WINDOW", self.on_closing)

    def load_config(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    user_config = json.load(f)
                config = DEFAULT_CONFIG.copy()
                config.update(user_config)
                # 确保 api_presets 存在
                if "api_presets" not in config:
                    config["api_presets"] = DEFAULT_CONFIG["api_presets"]
                if "current_preset" not in config:
                    config["current_preset"] = "default"
                return config
            except:
                return DEFAULT_CONFIG.copy()
        else:
            return DEFAULT_CONFIG.copy()

    def save_config(self):
        # 保存当前界面配置到当前预设
        preset_name = self.current_preset_var.get()
        if preset_name in self.config["api_presets"]:
            preset = self.config["api_presets"][preset_name]
        else:
            preset = {}
            self.config["api_presets"][preset_name] = preset
        preset["service_name"] = self.service_name_var.get()
        preset["ai_service_type"] = self.ai_service_var.get()
        preset["ollama_url"] = self.ollama_url_var.get()
        preset["ollama_model"] = self.ollama_model_var.get()
        preset["ollama_api_key"] = self.ollama_api_key_var.get().strip()
        preset["openai_base_url"] = self.openai_url_var.get()
        preset["openai_api_key"] = self.openai_key_var.get().strip()
        preset["openai_model"] = self.openai_model_var.get()
        preset["deepseek_thinking_enabled"] = self.thinking_enabled_var.get()
        preset["deepseek_reasoning_effort"] = self.reasoning_effort_var.get()
        # 工具设置
        preset["tools_enabled"] = {
            "get_weather": self.tool_weather_var.get(),
            "web_search": self.tool_search_var.get()
        }
        preset["web_search_engine"] = self.search_engine_var.get()
        preset["bing_api_key"] = self.bing_api_key_var.get().strip()
        # 保存全局配置
        self.config["weflow_base_url"] = self.weflow_url_var.get()
        self.config["access_token"] = self.token_var.get().strip()
        self.config["buffer_seconds"] = int(self.buffer_var.get())
        self.config["ai_timeout"] = int(self.timeout_var.get())
        self.config["max_history_len"] = int(self.history_var.get())
        self.config["custom_system_prompt"] = self.prompt_text.get("1.0", tk.END).strip()
        self.config["weflow_path"] = self.weflow_path_var.get()
        self.config["ollama_path"] = self.ollama_path_var.get()
        self.config["wechat_path"] = self.wechat_path_var.get()
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(self.config, f, indent=4, ensure_ascii=False)
        self.log("配置已保存")

    def apply_preset(self, preset_name):
        """切换到指定的预设，更新界面"""
        preset = self.config["api_presets"].get(preset_name)
        if not preset:
            return
        self.service_name_var.set(preset.get("service_name", ""))
        self.ai_service_var.set(preset.get("ai_service_type", "ollama"))
        self.ollama_url_var.set(preset.get("ollama_url", DEFAULT_CONFIG["api_presets"]["default"]["ollama_url"]))
        self.ollama_model_var.set(preset.get("ollama_model", DEFAULT_CONFIG["api_presets"]["default"]["ollama_model"]))
        self.ollama_api_key_var.set(preset.get("ollama_api_key", ""))
        self.openai_url_var.set(preset.get("openai_base_url", DEFAULT_CONFIG["api_presets"]["default"]["openai_base_url"]))
        self.openai_key_var.set(preset.get("openai_api_key", ""))
        self.openai_model_var.set(preset.get("openai_model", DEFAULT_CONFIG["api_presets"]["default"]["openai_model"]))
        self.thinking_enabled_var.set(preset.get("deepseek_thinking_enabled", False))
        self.reasoning_effort_var.set(preset.get("deepseek_reasoning_effort", "medium"))
        # 工具设置
        tools = preset.get("tools_enabled", {})
        self.tool_weather_var.set(tools.get("get_weather", True))
        self.tool_search_var.set(tools.get("web_search", True))
        self.search_engine_var.set(preset.get("web_search_engine", "duckduckgo"))
        self.bing_api_key_var.set(preset.get("bing_api_key", ""))
        self.on_ai_service_change()
        self.log(f"已切换到预设: {preset_name}")

    def on_ai_service_change(self):
        if self.ai_service_var.get() == "ollama":
            self.ollama_frame.pack(fill="x", pady=5)
            self.openai_frame.pack_forget()
        else:
            self.ollama_frame.pack_forget()
            self.openai_frame.pack(fill="x", pady=5)

    def save_current_as_preset(self):
        dialog = tk.Toplevel(self)
        dialog.title("保存预设")
        dialog.geometry("300x120")
        ttk.Label(dialog, text="预设名称:").pack(pady=5)
        name_var = tk.StringVar()
        ttk.Entry(dialog, textvariable=name_var).pack(pady=5)
        def do_save():
            name = name_var.get().strip()
            if name:
                # 先保存当前界面配置到临时变量
                self.save_config()  # 这会刷新 self.config
                # 确保预设存在
                if name not in self.config["api_presets"]:
                    self.config["api_presets"][name] = {}
                # 复制当前预设内容
                current_preset = self.config["api_presets"][self.current_preset_var.get()]
                self.config["api_presets"][name] = current_preset.copy()
                self.current_preset_var.set(name)
                self.save_config()
                self.update_preset_combo()
                dialog.destroy()
        ttk.Button(dialog, text="保存", command=do_save).pack(pady=5)

    def delete_preset(self):
        name = self.current_preset_var.get()
        if name == "default":
            messagebox.showwarning("警告", "不能删除默认预设")
            return
        if messagebox.askyesno("确认", f"删除预设 '{name}'？"):
            del self.config["api_presets"][name]
            self.current_preset_var.set("default")
            self.save_config()
            self.update_preset_combo()
            self.apply_preset("default")

    def update_preset_combo(self):
        # 刷新下拉框的值
        values = list(self.config["api_presets"].keys())
        self.preset_combo['values'] = values
    # ---------- 创建界面组件 ----------
    def create_widgets(self):
        # 主框架使用 PanedWindow 支持左右拖动
        main_paned = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        main_paned.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # 左侧配置区域（不滚动，固定布局）
        left_frame = ttk.Frame(main_paned)
        main_paned.add(left_frame, weight=2)

        # 右侧日志区域
        right_frame = ttk.Frame(main_paned)
        main_paned.add(right_frame, weight=1)

        ttk.Label(right_frame, text="实时运行状态", font=("Microsoft YaHei", 10, "bold")).pack(pady=(0,5))
        self.realtime_log = scrolledtext.ScrolledText(right_frame, wrap=tk.WORD, font=("Consolas", 9))
        self.realtime_log.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # 左侧使用 Notebook 分页
        notebook = ttk.Notebook(left_frame)
        notebook.pack(fill=tk.BOTH, expand=True)

        # ---------- 配置页 ----------
        config_frame = ttk.Frame(notebook)
        notebook.add(config_frame, text="⚙️ 配置")

        # 预设管理栏
        preset_bar = ttk.Frame(config_frame)
        preset_bar.pack(fill=tk.X, pady=5)
        ttk.Label(preset_bar, text="当前预设:").pack(side=tk.LEFT, padx=5)
        self.current_preset_var = tk.StringVar(value=self.config.get("current_preset", "default"))
        self.preset_combo = ttk.Combobox(preset_bar, textvariable=self.current_preset_var,
                                         values=list(self.config["api_presets"].keys()),
                                         state="readonly", width=20)
        self.preset_combo.pack(side=tk.LEFT, padx=5)
        ttk.Button(preset_bar, text="加载", command=lambda: self.apply_preset(self.current_preset_var.get())).pack(side=tk.LEFT, padx=2)
        ttk.Button(preset_bar, text="保存当前为预设", command=self.save_current_as_preset).pack(side=tk.LEFT, padx=2)
        ttk.Button(preset_bar, text="删除预设", command=self.delete_preset).pack(side=tk.LEFT, padx=2)

        # 服务商信息
        info_frame = ttk.LabelFrame(config_frame, text="🏢 服务商信息", padding=5)
        info_frame.pack(fill=tk.X, pady=5)
        ttk.Label(info_frame, text="服务商名称:").grid(row=0, column=0, sticky="w", padx=5)
        self.service_name_var = tk.StringVar()
        ttk.Entry(info_frame, textvariable=self.service_name_var, width=30).grid(row=0, column=1, padx=5)

        # AI 服务选择
        ai_frame = ttk.LabelFrame(config_frame, text="🤖 AI 服务类型", padding=5)
        ai_frame.pack(fill=tk.X, pady=5)
        self.ai_service_var = tk.StringVar(value="ollama")
        ttk.Radiobutton(ai_frame, text="本地 Ollama", variable=self.ai_service_var, value="ollama", command=self.on_ai_service_change).pack(side=tk.LEFT, padx=10)
        ttk.Radiobutton(ai_frame, text="云端 OpenAI 兼容", variable=self.ai_service_var, value="openai", command=self.on_ai_service_change).pack(side=tk.LEFT, padx=10)

        # Ollama 配置组
        self.ollama_frame = ttk.LabelFrame(config_frame, text="🦙 Ollama 配置", padding=5)
        self.ollama_frame.pack(fill=tk.X, pady=5)
        ttk.Label(self.ollama_frame, text="API 地址:").grid(row=0, column=0, sticky="w", padx=5)
        self.ollama_url_var = tk.StringVar()
        ttk.Entry(self.ollama_frame, textvariable=self.ollama_url_var, width=60).grid(row=0, column=1, padx=5)
        ttk.Label(self.ollama_frame, text="模型名称:").grid(row=1, column=0, sticky="w", padx=5)
        self.ollama_model_var = tk.StringVar()
        ttk.Entry(self.ollama_frame, textvariable=self.ollama_model_var, width=40).grid(row=1, column=1, padx=5)
        ttk.Label(self.ollama_frame, text="API Key (可选):").grid(row=2, column=0, sticky="w", padx=5)
        self.ollama_api_key_var = tk.StringVar()
        ttk.Entry(self.ollama_frame, textvariable=self.ollama_api_key_var, width=60, show="*").grid(row=2, column=1, padx=5)

        # OpenAI 配置组
        self.openai_frame = ttk.LabelFrame(config_frame, text="☁️ OpenAI 兼容配置", padding=5)
        self.openai_frame.pack(fill=tk.X, pady=5)
        ttk.Label(self.openai_frame, text="Base URL:").grid(row=0, column=0, sticky="w", padx=5)
        self.openai_url_var = tk.StringVar()
        ttk.Entry(self.openai_frame, textvariable=self.openai_url_var, width=60).grid(row=0, column=1, padx=5)
        ttk.Label(self.openai_frame, text="API Key:").grid(row=1, column=0, sticky="w", padx=5)
        self.openai_key_var = tk.StringVar()
        ttk.Entry(self.openai_frame, textvariable=self.openai_key_var, width=60, show="*").grid(row=1, column=1, padx=5)
        ttk.Label(self.openai_frame, text="模型名称:").grid(row=2, column=0, sticky="w", padx=5)
        self.openai_model_var = tk.StringVar()
        ttk.Entry(self.openai_frame, textvariable=self.openai_model_var, width=40).grid(row=2, column=1, padx=5)

        # 深度思考设置
        thinking_frame = ttk.LabelFrame(config_frame, text="🧠 DeepSeek 深度思考设置", padding=5)
        thinking_frame.pack(fill=tk.X, pady=5)
        self.thinking_enabled_var = tk.BooleanVar()
        ttk.Checkbutton(thinking_frame, text="启用 reasoning_effort", variable=self.thinking_enabled_var).pack(anchor="w", padx=5)
        ttk.Label(thinking_frame, text="思考强度:").pack(anchor="w", padx=5)
        self.reasoning_effort_var = tk.StringVar(value="medium")
        effort_combo = ttk.Combobox(thinking_frame, textvariable=self.reasoning_effort_var, values=["low", "medium", "high"], state="readonly")
        effort_combo.pack(anchor="w", padx=5, pady=2)

        # 工具调用设置
        tools_frame = ttk.LabelFrame(config_frame, text="🔧 工具调用设置", padding=5)
        tools_frame.pack(fill=tk.X, pady=5)
        self.tool_weather_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(tools_frame, text="启用天气查询 (get_weather)", variable=self.tool_weather_var).pack(anchor="w", padx=5)
        self.tool_search_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(tools_frame, text="启用联网搜索 (web_search)", variable=self.tool_search_var).pack(anchor="w", padx=5)
        ttk.Label(tools_frame, text="搜索引擎:").pack(anchor="w", padx=5)
        self.search_engine_var = tk.StringVar(value="duckduckgo")
        engine_combo = ttk.Combobox(tools_frame, textvariable=self.search_engine_var, values=["duckduckgo", "bing"], state="readonly")
        engine_combo.pack(anchor="w", padx=5, pady=2)
        ttk.Label(tools_frame, text="Bing API Key (若选择Bing):").pack(anchor="w", padx=5)
        self.bing_api_key_var = tk.StringVar()
        ttk.Entry(tools_frame, textvariable=self.bing_api_key_var, width=60, show="*").pack(anchor="w", padx=5, pady=2)

        # WeFlow 配置
        weflow_frame = ttk.LabelFrame(config_frame, text="📱 WeFlow 配置", padding=5)
        weflow_frame.pack(fill=tk.X, pady=5)
        ttk.Label(weflow_frame, text="API 地址:").grid(row=0, column=0, sticky="w", padx=5)
        self.weflow_url_var = tk.StringVar()
        ttk.Entry(weflow_frame, textvariable=self.weflow_url_var, width=50).grid(row=0, column=1, padx=5)
        ttk.Label(weflow_frame, text="Access Token:").grid(row=1, column=0, sticky="w", padx=5)
        self.token_var = tk.StringVar()
        ttk.Entry(weflow_frame, textvariable=self.token_var, width=70, show="*").grid(row=1, column=1, padx=5)

        # 行为参数
        param_frame = ttk.LabelFrame(config_frame, text="⚡ 行为参数", padding=5)
        param_frame.pack(fill=tk.X, pady=5)
        ttk.Label(param_frame, text="消息合并缓冲秒数:").grid(row=0, column=0, sticky="w", padx=5)
        self.buffer_var = tk.StringVar()
        ttk.Entry(param_frame, textvariable=self.buffer_var, width=10).grid(row=0, column=1, padx=5)
        ttk.Label(param_frame, text="AI 请求超时(秒):").grid(row=1, column=0, sticky="w", padx=5)
        self.timeout_var = tk.StringVar()
        ttk.Entry(param_frame, textvariable=self.timeout_var, width=10).grid(row=1, column=1, padx=5)
        ttk.Label(param_frame, text="每个联系人记忆轮数:").grid(row=2, column=0, sticky="w", padx=5)
        self.history_var = tk.StringVar()
        ttk.Entry(param_frame, textvariable=self.history_var, width=10).grid(row=2, column=1, padx=5)

        # AI 人设
        prompt_frame = ttk.LabelFrame(config_frame, text="💬 AI 人设提示词 (自定义)", padding=5)
        prompt_frame.pack(fill=tk.X, pady=5)
        self.prompt_text = tk.Text(prompt_frame, height=4, wrap=tk.WORD)
        self.prompt_text.pack(fill=tk.X, padx=5, pady=5)

        # 程序路径
        path_frame = ttk.LabelFrame(config_frame, text="🚀 程序路径 (一键启动)", padding=5)
        path_frame.pack(fill=tk.X, pady=5)
        ttk.Label(path_frame, text="WeFlow 路径:").grid(row=0, column=0, sticky="w", padx=5)
        self.weflow_path_var = tk.StringVar()
        ttk.Entry(path_frame, textvariable=self.weflow_path_var, width=60).grid(row=0, column=1, padx=5)
        ttk.Button(path_frame, text="浏览", command=lambda: self.browse_file(self.weflow_path_var)).grid(row=0, column=2, padx=2)
        ttk.Label(path_frame, text="Ollama 路径:").grid(row=1, column=0, sticky="w", padx=5)
        self.ollama_path_var = tk.StringVar()
        ttk.Entry(path_frame, textvariable=self.ollama_path_var, width=60).grid(row=1, column=1, padx=5)
        ttk.Button(path_frame, text="浏览", command=lambda: self.browse_file(self.ollama_path_var)).grid(row=1, column=2, padx=2)
        ttk.Label(path_frame, text="微信 路径:").grid(row=2, column=0, sticky="w", padx=5)
        self.wechat_path_var = tk.StringVar()
        ttk.Entry(path_frame, textvariable=self.wechat_path_var, width=60).grid(row=2, column=1, padx=5)
        ttk.Button(path_frame, text="浏览", command=lambda: self.browse_file(self.wechat_path_var)).grid(row=2, column=2, padx=2)

        # 按钮区域
        btn_frame = ttk.Frame(config_frame)
        btn_frame.pack(pady=10)
        ttk.Button(btn_frame, text="💾 保存配置", command=self.save_config, width=15).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="🔍 一键检测状态", command=self.show_full_status, width=18).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="🚀 一键启动服务", command=self.one_key_start, width=18).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="▶️ 启动 AI 助手", command=self.start_assistant, width=15).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="⏹️ 停止 AI 助手", command=self.stop_assistant, width=15).pack(side=tk.LEFT, padx=5)

        # 状态栏
        self.status_var = tk.StringVar(value="就绪")
        status_bar = ttk.Label(self, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        status_bar.pack(side=tk.BOTTOM, fill=tk.X)

        # 加载当前预设的值到界面
        self.apply_preset(self.config.get("current_preset", "default"))
        self.on_ai_service_change()
        self.after(500, self.refresh_status)

    # ---------- 辅助方法 ----------
    def browse_file(self, var):
        filename = filedialog.askopenfilename(title="选择可执行文件", filetypes=[("Exe files", "*.exe")])
        if filename:
            var.set(filename)

    def refresh_status(self):
        self.log("手动刷新状态完成", "INFO")

    def show_full_status(self):
        results = []
        token = self.token_var.get()
        results.append(check_access_token(token))
        results.append(check_weflow_api(self.weflow_url_var.get(), token))

        service = self.ai_service_var.get()
        if service == "ollama":
            base = self.ollama_url_var.get().replace("/api/generate", "")
            api_key = self.ollama_api_key_var.get().strip()
            results.append(check_ollama_service(base, api_key))
            results.append(check_ollama_model(base, self.ollama_model_var.get(), api_key))
            results.append(check_model_name(service, self.ollama_model_var.get(), ""))
        else:
            base = self.openai_url_var.get()
            key = self.openai_key_var.get().strip()
            model = self.openai_model_var.get()
            results.append(check_openai_connection(base, key, model))
            results.append(check_model_name(service, "", model))

        results.append(check_wechat_running())

        try:
            buffer_int = int(self.buffer_var.get())
            if buffer_int <= 0:
                results.append(("⚠️ 缓冲秒数必须大于0", "orange"))
        except:
            results.append(("❌ 缓冲秒数必须为整数", "red"))
        try:
            timeout_int = int(self.timeout_var.get())
            if timeout_int <= 0:
                results.append(("⚠️ AI超时必须大于0", "orange"))
        except:
            results.append(("❌ AI超时必须为整数", "red"))

        status_win = tk.Toplevel(self)
        status_win.title("配置状态检测报告")
        status_win.geometry("600x500")
        text_widget = scrolledtext.ScrolledText(status_win, wrap=tk.WORD, font=("Consolas", 10))
        text_widget.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        for msg, _ in results:
            text_widget.insert(tk.END, msg + "\n")
        text_widget.config(state=tk.DISABLED)
        ttk.Button(status_win, text="关闭", command=status_win.destroy).pack(pady=5)

    def one_key_start(self):
        self.save_config()
        if self.config.get("weflow_path") and os.path.exists(self.config["weflow_path"]):
            subprocess.Popen([self.config["weflow_path"]], shell=True)
            self.log("已启动 WeFlow")
        else:
            self.log("未设置 WeFlow 路径，请手动启动 WeFlow", "WARN")
        if self.config.get("ollama_path") and os.path.exists(self.config["ollama_path"]):
            subprocess.Popen([self.config["ollama_path"], "serve"], shell=True)
            self.log("已启动 Ollama 服务")
        else:
            self.log("未设置 Ollama 路径，请手动启动 Ollama", "WARN")
        if self.config.get("wechat_path") and os.path.exists(self.config["wechat_path"]):
            subprocess.Popen([self.config["wechat_path"]], shell=True)
            self.log("已启动微信")
        else:
            self.log("未设置微信路径，请手动启动微信", "WARN")
        self.after(3000, lambda: [self.refresh_status(), self.start_assistant()])

    def start_assistant(self):
        if self.assistant and self.assistant.running:
            self.log("AI 助手已在运行中")
            return
        if not self.token_var.get():
            messagebox.showerror("错误", "请先填写 WeFlow Access Token")
            return
        if self.ai_service_var.get() == "ollama" and not self.ollama_model_var.get():
            messagebox.showerror("错误", "请填写 Ollama 模型名称")
            return
        if self.ai_service_var.get() == "openai" and not self.openai_key_var.get():
            messagebox.showerror("错误", "请填写 OpenAI API Key")
            return
        self.save_config()
        self.config = self.load_config()
        self.assistant = WeChatAIAssistant(self.config, self.log)
        self.assistant.start()
        self.status_var.set("AI 助手运行中")

    def stop_assistant(self):
        if self.assistant:
            self.assistant.stop()
            self.assistant = None
            self.status_var.set("已停止")

    def log(self, msg, level="INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.realtime_log.insert(tk.END, f"[{timestamp}] {msg}\n")
        self.realtime_log.see(tk.END)
        self.update_idletasks()

    def on_closing(self):
        if self.assistant and self.assistant.running:
            self.assistant.stop()
        self.destroy()

# ====================== 程序入口 ======================
if __name__ == "__main__":
    app = Application()
    app.mainloop()