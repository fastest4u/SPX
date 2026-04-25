const API = `${window.location.origin}/api`;
const METRICS_URL = `${window.location.origin}/metrics`;
const EVENTS_URL = `${window.location.origin}/events`;
const MIN_PASSWORD_LENGTH = 12;
const CHART_MAX_POINTS = 60;
const SSE_RECONNECT_MS = 5000;
const FALLBACK_POLL_MS = 30000;

let rulesDt;
let historyDt;
let auditDt;
let usersDt;
let pendingDeleteRuleId = null;
let pendingAcceptBookingId = null;
let pendingAcceptRequestIds = null;
let latencyChart = null;
let successChart = null;
let eventSource = null;
let sseReconnectTimer = null;

function escapeHtml(value) {
  return String(value ?? "-").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function showToast(message, isError = false) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast align-items-center ${isError ? "text-bg-danger" : "text-bg-success"} border-0 show mb-2`;
  toast.setAttribute("role", "alert");

  const wrapper = document.createElement("div");
  wrapper.className = "d-flex";

  const body = document.createElement("div");
  body.className = "toast-body";
  body.textContent = message;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn-close btn-close-white me-2 m-auto";
  close.setAttribute("aria-label", "Close");
  close.setAttribute("data-bs-dismiss", "toast");
  close.addEventListener("click", () => toast.remove());

  wrapper.append(body, close);
  toast.append(wrapper);
  container.append(toast);
  setTimeout(() => toast.remove(), 3000);
}

function handleFetchError(error) {
  if (error?.status === 401) window.location.reload();
  else showToast("เกิดข้อผิดพลาดในการเชื่อมต่อ", true);
}

function splitCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function formatArray(values) {
  return Array.isArray(values) && values.length > 0 ? values.map(escapeHtml).join(", ") : "-";
}

function updateStats(_event, _settings, json) {
  if (!Array.isArray(json)) return;
  const active = json.filter((rule) => rule.enabled && !rule.fulfilled).length;
  const done = json.filter((rule) => rule.fulfilled).length;
  const off = json.filter((rule) => !rule.enabled).length;
  document.getElementById("stats").innerHTML = `<span class="badge badge-soft me-1">${active} รอ</span><span class="badge badge-soft me-1">${done} ครบ</span><span class="badge badge-soft">${off} ปิด</span>`;
  document.getElementById("kpi-active").textContent = String(active);
  document.getElementById("kpi-done").textContent = String(done);
  document.getElementById("kpi-off").textContent = String(off);
  document.getElementById("kpi-status").textContent = "Healthy";
  document.getElementById("kpi-status-hint").textContent = "ดึงข้อมูล rule ได้ปกติ";
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function renderMetrics(data) {
  if (!data) return;
  document.getElementById("metric-uptime").textContent = formatDuration(data.uptime);
  document.getElementById("metric-success-rate").textContent = `${data.polling?.successRate ?? 0}%`;
  document.getElementById("metric-p95").textContent = `${data.polling?.latency?.p95 ?? 0} ms`;
  document.getElementById("metric-last-poll").textContent = data.lastPoll?.timestamp ? new Date(data.lastPoll.timestamp).toLocaleTimeString("th-TH") : "—";
  document.getElementById("metric-last-status").textContent = `สถานะล่าสุด: ${data.lastPoll?.status ?? "unknown"}`;
}

function historyQuery() {
  return {
    limit: 200,
    search: document.getElementById("history-search").value.trim() || undefined,
    origin: document.getElementById("history-origin").value.trim() || undefined,
    destination: document.getElementById("history-destination").value.trim() || undefined,
    vehicleType: document.getElementById("history-vehicle").value.trim() || undefined,
    sortBy: "created_at",
    sortDir: "desc",
  };
}

function auditQuery() {
  return {
    limit: 200,
    search: document.getElementById("audit-search").value.trim() || undefined,
    username: document.getElementById("audit-username").value.trim() || undefined,
    action: document.getElementById("audit-action").value.trim() || undefined,
    sortBy: "created_at",
    sortDir: "desc",
  };
}

function refreshHistory() {
  historyDt.ajax.url(`${API}/history?${new URLSearchParams(historyQuery())}`).load();
}

function refreshAudit() {
  auditDt.ajax.url(`${API}/audit-logs?${new URLSearchParams(auditQuery())}`).load();
}

function resetHistoryFilters() {
  document.getElementById("history-search").value = "";
  document.getElementById("history-origin").value = "";
  document.getElementById("history-destination").value = "";
  document.getElementById("history-vehicle").value = "";
  refreshHistory();
}

function resetAuditFilters() {
  document.getElementById("audit-search").value = "";
  document.getElementById("audit-username").value = "";
  document.getElementById("audit-action").value = "";
  refreshAudit();
}

function ruleById(id) {
  return rulesDt.rows().data().toArray().find((rule) => String(rule.id) === String(id));
}

function renderRuleActions(row) {
  const id = escapeAttribute(row.id);
  const toggleLabel = row.enabled ? "ปิด" : "เปิด";
  const toggleClass = row.enabled ? "btn-outline-warning" : "btn-outline-primary";
  return [
    `<button type="button" class="btn btn-sm btn-outline-light me-1 mb-1" data-action="edit-rule" data-rule-id="${id}">แก้ไข</button>`,
    `<button type="button" class="btn btn-sm btn-outline-success me-1 mb-1" data-action="preview-rule" data-rule-id="${id}">Preview</button>`,
    `<button type="button" class="btn btn-sm ${toggleClass} me-1 mb-1" data-action="toggle-rule" data-rule-id="${id}">${toggleLabel}</button>`,
    `<button type="button" class="btn btn-sm btn-outline-danger mb-1" data-action="delete-rule" data-rule-id="${id}">ลบ</button>`,
  ].join("");
}

function renderAcceptAction(row) {
  if (!row.bookingId || !row.requestId) return '<span class="text-muted">—</span>';
  const bid = escapeAttribute(row.bookingId);
  const rid = escapeAttribute(row.requestId);
  return `<button type="button" class="btn btn-sm btn-outline-success" data-action="accept-job" data-booking-id="${bid}" data-request-id="${rid}">รับงาน</button>`;
}

function initTables() {
  rulesDt = $("#rulesTable").DataTable({
    responsive: true,
    ajax: { url: `${API}/rules`, dataSrc: "", error: handleFetchError },
    order: [],
    columns: [
      { data: null, render: (rule) => !rule.enabled ? '<span class="badge bg-secondary">ปิดอยู่</span>' : rule.fulfilled ? '<span class="badge bg-success text-dark">ครบแล้ว</span>' : '<span class="badge bg-primary">กำลังค้นหา</span>' },
      { data: "name", render: (value) => `<strong>${escapeHtml(value)}</strong>` },
      { data: "origins", render: formatArray },
      { data: "destinations", render: formatArray },
      { data: "vehicle_types", render: formatArray },
      { data: "need", render: (value) => `${Number(value) || 1} คัน` },
      { data: null, orderable: false, render: renderRuleActions },
    ],
  });

  historyDt = $("#historyTable").DataTable({
    responsive: true,
    ajax: { url: `${API}/history?${new URLSearchParams(historyQuery())}`, dataSrc: "", error: handleFetchError },
    order: [[6, "desc"]],
    columns: [
      { data: "requestId" },
      { data: "bookingId", render: (value) => value || "-" },
      { data: "origin", render: escapeHtml },
      { data: "destination", render: escapeHtml },
      { data: "vehicleType", render: escapeHtml },
      { data: "standbyDateTime", render: escapeHtml },
      { data: "createdAt", render: (value) => value ? new Date(value).toLocaleString("th-TH") : "-" },
      { data: null, orderable: false, render: renderAcceptAction },
    ],
  });

  auditDt = $("#auditTable").DataTable({
    responsive: true,
    ajax: { url: `${API}/audit-logs?${new URLSearchParams(auditQuery())}`, dataSrc: "", error: handleFetchError },
    order: [[4, "desc"]],
    columns: [
      { data: "id" },
      { data: "username", render: (value) => `<span class="badge bg-info text-dark">${escapeHtml(value)}</span>` },
      { data: "action", render: escapeHtml },
      { data: "details", render: escapeHtml },
      { data: "createdAt", render: (value) => value ? new Date(value).toLocaleString("th-TH") : "-" },
    ],
  });

  usersDt = $("#usersTable").DataTable({
    responsive: true,
    ajax: { url: `${API}/users`, dataSrc: "", error: handleFetchError },
    columns: [
      { data: "id" },
      { data: "username", render: escapeHtml },
      { data: "role", render: escapeHtml },
      { data: "createdAt", render: (value) => value ? new Date(value).toLocaleString("th-TH") : "-" },
      { data: null, orderable: false, render: (row) => `<button type="button" class="btn btn-sm btn-outline-warning" data-action="change-password" data-user-id="${escapeAttribute(row.id)}">เปลี่ยนรหัสผ่าน</button>` },
    ],
  });

  $("#rulesTable").on("xhr.dt", updateStats);
}

async function loadMetrics() {
  try {
    const res = await fetch(METRICS_URL);
    if (!res.ok) throw new Error("Failed");
    const data = await res.json();
    renderMetrics(data);
    pushChartData(data);
  } catch {
    showToast("ไม่สามารถโหลด metrics ได้", true);
  }
}

function resetRuleForm() {
  document.getElementById("rule-id").value = "";
  document.getElementById("f-name").value = "";
  document.getElementById("f-origins").value = "";
  document.getElementById("f-destinations").value = "";
  document.getElementById("f-vehicle").value = "";
  document.getElementById("f-need").value = "1";
  document.getElementById("f-enabled").value = "true";
}

function openEditRule(id) {
  const row = ruleById(id);
  if (!row) return;
  document.getElementById("rule-id").value = row.id;
  document.getElementById("f-name").value = row.name || "";
  document.getElementById("f-origins").value = (row.origins || []).join(", ");
  document.getElementById("f-destinations").value = (row.destinations || []).join(", ");
  document.getElementById("f-vehicle").value = (row.vehicle_types || []).join(", ");
  document.getElementById("f-need").value = row.need || 1;
  document.getElementById("f-enabled").value = String(Boolean(row.enabled));
  bootstrap.Modal.getOrCreateInstance(document.getElementById("addRuleModal")).show();
}

async function saveRule() {
  const id = document.getElementById("rule-id").value;
  const payload = {
    name: document.getElementById("f-name").value.trim(),
    origins: splitCsv(document.getElementById("f-origins").value),
    destinations: splitCsv(document.getElementById("f-destinations").value),
    vehicle_types: splitCsv(document.getElementById("f-vehicle").value),
    need: Number.parseInt(document.getElementById("f-need").value, 10) || 1,
    enabled: document.getElementById("f-enabled").value === "true",
  };
  const method = id === "" ? "POST" : "PUT";
  const url = id === "" ? `${API}/rules` : `${API}/rules/${encodeURIComponent(id)}`;
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) {
    showToast("บันทึก rule ไม่สำเร็จ", true);
    return;
  }
  bootstrap.Modal.getOrCreateInstance(document.getElementById("addRuleModal")).hide();
  resetRuleForm();
  showToast("บันทึก rule แล้ว");
  rulesDt.ajax.reload(null, false);
}

function previewRule(id) {
  const row = ruleById(id);
  if (!row) return;
  const payload = { rule: row, preview: `Rule "${row.name}" จะจับคู่เมื่อ origin/destination/vehicle ตรงตามเงื่อนไข` };
  document.getElementById("notification-preview").textContent = JSON.stringify(payload, null, 2);
  document.getElementById("notifications-tab").click();
}

async function updateRule(id, data, message) {
  try {
    const row = ruleById(id);
    if (!row) throw new Error("Missing rule");
    const { id: _ruleId, ...ruleValues } = row;
    const payload = { ...ruleValues, ...data };
    const res = await fetch(`${API}/rules/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error("Failed");
    showToast(message);
    rulesDt.ajax.reload(null, false);
  } catch {
    showToast("เกิดข้อผิดพลาด", true);
  }
}

function requestDeleteRule(id) {
  pendingDeleteRuleId = id;
  bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmDeleteModal")).show();
}

async function confirmDeleteRule() {
  if (!pendingDeleteRuleId) return;
  try {
    const res = await fetch(`${API}/rules/${encodeURIComponent(pendingDeleteRuleId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed");
    showToast("ลบรายการแล้ว");
    rulesDt.ajax.reload(null, false);
    auditDt?.ajax.reload(null, false);
  } catch {
    showToast("เกิดข้อผิดพลาด", true);
  } finally {
    pendingDeleteRuleId = null;
    bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmDeleteModal")).hide();
  }
}

async function addUser() {
  const username = document.getElementById("u-username").value.trim();
  const password = document.getElementById("u-password").value.trim();
  const role = document.getElementById("u-role").value;
  if (!username || !password) {
    showToast("กรุณากรอกข้อมูลให้ครบถ้วน", true);
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    showToast(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`, true);
    return;
  }
  try {
    const res = await fetch(`${API}/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, role }) });
    if (!res.ok) throw new Error("Failed");
    document.querySelectorAll("#addUserModal input").forEach((input) => { input.value = ""; });
    bootstrap.Modal.getOrCreateInstance(document.getElementById("addUserModal")).hide();
    showToast("เพิ่มผู้ใช้งานสำเร็จ");
    usersDt.ajax.reload(null, false);
  } catch {
    showToast("เกิดข้อผิดพลาด หรือชื่อผู้ใช้ซ้ำ", true);
  }
}

function openChangePassword(id) {
  document.getElementById("pwd-user-id").value = id;
  document.getElementById("pwd-new").value = "";
  bootstrap.Modal.getOrCreateInstance(document.getElementById("changePasswordModal")).show();
}

async function changePassword() {
  const id = document.getElementById("pwd-user-id").value;
  const password = document.getElementById("pwd-new").value.trim();
  if (password.length < MIN_PASSWORD_LENGTH) {
    showToast(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`, true);
    return;
  }
  try {
    const res = await fetch(`${API}/users/${encodeURIComponent(id)}/password`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (!res.ok) throw new Error("Failed");
    bootstrap.Modal.getOrCreateInstance(document.getElementById("changePasswordModal")).hide();
    showToast("เปลี่ยนรหัสผ่านสำเร็จ");
  } catch {
    showToast("เกิดข้อผิดพลาด", true);
  }
}

async function downloadReport(path, filename) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    showToast("ดาวน์โหลดรายงานไม่สำเร็จ", true);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function previewNotification() {
  const res = await fetch(`${API}/notifications/preview`, { method: "POST" });
  document.getElementById("notification-preview").textContent = JSON.stringify(await res.json(), null, 2);
}

async function testNotification() {
  const res = await fetch(`${API}/notifications/test`, { method: "POST" });
  document.getElementById("notification-preview").textContent = JSON.stringify(await res.json(), null, 2);
}

async function saveSettings(event) {
  event.preventDefault();
  const data = {
    API_URL: document.getElementById("s-api-url").value.trim(),
    COOKIE: document.getElementById("s-cookie").value.trim(),
    DEVICE_ID: document.getElementById("s-device-id").value.trim(),
    LINE_NOTIFY_TOKEN: document.getElementById("s-line-token").value.trim(),
    DISCORD_WEBHOOK_URL: document.getElementById("s-discord-url").value.trim(),
    POLL_INTERVAL_MS: document.getElementById("s-poll-interval").value.trim(),
  };
  const res = await fetch(`${API}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!res.ok) {
    showToast("เกิดข้อผิดพลาดในการบันทึกการตั้งค่า", true);
    return;
  }
  showToast("บันทึกการตั้งค่าแล้ว เซิร์ฟเวอร์กำลังรีสตาร์ทตัวเอง...");
  setTimeout(() => window.location.reload(), 4000);
}

async function loadSettings() {
  try {
    const res = await fetch(`${API}/settings`);
    if (!res.ok) return;
    const settings = await res.json();
    document.getElementById("s-api-url").value = settings.API_URL || "";
    document.getElementById("s-cookie").value = settings.COOKIE || "";
    document.getElementById("s-device-id").value = settings.DEVICE_ID || "";
    document.getElementById("s-line-token").value = settings.LINE_NOTIFY_TOKEN || "";
    document.getElementById("s-discord-url").value = settings.DISCORD_WEBHOOK_URL || "";
    document.getElementById("s-poll-interval").value = settings.POLL_INTERVAL_MS || "30000";
  } catch {
    showToast("ไม่สามารถโหลด settings ได้", true);
  }
}

async function logout() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  await fetch(`${API}/logout`, { method: "POST" });
  window.location.reload();
}

// --- SSE Connection ---
function setSseStatus(state) {
  const dot = document.getElementById("sse-dot");
  const label = document.getElementById("sse-label");
  if (!dot || !label) return;
  dot.className = `sse-dot ${state}`;
  if (state === "connected") label.textContent = "live";
  else if (state === "connecting") label.textContent = "connecting...";
  else label.textContent = "offline";
}

function connectSse() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }

  setSseStatus("connecting");
  eventSource = new EventSource(EVENTS_URL);

  eventSource.onopen = () => setSseStatus("connected");

  eventSource.addEventListener("metrics", (e) => {
    try {
      const data = JSON.parse(e.data);
      renderMetrics(data);
      pushChartData(data);
    } catch { /* ignore parse errors */ }
  });

  eventSource.onerror = () => {
    setSseStatus("disconnected");
    if (eventSource) { eventSource.close(); eventSource = null; }
    sseReconnectTimer = setTimeout(connectSse, SSE_RECONNECT_MS);
  };
}

// --- Chart.js ---
function createCharts() {
  if (typeof Chart === "undefined") return;

  const gridColor = "rgba(148,163,184,0.1)";
  const tickColor = "#94a3b8";
  const commonScales = { x: { display: true, grid: { color: gridColor }, ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 10 } } } };

  const latencyCtx = document.getElementById("chart-latency");
  if (latencyCtx) {
    latencyChart = new Chart(latencyCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "p95", data: [], borderColor: "#7dd3fc", backgroundColor: "rgba(125,211,252,0.08)", borderWidth: 2, tension: 0.3, fill: true, pointRadius: 0 },
          { label: "avg", data: [], borderColor: "#a78bfa", backgroundColor: "rgba(167,139,250,0.08)", borderWidth: 2, tension: 0.3, fill: true, pointRadius: 0 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } } },
        scales: { ...commonScales, y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 10 } } } },
      },
    });
  }

  const successCtx = document.getElementById("chart-success");
  if (successCtx) {
    successChart = new Chart(successCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "Success %", data: [], borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.08)", borderWidth: 2, tension: 0.3, fill: true, pointRadius: 0 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } } },
        scales: { ...commonScales, y: { min: 0, max: 100, grid: { color: gridColor }, ticks: { color: tickColor, callback: (v) => `${v}%`, font: { size: 10 } } } },
      },
    });
  }
}

function pushChartData(metrics) {
  if (!latencyChart || !successChart || !metrics) return;
  const timeLabel = metrics.lastPoll?.timestamp ? new Date(metrics.lastPoll.timestamp).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Latency chart
  latencyChart.data.labels.push(timeLabel);
  latencyChart.data.datasets[0].data.push(metrics.polling?.latency?.p95 ?? 0);
  latencyChart.data.datasets[1].data.push(metrics.polling?.latency?.avg ?? 0);
  if (latencyChart.data.labels.length > CHART_MAX_POINTS) {
    latencyChart.data.labels.shift();
    latencyChart.data.datasets[0].data.shift();
    latencyChart.data.datasets[1].data.shift();
  }
  latencyChart.update("none");

  // Success chart
  successChart.data.labels.push(timeLabel);
  successChart.data.datasets[0].data.push(metrics.polling?.successRate ?? 0);
  if (successChart.data.labels.length > CHART_MAX_POINTS) {
    successChart.data.labels.shift();
    successChart.data.datasets[0].data.shift();
  }
  successChart.update("none");
}

async function loadMetricsHistory() {
  try {
    const res = await fetch(`${METRICS_URL}/history?limit=60`);
    if (!res.ok) return;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return;

    const sorted = rows.reverse();
    for (const row of sorted) {
      const label = row.createdAt ? new Date(row.createdAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
      if (latencyChart) {
        latencyChart.data.labels.push(label);
        latencyChart.data.datasets[0].data.push(row.latencyP95 ?? 0);
        latencyChart.data.datasets[1].data.push(row.latencyAvg ?? 0);
      }
      if (successChart) {
        successChart.data.labels.push(label);
        successChart.data.datasets[0].data.push(Number(row.successRate) || 0);
      }
    }
    if (latencyChart) latencyChart.update("none");
    if (successChart) successChart.update("none");
  } catch { /* ignore */ }
}

// --- Accept Job ---
function openAcceptConfirm(bookingId, requestId) {
  pendingAcceptBookingId = Number(bookingId);
  pendingAcceptRequestIds = [Number(requestId)];
  const preview = document.getElementById("accept-preview");
  if (preview) preview.textContent = JSON.stringify({ bookingId: pendingAcceptBookingId, requestIds: pendingAcceptRequestIds }, null, 2);
  bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmAcceptModal")).show();
}

async function confirmAcceptJob() {
  if (!pendingAcceptBookingId || !pendingAcceptRequestIds) return;
  try {
    const res = await fetch(`${API}/bidding/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: pendingAcceptBookingId, requestIds: pendingAcceptRequestIds, confirm: true }),
    });
    const result = await res.json();
    if (res.ok && result.ok) {
      showToast("รับงานสำเร็จ");
      historyDt?.ajax.reload(null, false);
      auditDt?.ajax.reload(null, false);
    } else {
      showToast(result?.error?.message || "รับงานไม่สำเร็จ", true);
    }
  } catch {
    showToast("เกิดข้อผิดพลาดในการรับงาน", true);
  } finally {
    pendingAcceptBookingId = null;
    pendingAcceptRequestIds = null;
    bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmAcceptModal")).hide();
  }
}

function bindEvents() {
  document.getElementById("refresh-page-button")?.addEventListener("click", () => window.location.reload());
  document.getElementById("logout-button")?.addEventListener("click", logout);
  document.getElementById("add-rule-button")?.addEventListener("click", resetRuleForm);
  document.getElementById("save-rule-button")?.addEventListener("click", saveRule);
  document.getElementById("history-search-button")?.addEventListener("click", refreshHistory);
  document.getElementById("history-reset-button")?.addEventListener("click", resetHistoryFilters);
  document.getElementById("audit-search-button")?.addEventListener("click", refreshAudit);
  document.getElementById("audit-reset-button")?.addEventListener("click", resetAuditFilters);
  document.getElementById("add-user-button")?.addEventListener("click", addUser);
  document.getElementById("change-password-button")?.addEventListener("click", changePassword);
  document.getElementById("confirm-delete-rule-button")?.addEventListener("click", confirmDeleteRule);
  document.getElementById("notification-preview-button")?.addEventListener("click", previewNotification);
  document.getElementById("notification-test-button")?.addEventListener("click", testNotification);
  document.getElementById("settingsForm")?.addEventListener("submit", saveSettings);

  document.getElementById("confirm-accept-button")?.addEventListener("click", confirmAcceptJob);

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const action = target.dataset.action;
    if (action === "edit-rule") openEditRule(target.dataset.ruleId);
    if (action === "preview-rule") previewRule(target.dataset.ruleId);
    if (action === "toggle-rule") {
      const row = ruleById(target.dataset.ruleId);
      if (row) updateRule(row.id, { enabled: !row.enabled }, row.enabled ? "ปิดรายการแล้ว" : "เปิดรายการแล้ว");
    }
    if (action === "delete-rule") requestDeleteRule(target.dataset.ruleId);
    if (action === "change-password") openChangePassword(target.dataset.userId);
    if (action === "accept-job") openAcceptConfirm(target.dataset.bookingId, target.dataset.requestId);
  });

  document.querySelectorAll("[data-report-path]").forEach((button) => {
    button.addEventListener("click", () => downloadReport(button.dataset.reportPath, button.dataset.reportFile));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initTables();
  bindEvents();
  createCharts();
  loadMetrics();
  loadMetricsHistory();
  loadSettings();
  connectSse();
  // Fallback polling if SSE is not available
  setInterval(loadMetrics, FALLBACK_POLL_MS);
});
