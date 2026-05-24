# -*- coding: utf-8 -*-
"""
微信 AI 助手 - 基于 WeFlow 主动推送 + Ollama 本地模型
功能：
- 实时接收微信消息（通过 WeFlow SSE）
- 每个联系人独立对话记忆（默认保留最近10轮）
- 消息合并缓冲（默认25秒内连续消息合并回复）
- 智能窗口定位（支持主窗口和独立聊天窗口）
- 全局锁确保多用户并发时 AI 请求串行处理

配置说明：请修改下方「用户配置区域」中的参数
"""

import json
import time
import requests
import pyautogui
import pyperclip
import pygetwindow as gw
import threading
from datetime import datetime
from collections import defaultdict

# ====================== 用户配置区域（请根据你的环境修改） ======================

# 1. WeFlow 配置
WE_FLOW_BASE_URL = "http://127.0.0.1:5031"          # WeFlow API 地址，通常不需要改
ACCESS_TOKEN = "efab5b62647d8ffee550c45579a29feb"  # 【必填】WeFlow 中的 Access Token

# 2. Ollama 配置
OLLAMA_URL = "http://127.0.0.1:11434/api/generate" # Ollama API 地址，通常不需要改
OLLAMA_MODEL = "qwen3.5:2b-q4_K_M"                 # 【必填】你下载的模型名称（用 ollama list 查看）

# 3. 行为参数（可根据需要调整）
BUFFER_SECONDS = 25        # 消息合并缓冲时间（秒）：对方停止发送后等待多久再回复
AI_TIMEOUT = 120           # AI 请求超时时间（秒），如果模型较大可适当增加
MAX_HISTORY_LEN = 10       # 每个联系人保留的对话轮数（1轮 = 用户+助手各一条）

# =============================================================================

processed_ids = set()
START_TIMESTAMP = int(time.time())

# 每个会话的消息缓冲区
pending_buffers = {}
buffer_lock = threading.Lock()

# 全局锁，确保同一时间只有一个 AI 请求在处理
ai_processing_lock = threading.Lock()

# 对话历史存储：{sender: [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
chat_histories = defaultdict(list)

# 系统提示词（可自定义，但建议保持简洁中文）
SYSTEM_PROMPT = "你是一个日常聊天助手，请用简洁、自然的日常口吻回复，回复内容必须使用简体中文。除非用户明确要求详细回答，否则尽量简短。不要使用表情符号。直接返回回复内容，不要加任何额外说明。"

def build_prompt_with_history(sender, new_user_msg):
    """根据对话历史构建完整的提示词"""
    history = chat_histories.get(sender, [])
    history_text = ""
    for turn in history[-MAX_HISTORY_LEN*2:]:  # 保留最近N轮
        role = "用户" if turn["role"] == "user" else "助手"
        history_text += f"{role}：{turn['content']}\n"
    full_prompt = f"{SYSTEM_PROMPT}\n\n以下是对话历史：\n{history_text}\n用户：{new_user_msg}\n助手："
    return full_prompt

def update_history(sender, user_msg, assistant_reply):
    """更新对话历史"""
    chat_histories[sender].append({"role": "user", "content": user_msg})
    chat_histories[sender].append({"role": "assistant", "content": assistant_reply})
    if len(chat_histories[sender]) > MAX_HISTORY_LEN * 2:
        chat_histories[sender] = chat_histories[sender][-MAX_HISTORY_LEN*2:]

def get_ai_reply(sender, user_msg):
    """调用 Ollama 模型生成回复（自动携带历史）"""
    full_prompt = build_prompt_with_history(sender, user_msg)
    payload = {"model": OLLAMA_MODEL, "prompt": full_prompt, "stream": False}
    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=AI_TIMEOUT)
        if resp.status_code == 200:
            reply = resp.json().get("response", "").strip()
            if reply:
                update_history(sender, user_msg, reply)
            return reply if reply else None
        else:
            print(f"⚠️ AI 返回错误码 {resp.status_code}")
            return None
    except Exception as e:
        print(f"⚠️ AI 调用失败: {e}")
        return None

def find_chat_window(contact, exclude_window=None):
    """
    查找聊天窗口
    返回 (窗口对象, 是否为独立窗口)
    优先查找标题包含联系人名称且不是"微信"的窗口（独立窗口）
    否则返回主窗口（标题为"微信"）
    """
    all_windows = gw.getAllWindows()
    # 1. 找独立窗口
    for win in all_windows:
        if not win.visible:
            continue
        if exclude_window and win == exclude_window:
            continue
        title = win.title
        if contact in title and title != "微信":
            return win, True
    # 2. 找主窗口
    for win in all_windows:
        if win.title == "微信" and win.visible:
            return win, False
    return None, False

def send_to_wechat(contact, message):
    """智能发送：优先使用已打开的独立窗口，否则搜索并等待独立窗口出现"""
    win, is_direct = find_chat_window(contact)
    if win is None:
        print("❌ 未找到微信窗口，请确认微信已登录")
        return False

    # 激活窗口
    try:
        if win.isMinimized:
            win.restore()
        win.activate()
        time.sleep(0.3)
    except Exception as e:
        print(f"⚠️ 无法激活窗口: {e}")
        return False

    # 如果是主窗口，需要搜索联系人并等待独立窗口弹出
    if not is_direct:
        print(f"🔎 在主窗口搜索联系人: {contact}")
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
                new_win, is_direct = find_chat_window(contact, exclude_window=win)
                if new_win and is_direct:
                    break
                time.sleep(0.3)

            if new_win and is_direct:
                win = new_win
                print(f"🖼️ 已定位到独立聊天窗口: {win.title}")
                if win.isMinimized:
                    win.restore()
                win.activate()
                time.sleep(0.3)
                is_direct = True
            else:
                print("⚠️ 未检测到独立窗口，尝试在主窗口输入")
        except Exception as e:
            print(f"❌ 搜索联系人失败: {e}")
            return False

    # 输入消息（根据窗口类型调整点击坐标）
    try:
        left, top, width, height = win.left, win.top, win.width, win.height
        if is_direct:
            # 独立窗口：点击底部中央区域
            click_x = left + width // 2
            click_y = top + height - 70
            pyautogui.click(click_x, click_y)
            time.sleep(0.2)
        else:
            # 主窗口：点击输入框区域（可根据实际微调）
            click_x = left + width - 250
            click_y = top + height - 60
            pyautogui.click(click_x, click_y)
            time.sleep(0.2)
            pyautogui.click(click_x, click_y)  # 二次点击确保焦点
            time.sleep(0.1)

        # 清空输入框
        pyautogui.hotkey('ctrl', 'a')
        pyautogui.press('delete')
        time.sleep(0.1)

        # 粘贴并发送
        pyperclip.copy(message)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.2)
        pyautogui.press('enter')
        print(f"✅ 已回复 {contact}: {message[:50]}...")
        return True
    except Exception as e:
        print(f"❌ 发送失败: {e}")
        return False

def should_ignore_message(data):
    """忽略语音、表情包等非文本消息"""
    content = data.get("content", "")
    msg_type = data.get("type", 0) or data.get("msgType", 0)
    if msg_type in (34, 47):
        return True
    if content and ("[语音]" in content or "[表情]" in content):
        return True
    if not content or content.strip() == "":
        return True
    return False

def process_sender(sender):
    """
    处理指定发送者的积压消息
    使用全局锁保证同一时间只有一个 AI 请求在运行
    """
    # 取出当前需要处理的消息
    with buffer_lock:
        if sender not in pending_buffers:
            return
        entry = pending_buffers[sender]
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

    # 获取全局 AI 锁，避免多用户同时调用导致 Ollama 过载
    with ai_processing_lock:
        combined = "\n".join(messages)
        print(f"📦 合并 {len(messages)} 条消息，准备回复 {sender}")
        reply = get_ai_reply(sender, combined)
        if reply:
            print(f"🤖 AI 回复: {reply}")
            send_to_wechat(sender, reply)
        else:
            print("⚠️ AI 未返回有效回复，不发送")

    # 处理完成后，检查是否又有新消息堆积（处理过程中收到的）
    with buffer_lock:
        if sender not in pending_buffers:
            return
        entry = pending_buffers[sender]
        entry["processing"] = False
        if entry["messages"]:
            print(f"🔄 检测到 AI 处理期间的新消息，立即开始下一轮回复")
            threading.Thread(target=process_sender, args=(sender,), daemon=True).start()

def add_to_buffer(sender, content):
    """将消息加入缓冲区，重置计时器"""
    with buffer_lock:
        if sender not in pending_buffers:
            pending_buffers[sender] = {
                "messages": [],
                "timer": None,
                "processing": False
            }
        entry = pending_buffers[sender]
        entry["messages"].append(content)

        if not entry["processing"]:
            if entry["timer"]:
                entry["timer"].cancel()
            timer = threading.Timer(BUFFER_SECONDS, lambda: process_sender(sender))
            timer.daemon = True
            timer.start()
            entry["timer"] = timer

def listen_sse():
    """连接 WeFlow 的 SSE 推送，实时接收消息"""
    sse_url = f"{WE_FLOW_BASE_URL}/api/v1/push/messages?access_token={ACCESS_TOKEN}"
    print(f"🔌 正在连接 WeFlow 推送服务: {sse_url}")
    headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache"}
    try:
        response = requests.get(sse_url, headers=headers, stream=True, timeout=None)
        if response.status_code != 200:
            print(f"❌ 连接失败，状态码: {response.status_code}")
            return
        print("✅ 已连接到 WeFlow 推送服务，等待新消息...")
        print(f"⏱️ 忽略 {datetime.fromtimestamp(START_TIMESTAMP)} 之前的历史消息")
        print(f"⏲️ 消息合并缓冲时间: {BUFFER_SECONDS} 秒")
        print("💬 AI 回复风格：简洁、日常口吻、简体中文")
        print(f"🧠 每个联系人独立对话记忆，保留最近 {MAX_HISTORY_LEN} 轮")

        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            if line.startswith("event:"):
                event_type = line[6:].strip()
                if event_type == "message.revoke":
                    print("🗑️ 收到撤回消息通知")
            elif line.startswith("data:"):
                data_str = line[5:].strip()
                if not data_str:
                    continue
                try:
                    data = json.loads(data_str)
                    msg_timestamp = data.get("timestamp", 0)
                    if msg_timestamp < START_TIMESTAMP:
                        continue

                    raw_id = data.get("rawid")
                    if raw_id in processed_ids:
                        continue
                    processed_ids.add(raw_id)

                    if should_ignore_message(data):
                        continue

                    content = data.get("content", "")
                    sender = data.get("sourceName", "") or data.get("talkerName", "") or "未知"
                    if content and sender:
                        print(f"📩 收到来自 {sender} 的消息: {content[:50]}")
                        add_to_buffer(sender, content)
                except Exception:
                    pass
    except Exception as e:
        print(f"❌ SSE 连接异常: {e}")
        time.sleep(5)
        listen_sse()

if __name__ == "__main__":
    print("=" * 50)
    print(" 微信 AI ")
    print(f"WeFlow 地址: {WE_FLOW_BASE_URL}")
    print(f"模型: {OLLAMA_MODEL}")
    print("=" * 50)
    listen_sse()