const form = document.getElementById("login-form");
const errorEl = document.getElementById("login-error");
const btn = document.getElementById("login-btn");
const themeKey = "spx-theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.textContent = theme === "light" ? "Dark" : "Light";
}

applyTheme(localStorage.getItem(themeKey) || document.documentElement.dataset.theme || "dark");

document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem(themeKey, next);
  applyTheme(next);
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const username = document.getElementById("login-username")?.value.trim() ?? "";
  const password = document.getElementById("login-password")?.value ?? "";

  errorEl.textContent = "";
  errorEl.classList.add("hidden");
  btn.disabled = true;
  btn.innerHTML = '<span>กำลังเข้าสู่ระบบ...</span><span aria-hidden="true" class="animate-spin">↻</span>';

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok && data.ok) {
      window.location.href = "/";
      return;
    }

    errorEl.textContent = data.error?.message || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
    errorEl.classList.remove("hidden");
  } catch {
    errorEl.textContent = "ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้";
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>เข้าสู่ระบบ</span><span aria-hidden="true">→</span>';
  }
});
