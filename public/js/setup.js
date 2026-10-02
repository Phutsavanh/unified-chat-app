document.getElementById('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const password2 = document.getElementById('password2').value;
  const errorEl = document.getElementById('errorMsg');
  errorEl.textContent = '';

  if (password !== password2) {
    errorEl.textContent = 'password และยืนยัน password ไม่ตรงกัน';
    return;
  }

  try {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'สมัครไม่สำเร็จ';
      return;
    }
    window.location.href = '/';
  } catch (err) {
    errorEl.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
  }
});
