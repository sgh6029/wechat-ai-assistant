import json
import time
import requests
import pyautogui
import pyperclip
import pygetwindow as gw
import threading
from datetime import datetime

# ====================== 配置 ======================
WE_FLOW_BASE_URL = "http://127.0.0.1:5031"
ACCESS_TOKEN = "efab5b62647d8ffee550c45579a29feb"
OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
OLLAMA_MODEL = "qwen3.5:2b-q4_K_M"
BUFFER_SECONDS = 40  # 缓冲时间（秒）
# =================================================

processed_ids = set()
START_TIMESTAMP = int(time.time())

pending_buffers = {}
buffer_lock = threading.Lock()

SYSTEM_PROMPT = "你是一个日常聊天助手，请用简洁、自然的日常口吻回复，回复内容必须使用简体中文。除非用户明确要求详细回答，否则尽量简短。不要使用表情符号。直接返回回复内容，不要加任何额外说明。"

def get_ai_reply(user_msg):
    full_prompt = f"{SYSTEM_PROMPT}\n\n用户消息：{user_msg}\n\n回复："
    payload = {"model": OLLAMA_MODEL, "prompt": full_prompt, "stream": False}
    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=60)
        if resp.status_code == 200:
            reply = resp.json().get("response", "").strip()
            return reply if reply else None
        else:
            print(f"⚠️ AI 返回错误码 {resp.status_code}")
            return None
    except Exception as e:
        print(f"⚠️ AI 调用失败: {e}")
        return None

def send_to_wechat(contact, message):
    """智能发送：支持主窗口和独立聊天窗口"""
    wechat_window = None
    contact_in_title = False

    all_windows = gw.getAllWindows()
    
    # 1. 优先找主窗口
    for win in all_windows:
        if win.title == "微信" and win.visible:
            wechat_window = win
            print("📱 已定位到微信主窗口")
            break

    # 2. 找不到主窗口就找独立聊天窗口（标题包含联系人和微信）
    if wechat_window is None:
        for win in all_windows:
            if "微信" in win.title and contact in win.title and win.visible:
                wechat_window = win
                contact_in_title = True
                print(f"🖼️ 已定位到独立聊天窗口: {win.title}")
                break

    if wechat_window is None:
        print("❌ 未找到可用的微信窗口，请确认微信已登录且未被最小化")
        return False

    # 激活窗口
    try:
        if wechat_window.isMinimized:
            wechat_window.restore()
        wechat_window.activate()
        time.sleep(0.3)
    except Exception as e:
        print(f"⚠️ 无法激活窗口: {e}")
        return False

    # 主窗口需要搜索联系人
    if not contact_in_title:
        print(f"🔎 在主窗口搜索联系人: {contact}")
        try:
            pyautogui.hotkey('ctrl', 'f')
            time.sleep(0.3)
            pyautogui.hotkey('ctrl', 'a')
            pyautogui.press('delete')
            time.sleep(0.1)
            pyperclip.copy(contact)
            pyautogui.hotkey('ctrl', 'v')
            time.sleep(0.8)
            pyautogui.press('enter')
            time.sleep(0.8)
        except Exception as e:
            print(f"❌ 搜索联系人失败: {e}")
            return False
    else:
        print(f"💬 直接在独立窗口输入")

    # 输入并发送
    try:
        # 点击输入区域确保焦点
        try:
            rect = wechat_window.box
            input_x = rect.left + rect.width - 200
            input_y = rect.bottom - 50
            original_pos = pyautogui.position()
            pyautogui.click(input_x, input_y)
            time.sleep(0.2)
            pyautogui.moveTo(original_pos.x, original_pos.y)
        except:
            pass

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

def flush_buffer(sender):
    """合并消息并调用AI回复"""
    with buffer_lock:
        if sender not in pending_buffers:
            return
        entry = pending_buffers[sender]
        if entry["timer"]:
            entry["timer"].cancel()
        messages = entry["messages"]
        del pending_buffers[sender]
    
    if not messages:
        return
    
    combined = "\n".join(messages)
    print(f"📦 合并 {len(messages)} 条消息，准备回复 {sender}")
    reply = get_ai_reply(combined)
    if reply:
        print(f"🤖 AI 回复: {reply}")
        send_to_wechat(sender, reply)
    else:
        print("⚠️ AI 未返回有效回复，不发送")

def add_to_buffer(sender, content):
    """将消息加入缓冲，重置计时器"""
    with buffer_lock:
        if sender not in pending_buffers:
            pending_buffers[sender] = {
                "messages": [],
                "timer": None,
                "first_time": time.time()
            }
        entry = pending_buffers[sender]
        entry["messages"].append(content)
        
        if entry["timer"]:
            entry["timer"].cancel()
        
        timer = threading.Timer(BUFFER_SECONDS, lambda: flush_buffer(sender))
        timer.daemon = True
        timer.start()
        entry["timer"] = timer

def listen_sse():
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
                        print(f"⏭️ 忽略历史消息 (时间戳 {msg_timestamp})")
                        continue

                    raw_id = data.get("rawid")
                    if raw_id in processed_ids:
                        continue
                    processed_ids.add(raw_id)

                    if should_ignore_message(data):
                        print(f"⏭️ 忽略非文本消息 (type={data.get('type')}, content={data.get('content','')[:20]})")
                        continue

                    content = data.get("content", "")
                    sender = data.get("sourceName", "") or data.get("talkerName", "") or "未知"
                    if content and sender:
                        print(f"📩 收到来自 {sender} 的消息: {content[:50]}")
                        add_to_buffer(sender, content)
                except json.JSONDecodeError:
                    print(f"⚠️ 无法解析数据: {data_str}")
    except Exception as e:
        print(f"❌ SSE 连接异常: {e}")
        time.sleep(5)
        listen_sse()

if __name__ == "__main__":
    print("=" * 50)
    print("🤖 微信 AI 助手 (最终完整版)")
    print(f"WeFlow 地址: {WE_FLOW_BASE_URL}")
    print(f"模型: {OLLAMA_MODEL}")
    print("=" * 50)
    listen_sse()