document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  errorEl.classList.add("d-none");
  btn.disabled = true;
  btn.textContent = "กำลังเข้าสู่ระบบ...";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      window.location.href = "/";
      return;
    }
    errorEl.textContent = data.error?.message || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
    errorEl.classList.remove("d-none");
  } catch {
    errorEl.textContent = "ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้";
    errorEl.classList.remove("d-none");
  } finally {
    btn.disabled = false;
    btn.textContent = "เข้าสู่ระบบ";
  }
});
