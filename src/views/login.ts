export function buildLoginHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="th" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>SPX Bidding — Login</title>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style>
  :root {
    color-scheme: dark;
    --spx-bg: #020617;
    --spx-surface: rgba(15, 23, 42, .78);
    --spx-surface-strong: rgba(15, 23, 42, .92);
    --spx-border: rgba(255,255,255,.1);
    --spx-border-soft: rgba(255,255,255,.08);
    --spx-text: #e5e7eb;
    --spx-muted: #94a3b8;
  }
  html[data-theme="light"] {
    color-scheme: light;
    --spx-bg: #f8fafc;
    --spx-surface: rgba(255,255,255,.84);
    --spx-surface-strong: rgba(255,255,255,.95);
    --spx-border: rgba(15,23,42,.12);
    --spx-border-soft: rgba(15,23,42,.08);
    --spx-text: #0f172a;
    --spx-muted: #475569;
  }
  body {
    min-height: 100vh;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background:
      radial-gradient(circle at top, rgba(34, 211, 238, 0.14), transparent 30%),
      radial-gradient(circle at 82% 18%, rgba(168, 85, 247, 0.14), transparent 24%),
      linear-gradient(180deg, var(--spx-bg) 0%, color-mix(in srgb, var(--spx-bg) 84%, #0f172a 16%) 45%, var(--spx-bg) 100%);
  }
</style>
</head>
<body class="antialiased text-slate-100">
  <main class="mx-auto grid min-h-screen w-full max-w-6xl place-items-center px-4 py-8 sm:px-6 lg:px-8">
    <section class="grid w-full overflow-hidden rounded-[2rem] border border-[var(--spx-border)] bg-[var(--spx-surface)] shadow-[0_30px_120px_rgba(2,6,23,.72)] backdrop-blur-xl lg:grid-cols-[1.08fr_.92fr]">
      <div class="relative flex flex-col justify-between border-b border-[var(--spx-border)] bg-[var(--spx-surface-strong)] p-8 sm:p-10 lg:border-b-0 lg:border-r">
        <div class="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,.15),transparent_35%),radial-gradient(circle_at_bottom_left,rgba(168,85,247,.14),transparent_28%)]"></div>
        <div>
          <div class="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200">
            Secure access
          </div>
          <h1 class="mt-6 text-3xl font-black tracking-tight text-white sm:text-4xl">SPX Control Center</h1>
          <p class="mt-4 max-w-xl text-sm leading-6 text-slate-300 sm:text-base">เข้าสู่ระบบเพื่อจัดการการค้นหา, รายงาน, settings และ audit log ภายใต้ design language เดียวกันกับ dashboard</p>
        </div>

        <div class="mt-10 grid gap-3 sm:grid-cols-3">
          <div class="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div class="text-xs uppercase tracking-[0.2em] text-slate-400">Theme</div>
            <div class="mt-2 text-lg font-semibold text-white">Unified</div>
            <p class="mt-1 text-sm text-slate-400">Same visual system</p>
          </div>
          <div class="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div class="text-xs uppercase tracking-[0.2em] text-slate-400">CSS</div>
            <div class="mt-2 text-lg font-semibold text-white">Tailwind v4.1</div>
            <p class="mt-1 text-sm text-slate-400">Utility-first styling</p>
          </div>
          <div class="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div class="text-xs uppercase tracking-[0.2em] text-slate-400">UI</div>
            <div class="mt-2 text-lg font-semibold text-white">Custom</div>
            <p class="mt-1 text-sm text-slate-400">Handcrafted template</p>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-center p-8 sm:p-10">
        <div class="w-full max-w-md rounded-[1.75rem] border border-[var(--spx-border)] bg-[var(--spx-surface-strong)] p-6 shadow-2xl sm:p-8">
          <div class="mb-6 flex items-center justify-end gap-2">
            <button class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white" id="theme-toggle" type="button">Theme</button>
          </div>
          <div class="mb-8">
            <h2 class="text-2xl font-bold tracking-tight text-white">Sign in</h2>
            <p class="mt-2 text-sm leading-6 text-slate-400">ใช้บัญชีที่มีสิทธิ์เข้าถึงระบบ เพื่อเปิดหน้าจัดการข้อมูลและ datagrid ภายใน</p>
          </div>

          <div id="login-error" class="mb-5 hidden rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100" role="alert" aria-live="assertive"></div>

          <form id="login-form" method="post" action="/api/login" class="space-y-5">
            <label class="block">
              <span class="mb-2 block text-sm font-medium text-slate-300">Username</span>
              <input id="login-username" name="username" autocomplete="username" required class="block w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40 focus:bg-white/8 focus:ring-4 focus:ring-cyan-400/10" placeholder="your.username">
            </label>

            <label class="block">
              <span class="mb-2 block text-sm font-medium text-slate-300">Password</span>
              <input id="login-password" type="password" name="password" autocomplete="current-password" required class="block w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40 focus:bg-white/8 focus:ring-4 focus:ring-cyan-400/10" placeholder="••••••••••••">
            </label>

            <button id="login-btn" type="submit" class="group inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-500 via-sky-500 to-indigo-500 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 transition hover:brightness-110 focus:outline-none focus:ring-4 focus:ring-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-70">
              <span>เข้าสู่ระบบ</span>
              <span aria-hidden="true" class="transition group-hover:translate-x-0.5">→</span>
            </button>
          </form>
        </div>
      </div>
    </section>
  </main>
<script src="/assets/login.js"></script>
</body>
</html>`;
}
