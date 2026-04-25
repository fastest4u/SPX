export function buildLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="th" data-bs-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SPX Bidding — Login</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>
  body{min-height:100vh;background:radial-gradient(circle at top,#1a2540 0,#0b1020 45%,#050816 100%);color:#e5e7eb;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;padding:24px}
  .card{max-width:440px;width:100%;background:rgba(17,24,45,.9);border:1px solid rgba(148,163,184,.16);border-radius:24px;box-shadow:0 24px 80px rgba(0,0,0,.45);backdrop-filter:blur(16px)}
  .form-control{background:rgba(8,13,28,.88);border-color:rgba(148,163,184,.18);color:#fff}.form-control:focus{background:#0b1223;color:#fff;border-color:rgba(125,211,252,.55);box-shadow:0 0 0 .18rem rgba(125,211,252,.14)}
</style>
</head>
<body>
  <div class="card p-4 p-md-5">
    <div class="mb-4">
      <div class="text-uppercase text-secondary small" style="letter-spacing:.18em">Secure access</div>
      <h1 class="h3 fw-bold mt-2 mb-2">SPX Control Center</h1>
      <p class="text-secondary mb-0">เข้าสู่ระบบเพื่อจัดการการค้นหา, รายงาน, settings และ audit log</p>
    </div>
    <form method="post" action="/api/login">
      <div class="mb-3">
        <label class="form-label text-secondary">Username</label>
        <input class="form-control form-control-lg" name="username" autocomplete="username" required>
      </div>
      <div class="mb-4">
        <label class="form-label text-secondary">Password</label>
        <input class="form-control form-control-lg" type="password" name="password" autocomplete="current-password" required>
      </div>
      <button class="btn btn-primary btn-lg w-100 fw-semibold" type="submit">เข้าสู่ระบบ</button>
    </form>
  </div>
</body>
</html>`;
}
