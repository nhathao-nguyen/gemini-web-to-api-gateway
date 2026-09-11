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
});
