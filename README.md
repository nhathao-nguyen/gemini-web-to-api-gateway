# Gemini Web-to-API Gateway (Desktop)

A desktop app (Electron) that pools the web quota of many `gemini.google.com` accounts into one quota pool and shares it on your LAN as standard, OpenAI-compatible REST and streaming APIs (`/v1/models`, `/v1/chat/completions`). There is **no website** — all management happens in the desktop UI, which talks to the built-in gateway via IPC.

Based on the architecture and concepts of [`ntthanh2603/gemini-web-to-api`](https://github.com/ntthanh2603/gemini-web-to-api).

---

## 🌟 Key Features

1. **OpenAI Compatibility**:
   - `GET /v1/models` - Dynamic model discovery from healthy accounts.
   - `POST /v1/chat/completions` - Full support for non-streaming and Real-time SSE streaming (`stream: true`).
   - Supports any standard OpenAI SDK (Python, Node.js, LangChain, LlamaIndex, LiteLLM).

2. **Security & Cryptography**:
   - Master Encryption Key (`MASTER_ENCRYPTION_KEY`) using **AES-256-GCM** with unique IVs for session cookies at rest.
   - Gateway API keys (`sk-gmgw-...`) stored securely as **SHA-256** hashes. Plaintext keys are generated via `crypto.randomBytes` and only returned once at creation time.
   - HttpOnly session cookies with CSRF tokens for Admin UI mutations, removing raw credentials from localStorage.
   - Strict PII & Secret Redaction: cookies, Google session tokens, and passwords are never returned in APIs, logs, or error responses.

3. **Intelligent Account Pool Scheduler**:
   - Weighted Least-Recently-Used + Health score routing:
     $$\text{score} = \text{priority} \times \text{weight} + \text{health} - \text{active\_load} - \text{recent\_errors}$$
   - Observational state transitions: `ACTIVE`, `COOLDOWN`, `QUOTA_EXHAUSTED`, `SESSION_EXPIRED`, `DISABLED`, `ERROR`.
   - Automatic failover: retries across eligible pool accounts with a maximum limit of 2 upstream attempts (no infinite loops).
   - Sticky Conversation Sessions: binds `conversation_id` to accounts with configurable TTL.

4. **Multi-Tier Rate Limiting**:
   - Per-API-key sliding-window **Requests Per Minute (RPM)**.
   - In-flight **Concurrent Request Limiter**.
   - **Daily Quota Limiter**.

5. **Observability & Desktop UI**:
   - `/health`, `/ready`, and Prometheus `/metrics`.
   - Full management UI built with React, Vite, and Tailwind CSS, running inside Electron (IPC, no website).
   - Live interactive Playground to test chat completions and streaming.

---

## 🚀 Quick Start (Desktop)

```bat
:: Windows: build the renderer + gateway and launch the desktop app
start.bat
```

Or manually:

```bash
npm install
npm run build        # renderer (dist/) + gateway bundle
npm run dev:electron # launch Electron (main + IPC + in-process gateway)
```

Data lives in the app's userData directory (SQLite `gateway.db`, `.masterkey` key file, `browser-profiles/`).
No Docker, no Postgres, no Redis — single-process by design.

By default the gateway binds to `127.0.0.1:3000` (this machine only):
- **Desktop UI**: the app window itself (no browser/URL needed)
- **OpenAI API Base URL**: `http://127.0.0.1:3000/v1`
- **Health Checks**: `http://127.0.0.1:3000/health` and `http://127.0.0.1:3000/ready`

To share the quota pool on your LAN: **Settings → Chia sẻ trong LAN → Bật**, then restart the app.
It rebinds to `0.0.0.0:3000` and LAN clients use `http://<YOUR_LAN_IP>:3000/v1` with an `sk-gmgw-...` key you create in the API Keys tab.

---

## 💻 Client Integration Examples (LAN / Remote)

Any machine inside your local network can communicate with the gateway using standard OpenAI SDKs by setting `base_url` to `http://<SERVER_LAN_IP>:3000/v1`.

### 1. Node.js / TypeScript (Official `openai` package)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.GEMINI_GATEWAY_API_KEY || 'sk-gmgw-...',
  baseURL: 'http://192.168.1.10:3000/v1', // Replace with your Server LAN IP
});

async function main() {
  const stream = await client.chat.completions.create({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Explain quantum computing in simple terms' }],
    stream: true,
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

### 2. Python (`openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-gmgw-...",
    base_url="http://192.168.1.10:3000/v1" # Replace with your Server LAN IP
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[
        {"role": "system", "content": "You are a concise engineering assistant."},
        {"role": "user", "content": "How does Raft consensus work?"}
    ]
)

print(response.choices[0].message.content)
```

### 3. cURL CLI

```bash
curl http://192.168.1.10:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gmgw-..." \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "user", "content": "Hello Gemini!"}
    ],
    "stream": false
  }'
```

---

## 🌐 Hướng Dẫn Cấu Hình Tường Lửa (Firewall Configuration)

Để các máy khác trong mạng LAN có thể kết nối tới máy chủ chạy Gateway trên cổng `3000`, bạn cần cho phép traffic Inbound TCP 3000 trên máy chủ.

> [!NOTE]
> Đây là hướng dẫn cấu hình thủ công cho quản trị viên hệ điều hành. Ứng dụng **không** tự động thay đổi cấu hình tường lửa của hệ thống.

### Windows (PowerShell với quyền Administrator)
Cho phép inbound traffic cổng 3000 chỉ trên profile mạng **Private**:
```powershell
New-NetFirewallRule -DisplayName "Gemini Web Gateway LAN (Port 3000)" `
  -Direction Inbound `
  -LocalPort 3000 `
  -Protocol TCP `
  -Action Allow `
  -Profile Private
```

### Linux (UFW - Uncomplicated Firewall)
Chỉ cho phép các thiết bị thuộc dải mạng LAN nội bộ (ví dụ `192.168.1.0/24`):
```bash
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
sudo ufw reload
```

---

## ⚠️ Cảnh Báo An Ninh: Tuyệt Đối Không Expose Trực Tiếp Ra Internet

> [!CAUTION]
> **KHÔNG port-forward cổng 3000 trực tiếp từ Router/Modem ra Internet công cộng.**
> 
> - Deployment target hiện tại của Gateway được thiết kế cho **trusted private LAN** (mạng nội bộ tin cậy).
> - Nếu muốn truy cập Gateway từ xa qua Internet, bạn **bắt buộc** phải đặt Gateway phía sau:
>   1. **VPN nội bộ** như Tailscale, WireGuard, hoặc ZeroTier.
>   2. Hoặc một **Reverse Proxy (HTTPS/TLS)** có xác thực mạnh, rate-limiting và bảo vệ DDoS.

---

## 🛡️ Cấu Hình Reverse Proxy Tùy Chọn (Optional Reverse Proxy)

Nếu bạn muốn gán tên miền nội bộ (`.lan`, `.local`) hoặc nâng cấp lên HTTPS trong mạng, bạn có thể triển khai Caddy hoặc Nginx phía trước Gateway:

### Mẫu Caddyfile (Caddy)
```caddyfile
gateway.local {
    reverse_proxy localhost:3000
}
```

### Mẫu Nginx Configuration
```nginx
server {
    listen 80;
    server_name gateway.local;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Cần thiết cho SSE streaming (/v1/chat/completions với stream: true)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_connect_timeout 60s;
    }
}
```

---

## 🔐 How to Add a Google Account (your real Chrome)

Chrome locks its cookie file while running, so no app can read it live. Pick one:

**A. Without extension (close Chrome once per login):**
1. In the desktop app: **Accounts → Browser login → Mở Chrome Đăng Nhập**.
2. The Gemini page opens **in your current Chrome**. Log in with Google / finish 2FA.
3. **Quit Chrome completely** (including the tray icon), back in the app click
   **Đã Đăng Nhập Xong — Xác Nhận**. The app copies your profile cookies to a temp dir,
   reads the Google session via a throwaway headless copy over CDP, then deletes it.
4. The session flips to COMPLETED and the account joins the quota pool.

**B. Without closing Chrome (one-click extension):**
1. One-time setup: `chrome://extensions` → Developer mode → **Load unpacked** →
   select the `extension/` folder.
2. After logging in, click the **“Gemini Gateway”** icon → **Tải phiên chờ** →
   pick the session → **Gửi session về app** (localhost, one-time token).

**C. Fallbacks:** **Dùng cửa sổ app** (isolated in-app login window, auto-detect) or
**Add Account** with a manually pasted cookie:
   ```text
   __Secure-1PSID=xxxx; __Secure-1PSIDTS=yyyy
   ```

Then click **Test Session** to verify the upstream handshake and initialize the pool.

