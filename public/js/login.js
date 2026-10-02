document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('errorMsg');
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'เข้าสู่ระบบไม่สำเร็จ';
      return;
    }
    window.location.href = '/';
  } catch (err) {
    errorEl.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
  }
});
