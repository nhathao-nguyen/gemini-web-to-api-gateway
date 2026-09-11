# Gemini Cookie & Session Extractor (Chrome Extension)

Extension tiện ích nhẹ giúp trích xuất toàn bộ cookie và slot tài khoản (`auth_user`) từ `gemini.google.com` chỉ với **1 cú click**, sẵn sàng dùng cho **Gemini Web To API Gateway**.

---

## 🚀 Hướng dẫn cài đặt vào trình duyệt (Chrome, Edge, Brave, Cốc Cốc)

1. Mở trình duyệt Chrome / Edge và truy cập:
   ```text
   chrome://extensions
   ```
   *(Trên Edge: `edge://extensions`)*

2. Bật công tắc **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên bên phải.

3. Nhấp vào nút **Tải tiện ích đã giải nén (Load unpacked)** ở góc trên bên trái.

4. Chọn thư mục:
   ```text
   d:\nhathao\AI\gemini-web-to-api-gateway\extension
   ```

5. Xong! Biểu tượng tiện ích **Gemini Extractor** sẽ xuất hiện trên thanh công cụ của trình duyệt (bạn có thể ghim nó lên thanh taskbar để tiện sử dụng).

---

## ⚡ Cách sử dụng

1. Mở tab truy cập vào [gemini.google.com](https://gemini.google.com) (đã đăng nhập tài khoản Google).
2. Bấm vào biểu tượng **Gemini Extractor** trên thanh tiện ích của trình duyệt.
3. Extension sẽ tự động:
   * Quét toàn bộ cookies cần thiết (`__Secure-1PSID`, `__Secure-1PSIDTS`, `NID`,...).
   * Tự động nhận diện Google Account Slot (`auth_user`: `0`, `1`, hoặc `2`).
4. Bấm nút **Copy Cookie Header**.
5. Mở Dashboard Gateway tại `http://localhost:3000` ➔ Tab **Gemini Accounts** ➔ **Add Account**:
   * Dán cookie vừa copy vào ô **Cookie**.
   * Nhập số `auth_user` tương ứng mà Extension hiển thị (thường là `0`).
   * Bấm **Test Session** để hoàn tất!
