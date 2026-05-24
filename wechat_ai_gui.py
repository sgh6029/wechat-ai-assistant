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

# ====================== 默认配置 ======================
DEFAULT_CONFIG = {
    "ai_service_type": "ollama",                     # "ollama" 或 "openai"
    "ollama_url": "http://127.0.0.1:11434/api/generate",
    "ollama_model": "qwen3.5:2b-q4_K_M",
    "ollama_api_key": "",                            # 本地服务的可选 API Key
    "openai_base_url": "https://api.openai.com/v1",
    "openai_api_key": "",
    "openai_model": "gpt-3.5-turbo",
    "weflow_base_url": "http://127.0.0.1:5031",
    "access_token": "",
    "buffer_seconds": 25,
    "ai_timeout": 120,
    "max_history_len": 10,
    "custom_system_prompt": "你是一个日常聊天助手，请用简洁、自然的日常口吻回复，回复内容必须使用简体中文。除非用户明确要求详细回答，否则尽量简短。不要使用表情符号。直接返回回复内容，不要加任何额外说明。",
    "weflow_path": "",
    "ollama_path": "",
    "wechat_path": ""
}
CONFIG_FILE = "config.json"

# ====================== AI 调用封装（支持可选 API Key）======================
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

def call_openai(config, full_prompt, timeout):
    url = config["openai_base_url"].rstrip('/') + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {config['openai_api_key']}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": config["openai_model"],
        "messages": [{"role": "user", "content": full_prompt}],
        "stream": False
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    if resp.status_code == 200:
        return resp.json()["choices"][0]["message"]["content"].strip()
    else:
        raise Exception(f"OpenAI API 返回 {resp.status_code}: {resp.text}")

def get_ai_reply_by_config(config, system_prompt, user_msg, timeout):
    full_prompt = f"{system_prompt}\n\n用户：{user_msg}\n助手："
    if config["ai_service_type"] == "ollama":
        return call_ollama(config, full_prompt, timeout)
    else:
        if not config.get("openai_api_key"):
            raise Exception("未配置 OpenAI API Key，请在设置中填写")
        return call_openai(config, full_prompt, timeout)

# ====================== AI 助手核心类（带日志回调）======================
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
        self.chat_histories = defaultdict(list)

    def log_message(self, msg, level="INFO"):
        self.log(f"[{level}] {msg}")

    def build_prompt_with_history(self, sender, new_user_msg):
        history = self.chat_histories.get(sender, [])
        max_len = self.config.get("max_history_len", 10) * 2
        history_text = ""
        for turn in history[-max_len:]:
            role = "用户" if turn["role"] == "user" else "助手"
            history_text += f"{role}：{turn['content']}\n"
        system_prompt = self.config.get("custom_system_prompt", DEFAULT_CONFIG["custom_system_prompt"])
        full_prompt = f"{system_prompt}\n\n以下是对话历史：\n{history_text}\n用户：{new_user_msg}\n助手："
        return full_prompt

    def update_history(self, sender, user_msg, assistant_reply):
        self.chat_histories[sender].append({"role": "user", "content": user_msg})
        self.chat_histories[sender].append({"role": "assistant", "content": assistant_reply})
        max_len = self.config.get("max_history_len", 10) * 2
        if len(self.chat_histories[sender]) > max_len:
            self.chat_histories[sender] = self.chat_histories[sender][-max_len:]

    def get_ai_reply(self, sender, user_msg):
        try:
            reply = get_ai_reply_by_config(
                self.config,
                self.config.get("custom_system_prompt", DEFAULT_CONFIG["custom_system_prompt"]),
                user_msg,
                self.config.get("ai_timeout", 120)
            )
            if reply:
                self.update_history(sender, user_msg, reply)
            return reply
        except Exception as e:
            self.log_message(f"AI 调用失败: {e}", "ERROR")
            return None

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

    def process_sender(self, sender):
        with self.buffer_lock:
            if sender not in self.pending_buffers:
                return
            entry = self.pending_buffers[sender]
            if entry["processing"]:
                return
            if not entry["messages"]:
                return
            messages = entry["messages"].copy()
            entry["messages"] = []
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
                self.log_message("🔄 检测到 AI 处理期间的新消息，立即开始下一轮回复")
                threading.Thread(target=self.process_sender, args=(sender,), daemon=True).start()

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
            if self.running:
                time.sleep(5)
                self.listen_sse()

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

# ====================== 图形界面 ======================
class Application(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("微信 AI 助手控制面板")
        self.geometry("1250x800")
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
                return config
            except:
                return DEFAULT_CONFIG.copy()
        else:
            return DEFAULT_CONFIG.copy()

    def save_config(self):
        self.config["ai_service_type"] = self.ai_service_var.get()
        self.config["ollama_url"] = self.ollama_url_var.get()
        self.config["ollama_model"] = self.ollama_model_var.get()
        self.config["ollama_api_key"] = self.ollama_api_key_var.get().strip()
        self.config["openai_base_url"] = self.openai_url_var.get()
        self.config["openai_api_key"] = self.openai_key_var.get().strip()
        self.config["openai_model"] = self.openai_model_var.get()
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
        self.refresh_status()

    def create_widgets(self):
        main_panel = ttk.Frame(self)
        main_panel.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        left_frame = ttk.Frame(main_panel)
        left_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        right_frame = ttk.Frame(main_panel, width=450)
        right_frame.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)
        right_frame.pack_propagate(False)

        ttk.Label(right_frame, text="实时运行状态", font=("Arial", 10, "bold")).pack(pady=(0,5))
        self.realtime_log = scrolledtext.ScrolledText(right_frame, wrap=tk.WORD, height=30, font=("Consolas", 9))
        self.realtime_log.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        notebook = ttk.Notebook(left_frame)
        notebook.pack(fill=tk.BOTH, expand=True)

        config_frame = ttk.Frame(notebook)
        notebook.add(config_frame, text="配置")

        # AI 服务选择
        ai_frame = ttk.LabelFrame(config_frame, text="AI 服务选择")
        ai_frame.grid(row=0, column=0, padx=10, pady=5, sticky="ew")
        self.ai_service_var = tk.StringVar(value=self.config["ai_service_type"])
        ttk.Radiobutton(ai_frame, text="本地 Ollama", variable=self.ai_service_var, value="ollama", command=self.on_ai_service_change).grid(row=0, column=0, padx=5, pady=2)
        ttk.Radiobutton(ai_frame, text="第三方 OpenAI 兼容 (需 API Key)", variable=self.ai_service_var, value="openai", command=self.on_ai_service_change).grid(row=0, column=1, padx=5, pady=2)

        # Ollama 配置
        self.ollama_frame = ttk.LabelFrame(config_frame, text="Ollama 配置 (支持可选 API Key)")
        self.ollama_frame.grid(row=1, column=0, padx=10, pady=5, sticky="ew")
        ttk.Label(self.ollama_frame, text="API 地址:").grid(row=0, column=0, sticky="w", padx=5, pady=2)
        self.ollama_url_var = tk.StringVar(value=self.config["ollama_url"])
        ttk.Entry(self.ollama_frame, textvariable=self.ollama_url_var, width=50).grid(row=0, column=1, padx=5, pady=2)
        ttk.Label(self.ollama_frame, text="模型名称:").grid(row=1, column=0, sticky="w", padx=5, pady=2)
        self.ollama_model_var = tk.StringVar(value=self.config["ollama_model"])
        ttk.Entry(self.ollama_frame, textvariable=self.ollama_model_var, width=30).grid(row=1, column=1, padx=5, pady=2)
        ttk.Label(self.ollama_frame, text="API Key (可选):").grid(row=2, column=0, sticky="w", padx=5, pady=2)
        self.ollama_api_key_var = tk.StringVar(value=self.config.get("ollama_api_key", ""))
        ttk.Entry(self.ollama_frame, textvariable=self.ollama_api_key_var, width=50, show="*").grid(row=2, column=1, padx=5, pady=2)

        # OpenAI 配置
        self.openai_frame = ttk.LabelFrame(config_frame, text="第三方 OpenAI 兼容配置 (需要 API Key)")
        self.openai_frame.grid(row=2, column=0, padx=10, pady=5, sticky="ew")
        ttk.Label(self.openai_frame, text="Base URL:").grid(row=0, column=0, sticky="w", padx=5, pady=2)
        self.openai_url_var = tk.StringVar(value=self.config["openai_base_url"])
        ttk.Entry(self.openai_frame, textvariable=self.openai_url_var, width=50).grid(row=0, column=1, padx=5, pady=2)
        ttk.Label(self.openai_frame, text="API Key (必填):").grid(row=1, column=0, sticky="w", padx=5, pady=2)
        self.openai_key_var = tk.StringVar(value=self.config["openai_api_key"])
        ttk.Entry(self.openai_frame, textvariable=self.openai_key_var, width=50, show="*").grid(row=1, column=1, padx=5, pady=2)
        ttk.Label(self.openai_frame, text="模型名称:").grid(row=2, column=0, sticky="w", padx=5, pady=2)
        self.openai_model_var = tk.StringVar(value=self.config["openai_model"])
        ttk.Entry(self.openai_frame, textvariable=self.openai_model_var, width=30).grid(row=2, column=1, padx=5, pady=2)

        # WeFlow 配置
        weflow_frame = ttk.LabelFrame(config_frame, text="WeFlow 配置")
        weflow_frame.grid(row=3, column=0, padx=10, pady=5, sticky="ew")
        ttk.Label(weflow_frame, text="API 地址:").grid(row=0, column=0, sticky="w", padx=5, pady=2)
        self.weflow_url_var = tk.StringVar(value=self.config["weflow_base_url"])
        ttk.Entry(weflow_frame, textvariable=self.weflow_url_var, width=40).grid(row=0, column=1, padx=5, pady=2)
        ttk.Label(weflow_frame, text="Access Token (鉴权凭证):").grid(row=1, column=0, sticky="w", padx=5, pady=2)
        self.token_var = tk.StringVar(value=self.config["access_token"])
        ttk.Entry(weflow_frame, textvariable=self.token_var, width=60, show="*").grid(row=1, column=1, padx=5, pady=2)

        # 行为参数
        param_frame = ttk.LabelFrame(config_frame, text="行为参数")
        param_frame.grid(row=4, column=0, padx=10, pady=5, sticky="ew")
        ttk.Label(param_frame, text="缓冲秒数 (合并等待):").grid(row=0, column=0, sticky="w", padx=5, pady=2)
        self.buffer_var = tk.StringVar(value=str(self.config["buffer_seconds"]))
        ttk.Entry(param_frame, textvariable=self.buffer_var, width=10).grid(row=0, column=1, padx=5, pady=2)
        ttk.Label(param_frame, text="AI 超时(秒):").grid(row=1, column=0, sticky="w", padx=5, pady=2)
        self.timeout_var = tk.StringVar(value=str(self.config["ai_timeout"]))
        ttk.Entry(param_frame, textvariable=self.timeout_var, width=10).grid(row=1, column=1, padx=5, pady=2)
        ttk.Label(param_frame, text="对话历史轮数:").grid(row=2, column=0, sticky="w", padx=5, pady=2)
        self.history_var = tk.StringVar(value=str(self.config["max_history_len"]))
        ttk.Entry(param_frame, textvariable=self.history_var, width=10).grid(row=2, column=1, padx=5, pady=2)

        # AI 人设
        prompt_frame = ttk.LabelFrame(config_frame, text="AI 人设提示词 (自定义)")
        prompt_frame.grid(row=5, column=0, padx=10, pady=5, sticky="ew")
        self.prompt_text = tk.Text(prompt_frame, height=6, width=70, wrap=tk.WORD)
        self.prompt_text.insert("1.0", self.config.get("custom_system_prompt", DEFAULT_CONFIG["custom_system_prompt"]))
        self.prompt_text.pack(padx=5, pady=5, fill=tk.BOTH)

        # 程序路径
        path_frame = ttk.LabelFrame(config_frame, text="程序路径 (可选，用于一键启动)")
        path_frame.grid(row=6, column=0, padx=10, pady=5, sticky="ew")
        ttk.Label(path_frame, text="WeFlow 路径:").grid(row=0, column=0, sticky="w", padx=5, pady=2)
        self.weflow_path_var = tk.StringVar(value=self.config.get("weflow_path", ""))
        ttk.Entry(path_frame, textvariable=self.weflow_path_var, width=50).grid(row=0, column=1, padx=5, pady=2)
        ttk.Button(path_frame, text="浏览", command=lambda: self.browse_file(self.weflow_path_var)).grid(row=0, column=2, padx=2)
        ttk.Label(path_frame, text="Ollama 路径:").grid(row=1, column=0, sticky="w", padx=5, pady=2)
        self.ollama_path_var = tk.StringVar(value=self.config.get("ollama_path", ""))
        ttk.Entry(path_frame, textvariable=self.ollama_path_var, width=50).grid(row=1, column=1, padx=5, pady=2)
        ttk.Button(path_frame, text="浏览", command=lambda: self.browse_file(self.ollama_path_var)).grid(row=1, column=2, padx=2)
        ttk.Label(path_frame, text="微信 路径:").grid(row=2, column=0, sticky="w", padx=5, pady=2)
        self.wechat_path_var = tk.StringVar(value=self.config.get("wechat_path", ""))
        ttk.Entry(path_frame, textvariable=self.wechat_path_var, width=50).grid(row=2, column=1, padx=5, pady=2)
        ttk.Button(path_frame, text="浏览", command=lambda: self.browse_file(self.wechat_path_var)).grid(row=2, column=2, padx=2)

        # 按钮
        btn_frame = ttk.Frame(config_frame)
        btn_frame.grid(row=7, column=0, pady=10)
        ttk.Button(btn_frame, text="保存配置", command=self.save_config).pack(side="left", padx=5)
        ttk.Button(btn_frame, text="一键检测所有状态", command=self.show_full_status).pack(side="left", padx=5)
        ttk.Button(btn_frame, text="刷新状态", command=self.refresh_status).pack(side="left", padx=5)
        ttk.Button(btn_frame, text="一键启动所有服务", command=self.one_key_start).pack(side="left", padx=5)
        ttk.Button(btn_frame, text="启动 AI 助手", command=self.start_assistant).pack(side="left", padx=5)
        ttk.Button(btn_frame, text="停止 AI 助手", command=self.stop_assistant).pack(side="left", padx=5)

        # 状态栏
        self.status_var = tk.StringVar(value="就绪")
        status_bar = ttk.Label(self, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        status_bar.pack(side=tk.BOTTOM, fill=tk.X)

        self.on_ai_service_change()
        self.after(500, self.refresh_status)

    def browse_file(self, var):
        filename = filedialog.askopenfilename(title="选择可执行文件", filetypes=[("Exe files", "*.exe")])
        if filename:
            var.set(filename)

    def on_ai_service_change(self):
        if self.ai_service_var.get() == "ollama":
            self.ollama_frame.grid()
            self.openai_frame.grid_remove()
        else:
            self.ollama_frame.grid_remove()
            self.openai_frame.grid()

    def refresh_status(self):
        # 简单在日志中记录刷新
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

        # 参数有效性检查
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
        status_win.geometry("550x450")
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

if __name__ == "__main__":
    app = Application()
    app.mainloop()