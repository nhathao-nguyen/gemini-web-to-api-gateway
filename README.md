# Gemini Web-to-API Gateway

A production-grade gateway server that transforms operator-provided `gemini.google.com` browser sessions into standard, OpenAI-compatible REST and streaming APIs (`/v1/models`, `/v1/chat/completions`).

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

5. **Observability & Admin UI**:
   - `/health`, `/ready`, and Prometheus `/metrics`.
   - Full Admin Dashboard built with React, Vite, and Tailwind CSS.
   - Live interactive Playground to test chat completions and streaming.

---

## 🚀 Quick Start with Docker Compose

```bash
# Clone the repository
git clone https://github.com/example/gemini-web-to-api.git
cd gemini-web-to-api

# Configure environment variables
cp .env.example .env

# Build and start services (gateway, isolated postgresql, and isolated redis)
docker compose build
docker compose up -d
```

The gateway binds to `0.0.0.0:3000` and will be accessible across your local machine and LAN:
- **Web Admin Dashboard**: `http://localhost:3000` or `http://<SERVER_LAN_IP>:3000`
- **OpenAI API Base URL**: `http://localhost:3000/v1` or `http://<SERVER_LAN_IP>:3000/v1`
- **Health Checks**: `http://<SERVER_LAN_IP>:3000/health` and `http://<SERVER_LAN_IP>:3000/ready`
- **Metrics**: `http://<SERVER_LAN_IP>:3000/metrics`

*(PostgreSQL and Redis are strictly internal to the Docker bridge network and not exposed to the host/LAN).*

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

## 🔐 How to Obtain Gemini Web Cookies

1. Open your browser and log into [gemini.google.com](https://gemini.google.com).
2. Press `F12` to open Developer Tools, then navigate to the **Application** (or **Storage**) tab.
3. Under **Cookies** -> `https://gemini.google.com`, copy the values of:
   - `__Secure-1PSID`
   - `__Secure-1PSIDTS`
   - (Optional) `__Secure-1PSIDCC`
4. In the Gateway Admin Dashboard (**Accounts** tab), click **Add Account**, paste the cookie string, e.g.:
   ```text
   __Secure-1PSID=xxxx; __Secure-1PSIDTS=yyyy
   ```
5. Click **Test Session** to verify the upstream handshake and initialize the pool.

