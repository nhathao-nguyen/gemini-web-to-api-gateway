document.addEventListener('DOMContentLoaded', async () => {
  const slotBadge = document.getElementById('account-slot-badge');
  const sessionStatus = document.getElementById('session-status');
  const psidStatus = document.getElementById('psid-status');
  const psidtsStatus = document.getElementById('psidts-status');
  const cookieCountEl = document.getElementById('cookie-count');
  const cookiePreview = document.getElementById('cookie-preview');
  const btnCopy = document.getElementById('btn-copy');
  const copyBtnText = document.getElementById('copy-btn-text');
  const btnOpenGemini = document.getElementById('btn-open-gemini');
  const noticeMsg = document.getElementById('notice-msg');

  let extractedCookieHeader = '';
  let detectedAuthUser = '0';

  btnOpenGemini.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://gemini.google.com/app' });
  });

  btnCopy.addEventListener('click', async () => {
    if (!extractedCookieHeader) return;
    try {
      await navigator.clipboard.writeText(extractedCookieHeader);
      btnCopy.classList.add('copied');
      copyBtnText.textContent = '✅ Đã Copy vào Clipboard!';
      setTimeout(() => {
        btnCopy.classList.remove('copied');
        copyBtnText.textContent = 'Copy Cookie Header';
      }, 2000);
    } catch (err) {
      console.error('Failed to copy cookie:', err);
      // Fallback
      cookiePreview.select();
      document.execCommand('copy');
      copyBtnText.textContent = '✅ Đã Copy!';
      setTimeout(() => {
        copyBtnText.textContent = 'Copy Cookie Header';
      }, 2000);
    }
  });

  async function scanCookies() {
    try {
      // 1. Detect current active tab URL & auth_user slot
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        const slotMatch = tab.url.match(/gemini\.google\.com\/u\/(\d+)\//);
        if (slotMatch) {
          detectedAuthUser = slotMatch[1];
        }
      }
      slotBadge.textContent = `Auth User: ${detectedAuthUser}`;

      // 2. Query cookies from both gemini.google.com and .google.com
      const geminiCookies = await chrome.cookies.getAll({ domain: 'gemini.google.com' });
      const googleCookies = await chrome.cookies.getAll({ domain: '.google.com' });

      const cookieMap = new Map();
      // Combine all cookies (gemini specific + google wide)
      for (const c of [...googleCookies, ...geminiCookies]) {
        cookieMap.set(c.name, c.value);
      }

      const totalCount = cookieMap.size;
      cookieCountEl.textContent = totalCount.toString();

      const hasPSID = cookieMap.has('__Secure-1PSID') || cookieMap.has('SID');
      const hasPSIDTS = cookieMap.has('__Secure-1PSIDTS');

      // Update PSID indicator
      if (hasPSID) {
        psidStatus.textContent = '✅ Có';
        psidStatus.className = 'status-indicator found';
      } else {
        psidStatus.textContent = '❌ Thiếu';
        psidStatus.className = 'status-indicator missing';
      }

      // Update PSIDTS indicator
      if (hasPSIDTS) {
        psidtsStatus.textContent = '✅ Có';
        psidtsStatus.className = 'status-indicator found';
      } else {
        psidtsStatus.textContent = '⚠️ Thiếu (Cần F5 Gemini)';
        psidtsStatus.className = 'status-indicator missing';
      }

      // Format full cookie header
      const parts = [];
      for (const [name, val] of cookieMap.entries()) {
        parts.push(`${name}=${val}`);
      }
      extractedCookieHeader = parts.join('; ');

      if (hasPSID && totalCount > 0) {
        sessionStatus.textContent = 'Sẵn sàng';
        sessionStatus.className = 'status-pill status-active';
        cookiePreview.value = extractedCookieHeader;
        btnCopy.disabled = false;

        if (!hasPSIDTS) {
          noticeMsg.className = 'notice notice-warning';
          noticeMsg.innerHTML = '<strong>Lưu ý:</strong> Thiếu __Secure-1PSIDTS. Hãy mở gemini.google.com và F5 để Google cấp token mới.';
        } else {
          noticeMsg.className = 'notice notice-info';
          noticeMsg.innerHTML = `Bấm <strong>Copy Cookie Header</strong> và dán vào ô Cookie trên Admin Dashboard Gateway (Auth User: <strong>${detectedAuthUser}</strong>).`;
        }
      } else {
        sessionStatus.textContent = 'Chưa đăng nhập';
        sessionStatus.className = 'status-pill status-error';
        cookiePreview.value = 'Chưa tìm thấy session Google. Hãy mở tab gemini.google.com và đăng nhập.';
        btnCopy.disabled = true;

        noticeMsg.className = 'notice notice-warning';
        noticeMsg.innerHTML = 'Chưa tìm thấy Cookie của Gemini. Hãy bấm nút <strong>Mở Gemini Web</strong> ở trên và đăng nhập Google.';
      }
    } catch (err) {
      console.error('Error scanning cookies:', err);
      sessionStatus.textContent = 'Lỗi quét';
      sessionStatus.className = 'status-pill status-error';
      noticeMsg.textContent = 'Không thể đọc cookie: ' + err.message;
    }
  }

  await scanCookies();

  // ---- Send session to desktop app via one-time capture token ----
  const portInput = document.getElementById('gateway-port');
  const btnLoadPending = document.getElementById('btn-load-pending');
  const pendingSelect = document.getElementById('pending-select');
  const btnSend = document.getElementById('btn-send');
  const sendBtnText = document.getElementById('send-btn-text');
  const sendMsg = document.getElementById('send-msg');
  let pendingSessions = [];

  try {
    const stored = await chrome.storage.local.get('gatewayPort');
    if (stored.gatewayPort) portInput.value = String(stored.gatewayPort);
  } catch {}

  function gatewayBase() {
    const port = parseInt(portInput.value, 10) || 3000;
    return `http://127.0.0.1:${port}`;
  }

  function setSendMsg(text, kind) {
    sendMsg.textContent = text;
    sendMsg.className = `notice notice-${kind || 'info'}`;
  }

  btnLoadPending.addEventListener('click', async () => {
    const port = parseInt(portInput.value, 10) || 3000;
    try { await chrome.storage.local.set({ gatewayPort: port }); } catch {}
    setSendMsg('Đang tải phiên chờ từ app...', 'info');
    btnSend.disabled = true;
    try {
      const res = await fetch(`${gatewayBase()}/internal/login-pending`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      pendingSessions = body.pending || [];
      pendingSelect.innerHTML = '';
      if (pendingSessions.length === 0) {
        pendingSelect.innerHTML = '<option value="">— Không có phiên chờ —</option>';
        setSendMsg('App chưa có phiên đăng nhập nào. Hãy bấm “Đăng nhập” trong app desktop trước.', 'warning');
        return;
      }
      for (const p of pendingSessions) {
        const opt = document.createElement('option');
        opt.value = p.sessionId;
        const minsLeft = Math.max(0, Math.round((p.expiresAt - Date.now()) / 60000));
        opt.textContent = `${p.name}${p.emailLabel ? ` (${p.emailLabel})` : ''}${p.isReLogin ? ' [relogin]' : ''} — còn ${minsLeft}p`;
        pendingSelect.appendChild(opt);
      }
      btnSend.disabled = !extractedCookieHeader;
      setSendMsg(`Tìm thấy ${pendingSessions.length} phiên chờ. Chọn phiên rồi bấm “Gửi session về app”.`, 'info');
    } catch (err) {
      setSendMsg('Không kết nối được app desktop. Kiểm tra app đang mở và đúng cổng.', 'warning');
    }
  });

  btnSend.addEventListener('click', async () => {
    const sessionId = pendingSelect.value;
    const pending = pendingSessions.find((p) => p.sessionId === sessionId);
    if (!pending) {
      setSendMsg('Hãy chọn một phiên chờ trước.', 'warning');
      return;
    }
    if (!extractedCookieHeader) {
      setSendMsg('Chưa có cookie. Hãy đăng nhập Google ở tab Gemini trước.', 'warning');
      return;
    }
    // Delivery token is issued loopback-only and bound to this session.
    btnSend.disabled = true;
    sendBtnText.textContent = 'Đang gửi...';
    try {
      const tokRes = await fetch(`${gatewayBase()}/internal/login-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const tokBody = await tokRes.json().catch(() => ({}));
      if (!tokRes.ok || !tokBody.token) {
        throw new Error(tokBody.error || `HTTP ${tokRes.status}`);
      }
      const capRes = await fetch(`${gatewayBase()}/internal/gemini-capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokBody.token, cookie: extractedCookieHeader }),
      });
      const capBody = await capRes.json().catch(() => ({}));
      if (!capRes.ok || !capBody.success) {
        throw new Error(capBody.error || `HTTP ${capRes.status}`);
      }
      setSendMsg(`✅ Đã gửi session “${pending.name}”. Quay lại app desktop để kiểm tra COMPLETED.`, 'info');
      sendBtnText.textContent = 'Đã gửi ✓';
    } catch (err) {
      setSendMsg('Gửi thất bại: ' + err.message, 'warning');
      sendBtnText.textContent = 'Gửi session về app';
      btnSend.disabled = false;
    }
  });
});
