const API = `${window.location.origin}/api`;
const METRICS_URL = `${window.location.origin}/metrics`;
const EVENTS_URL = `${window.location.origin}/events`;
const MIN_PASSWORD_LENGTH = 12;
const CHART_MAX_POINTS = 60;
const SSE_RECONNECT_MS = 5000;
const FALLBACK_POLL_MS = 30000;
const THEME_KEY = "spx-theme";

let pendingDeleteRuleIds = [];
let pendingDeleteRuleId = null;
let pendingAcceptBookingId = null;
let pendingAcceptRequestIds = null;
let latencyChart = null;
let successChart = null;
let eventSource = null;
let sseReconnectTimer = null;

const TABLE_SCHEMAS = {
  rules: {
    columns: [
      { key: "status", label: "สถานะ", sortable: false },
      { key: "name", label: "ชื่อรายการ", sortable: true },
      { key: "origins", label: "ต้นทาง", sortable: true, hiddenByDefault: true },
      { key: "destinations", label: "ปลายทาง", sortable: true, hiddenByDefault: true },
      { key: "vehicle_types", label: "ประเภทรถ", sortable: true, hiddenByDefault: true },
      { key: "need", label: "ต้องการ", sortable: true },
      { key: "actions", label: "จัดการ", sortable: false },
    ],
  },
  history: {
    columns: [
      { key: "requestId", label: "Request ID", sortable: true },
      { key: "bookingId", label: "Booking ID", sortable: true },
      { key: "origin", label: "ต้นทาง", sortable: true, hiddenByDefault: true },
      { key: "destination", label: "ปลายทาง", sortable: true, hiddenByDefault: true },
      { key: "vehicleType", label: "ประเภทรถ", sortable: true, hiddenByDefault: true },
      { key: "standbyDateTime", label: "เวลาสแตนบาย", sortable: true },
      { key: "createdAt", label: "บันทึกเมื่อ", sortable: true },
      { key: "actions", label: "รับงาน", sortable: false },
    ],
  },
  audit: {
    columns: [
      { key: "id", label: "ID", sortable: true },
      { key: "username", label: "ผู้ทำรายการ", sortable: true },
      { key: "action", label: "แอคชัน", sortable: true },
      { key: "details", label: "รายละเอียด", sortable: true, hiddenByDefault: true },
      { key: "createdAt", label: "เวลา", sortable: true },
    ],
  },
  users: {
    columns: [
      { key: "id", label: "ID", sortable: true },
      { key: "username", label: "ชื่อผู้ใช้", sortable: true },
      { key: "role", label: "Role", sortable: true },
      { key: "createdAt", label: "วันที่สร้าง", sortable: true },
      { key: "actions", label: "จัดการ", sortable: false },
    ],
  },
};
const grids = {
  rules: { key: "rules", endpoint: "/rules", tableId: "rulesTable", pageSize: 10, page: 1, sortKey: null, sortDir: "asc", search: "", rows: [], filtered: [] },
  history: { key: "history", endpoint: "/history", tableId: "historyTable", pageSize: 10, page: 1, sortKey: "createdAt", sortDir: "desc", search: "", rows: [], filtered: [] },
  audit: { key: "audit", endpoint: "/audit-logs", tableId: "auditTable", pageSize: 10, page: 1, sortKey: "createdAt", sortDir: "desc", search: "", rows: [], filtered: [] },
  users: { key: "users", endpoint: "/users", tableId: "usersTable", pageSize: 10, page: 1, sortKey: "createdAt", sortDir: "desc", search: "", rows: [], filtered: [] },
};
const columnVisibility = { rules: {}, history: {}, audit: {}, users: {} };
Object.entries(TABLE_SCHEMAS).forEach(([gridKey, schema]) => {
  schema.columns.forEach((column) => {
    if (column.hiddenByDefault) columnVisibility[gridKey][column.key] = false;
  });
});

function escapeHtml(value) { return String(value ?? "-").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }
function showToast(message, isError = false) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `mb-2 flex items-center gap-3 rounded-2xl border px-4 py-3 shadow-xl ${isError ? "border-rose-500/30 bg-rose-500/10 text-rose-100" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"}`;
  toast.textContent = message;
  container.append(toast);
  setTimeout(() => toast.remove(), 3000);
}
function splitCsv(value) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean); }
function formatArray(values) { return Array.isArray(values) && values.length > 0 ? values.map(escapeHtml).join(", ") : "-"; }
function formatValue(value) { return value ?? "-"; }
function sortValue(row, key) { const value = row?.[key]; return typeof value === "string" ? value.toLowerCase() : value ?? ""; }
function compareRows(a, b, key, dir) { const av = sortValue(a, key); const bv = sortValue(b, key); if (av < bv) return dir === "asc" ? -1 : 1; if (av > bv) return dir === "asc" ? 1 : -1; return 0; }
function normalizeQuery(str) { return String(str || "").trim().toLowerCase(); }
function matchesSearch(row, query) { if (!query) return true; return JSON.stringify(row).toLowerCase().includes(query); }
function applyGridState(key) {
  const grid = grids[key];
  const query = normalizeQuery(document.getElementById(`${key}-search`)?.value || grid.search);
  grid.search = query;
  grid.filtered = grid.rows.filter((row) => matchesSearch(row, query));
  if (grid.sortKey) grid.filtered.sort((a, b) => compareRows(a, b, grid.sortKey, grid.sortDir));
  grid.page = Math.min(grid.page, Math.max(1, Math.ceil(grid.filtered.length / grid.pageSize)) || 1);
  renderGrid(key);
  updateSortIndicators(key);
}
function renderGrid(key) {
  const grid = grids[key];
  const tbody = document.querySelector(`#${grid.tableId} tbody`);
  const empty = document.querySelector(`[data-empty-state="${key}"]`);
  const info = document.querySelector(`[data-page-info="${key}"]`);
  if (!tbody) return;
  const total = grid.filtered.length;
  const start = total === 0 ? 0 : (grid.page - 1) * grid.pageSize + 1;
  const pageRows = grid.filtered.slice((grid.page - 1) * grid.pageSize, grid.page * grid.pageSize);
  tbody.innerHTML = pageRows.map((row) => renderRow(key, row)).join("");
  empty?.classList.toggle("hidden", total > 0);
  if (info) info.textContent = total === 0 ? "ไม่มีข้อมูล" : `${start}-${Math.min(start + pageRows.length - 1, total)} จาก ${total} รายการ`;
  const prev = document.querySelector(`[data-page-prev="${key}"]`);
  const next = document.querySelector(`[data-page-next="${key}"]`);
  if (prev) prev.disabled = grid.page <= 1;
  if (next) next.disabled = grid.page >= Math.ceil(total / grid.pageSize);
  applyColumnVisibility(key);
}
function isVisibleColumn(key, columnKey) { return columnVisibility[key][columnKey] !== false; }
function setColumnVisibility(key, columnKey, visible) { columnVisibility[key][columnKey] = visible; applyColumnVisibility(key); }
function applyColumnVisibility(key) {
  const table = document.getElementById(grids[key].tableId);
  if (!table) return;
  const schema = TABLE_SCHEMAS[key].columns;
  const menu = document.querySelector(`[data-column-menu="${key}"]`);

  schema.forEach((column) => {
    const visible = isVisibleColumn(key, column.key);
    table.querySelectorAll(`[data-col-key="${column.key}"]`).forEach((el) => {
      el.style.display = visible ? "" : "none";
    });
    table.querySelectorAll(`thead th[data-col-key="${column.key}"]`).forEach((el) => {
      el.style.display = visible ? "" : "none";
    });
    table.querySelectorAll(`tbody tr`).forEach((tr) => {
      const cell = tr.querySelector(`[data-col-key="${column.key}"]`);
      if (cell) cell.style.display = visible ? "" : "none";
    });
    const checkbox = menu?.querySelector(`[data-col-toggle="${key}"][data-col-key="${column.key}"]`);
    if (checkbox) checkbox.checked = visible;
  });
}
function renderRow(key, row) {
  if (key === "rules") return `<tr data-row-id="${escapeAttribute(row.id)}"><td class="w-10"><input type="checkbox" class="accent-cyan-400" data-row-select="${key}" data-row-id="${escapeAttribute(row.id)}"></td>${statusCell(row)}${renderCells(TABLE_SCHEMAS.rules.columns, { status: "", name: `<strong class=\"text-white\">${escapeHtml(row.name)}</strong>`, origins: formatArray(row.origins), destinations: formatArray(row.destinations), vehicle_types: formatArray(row.vehicle_types), need: `${Number(row.need) || 1} คัน`, actions: renderRuleActions(row) })}</tr>`;
  if (key === "history") return `<tr data-row-id="${escapeAttribute(row.requestId)}"><td class="w-10"><input type="checkbox" class="accent-cyan-400" data-row-select="${key}" data-row-id="${escapeAttribute(row.requestId)}"></td>${renderCells(TABLE_SCHEMAS.history.columns, { requestId: formatValue(row.requestId), bookingId: formatValue(row.bookingId || "-"), origin: escapeHtml(row.origin), destination: escapeHtml(row.destination), vehicleType: escapeHtml(row.vehicleType), standbyDateTime: escapeHtml(row.standbyDateTime), createdAt: row.createdAt ? new Date(row.createdAt).toLocaleString("th-TH") : "-", actions: renderAcceptAction(row) })}</tr>`;
  if (key === "audit") return `<tr data-row-id="${escapeAttribute(row.id)}"><td class="w-10"><input type="checkbox" class="accent-cyan-400" data-row-select="${key}" data-row-id="${escapeAttribute(row.id)}"></td>${renderCells(TABLE_SCHEMAS.audit.columns, { id: formatValue(row.id), username: `<span class=\"inline-flex items-center rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold text-cyan-100\">${escapeHtml(row.username)}</span>`, action: escapeHtml(row.action), details: escapeHtml(row.details), createdAt: row.createdAt ? new Date(row.createdAt).toLocaleString("th-TH") : "-" })}</tr>`;
  return `<tr data-row-id="${escapeAttribute(row.id)}"><td class="w-10"><input type="checkbox" class="accent-cyan-400" data-row-select="${key}" data-row-id="${escapeAttribute(row.id)}"></td>${renderCells(TABLE_SCHEMAS.users.columns, { id: formatValue(row.id), username: escapeHtml(row.username), role: escapeHtml(row.role), createdAt: row.createdAt ? new Date(row.createdAt).toLocaleString("th-TH") : "-", actions: `<button type=\"button\" class=\"rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100\" data-action=\"change-password\" data-user-id=\"${escapeAttribute(row.id)}\">เปลี่ยนรหัสผ่าน</button>` })}</tr>`;
}
function renderCells(columns, values) { return columns.filter((column) => column.key !== "status").map((column) => renderCell(column, values[column.key] ?? "")).join(""); }
function renderCell(column, value) { return `<td data-col-key="${column.key}">${value}</td>`; }
function statusCell(rule) { const cls = !rule.enabled ? ["ปิดอยู่", "border-slate-500/20 bg-slate-500/10 text-slate-200"] : rule.fulfilled ? ["ครบแล้ว", "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"] : ["กำลังค้นหา", "border-cyan-400/20 bg-cyan-400/10 text-cyan-100"]; return `<td data-col-key="status"><span class="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${cls[1]}">${cls[0]}</span></td>`; }
function renderRuleActions(row) { const id = escapeAttribute(row.id); const toggleLabel = row.enabled ? "ปิด" : "เปิด"; const toggleClass = row.enabled ? "border-amber-400/20 bg-amber-400/10 text-amber-100" : "border-cyan-400/20 bg-cyan-400/10 text-cyan-100"; return `<div class="flex flex-wrap gap-2"><button type="button" class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white" data-action="edit-rule" data-rule-id="${id}">แก้ไข</button><button type="button" class="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-100" data-action="preview-rule" data-rule-id="${id}">Preview</button><button type="button" class="rounded-xl border px-3 py-2 text-xs font-semibold ${toggleClass}" data-action="toggle-rule" data-rule-id="${id}">${toggleLabel}</button><button type="button" class="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-100" data-action="delete-rule" data-rule-id="${id}">ลบ</button></div>`; }
function renderAcceptAction(row) { if (!row.bookingId || !row.requestId) return '<span class="text-slate-500">—</span>'; return `<button type="button" class="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-100" data-action="accept-job" data-booking-id="${escapeAttribute(row.bookingId)}" data-request-id="${escapeAttribute(row.requestId)}">รับงาน</button>`; }
function refreshStats(rows) { const active = rows.filter((rule) => rule.enabled && !rule.fulfilled).length; const done = rows.filter((rule) => rule.fulfilled).length; const off = rows.filter((rule) => !rule.enabled).length; const stats = document.getElementById("stats"); if (stats) stats.innerHTML = `<span class="inline-flex items-center rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-semibold text-cyan-100">${active} รอ</span><span class="ml-2 inline-flex items-center rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-100">${done} ครบ</span><span class="ml-2 inline-flex items-center rounded-full border border-slate-400/20 bg-slate-400/10 px-3 py-1 text-xs font-semibold text-slate-100">${off} ปิด</span>`; document.getElementById("kpi-active").textContent = String(active); document.getElementById("kpi-done").textContent = String(done); document.getElementById("kpi-off").textContent = String(off); document.getElementById("kpi-status").textContent = "Healthy"; document.getElementById("kpi-status-hint").textContent = "ดึงข้อมูล rule ได้ปกติ"; }
function formatDuration(seconds) { if (!Number.isFinite(seconds) || seconds < 0) return "—"; const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = Math.floor(seconds % 60); return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`; }
function renderMetrics(data) { if (!data) return; document.getElementById("metric-uptime").textContent = formatDuration(data.uptime); document.getElementById("metric-success-rate").textContent = `${data.polling?.successRate ?? 0}%`; document.getElementById("metric-p95").textContent = `${data.polling?.latency?.p95 ?? 0} ms`; document.getElementById("metric-last-poll").textContent = data.lastPoll?.timestamp ? new Date(data.lastPoll.timestamp).toLocaleTimeString("th-TH") : "—"; document.getElementById("metric-last-status").textContent = `สถานะล่าสุด: ${data.lastPoll?.status ?? "unknown"}`; }
function setTheme(theme) { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); updateThemeButtons(theme); }
function updateThemeButtons(theme) { ["theme-toggle", "theme-toggle-2"].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = theme === "light" ? "Dark" : "Light"; }); }
function toggleTheme() { setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); }
function initTheme() { const saved = localStorage.getItem(THEME_KEY) || "dark"; setTheme(saved); document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme); document.getElementById("theme-toggle-2")?.addEventListener("click", toggleTheme); }
function getSelectedRows(key) { return [...document.querySelectorAll(`[data-row-select="${key}"]:checked`)].map((input) => input.dataset.rowId); }
function clearSelections(key) { document.querySelectorAll(`[data-row-select="${key}"]`).forEach((input) => { input.checked = false; }); }
function applyBulkAction(key) {
  const action = document.querySelector(`[data-bulk-action="${key}"]`)?.value;
  const selected = getSelectedRows(key);
  if (selected.length === 0) return showToast("กรุณาเลือกรายการก่อน", true);
  if (action === "toggle-selected" && key === "rules") {
    selected.forEach((id) => { const row = ruleById(id); if (row) updateRule(row.id, { enabled: !row.enabled }, row.enabled ? "ปิดรายการแล้ว" : "เปิดรายการแล้ว"); });
    clearSelections(key);
    return;
  }
  if (action === "delete-selected" && key === "rules") {
    pendingDeleteRuleIds = selected;
    pendingDeleteRuleId = selected[0];
    pendingDeleteRuleConfirmMessage = selected.length > 1 ? `ต้องการลบ ${selected.length} รายการที่เลือกใช่หรือไม่?` : "ต้องการลบรายการค้นหานี้หรือไม่?";
    document.getElementById("confirm-delete-rule-button").textContent = selected.length > 1 ? `ลบ ${selected.length} รายการ` : "ลบรายการ";
    document.querySelector("#confirmDeleteModal .modal-body p").textContent = pendingDeleteRuleConfirmMessage;
    bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmDeleteModal")).show();
    clearSelections(key);
  }
}
function bindGridControls() { Object.keys(grids).forEach((key) => { document.getElementById(`${key}-search`)?.addEventListener("input", () => { grids[key].page = 1; applyGridState(key); }); document.querySelector(`[data-page-size="${key}"]`)?.addEventListener("change", (e) => { grids[key].pageSize = Number(e.target.value) || 10; grids[key].page = 1; renderGrid(key); }); document.querySelector(`[data-page-prev="${key}"]`)?.addEventListener("click", () => { grids[key].page = Math.max(1, grids[key].page - 1); renderGrid(key); }); document.querySelector(`[data-page-next="${key}"]`)?.addEventListener("click", () => { grids[key].page += 1; renderGrid(key); }); document.querySelector(`[data-bulk-apply="${key}"]`)?.addEventListener("click", () => applyBulkAction(key)); document.querySelectorAll(`[data-col-toggle="${key}"]`).forEach((checkbox) => { checkbox.addEventListener("change", (e) => { const columnKey = e.target.dataset.colKey; setColumnVisibility(key, columnKey, e.target.checked); }); }); document.querySelector(`[data-column-menu-toggle="${key}"]`)?.addEventListener("click", () => { document.querySelector(`[data-column-menu="${key}"]`)?.classList.toggle("hidden"); }); document.querySelector(`[data-select-all="${key}"]`)?.addEventListener("change", (e) => { document.querySelectorAll(`[data-row-select="${key}"]`).forEach((input) => { input.checked = e.target.checked; }); }); }); }
function applySort(key) { const grid = grids[key]; if (!grid.sortKey) return; grid.filtered.sort((a, b) => compareRows(a, b, grid.sortKey, grid.sortDir)); renderGrid(key); updateSortIndicators(key); }
function sortBy(key, sortKey) { const grid = grids[key]; if (grid.sortKey === sortKey) grid.sortDir = grid.sortDir === "asc" ? "desc" : "asc"; else { grid.sortKey = sortKey; grid.sortDir = "asc"; } applySort(key); }
function updateSortIndicators(key) { const table = document.getElementById(grids[key].tableId); table?.querySelectorAll("thead th[data-sortable='true']").forEach((th, index) => { const active = grids[key].sortKey && index === getSortIndex(key, grids[key].sortKey); th.classList.toggle("is-sorted", active); const arrow = th.querySelector(".sort-arrow"); if (arrow) arrow.textContent = active ? (grids[key].sortDir === "asc" ? "↑" : "↓") : "↕"; }); }
function getSortIndex(key, sortKey) { return getColumnIndex(key, sortKey); }
function bindSortHeaders() { Object.keys(TABLE_SCHEMAS).forEach((gridKey) => { const table = document.getElementById(grids[gridKey].tableId); table?.querySelectorAll("thead th[data-sortable='true']").forEach((th) => { const sortKey = th.dataset.colKey; if (!sortKey || sortKey === "status" || sortKey === "actions") return; th.classList.add("cursor-pointer", "select-none", "transition", "hover:text-cyan-200"); th.addEventListener("click", () => sortBy(gridKey, sortKey)); }); }); }
async function fetchGrid(key) { try { const res = await fetch(`${API}${grids[key].endpoint}${key === "history" ? `?${new URLSearchParams(historyQuery())}` : key === "audit" ? `?${new URLSearchParams(auditQuery())}` : ""}`); if (!res.ok) throw new Error("Failed"); const json = await res.json(); grids[key].rows = Array.isArray(json) ? json : []; grids[key].filtered = grids[key].rows.slice(); if (key === "rules") refreshStats(grids[key].rows); applyGridState(key); } catch { showToast(`ไม่สามารถโหลด ${key} ได้`, true); } }
function historyQuery() { return { limit: 200, search: document.getElementById("history-search").value.trim() || undefined, origin: document.getElementById("history-origin").value.trim() || undefined, destination: document.getElementById("history-destination").value.trim() || undefined, vehicleType: document.getElementById("history-vehicle").value.trim() || undefined, sortBy: "created_at", sortDir: "desc" }; }
function auditQuery() { return { limit: 200, search: document.getElementById("audit-search").value.trim() || undefined, username: document.getElementById("audit-username").value.trim() || undefined, action: document.getElementById("audit-action").value.trim() || undefined, sortBy: "created_at", sortDir: "desc" }; }
function reloadHistory() { fetchGrid("history"); }
function reloadAudit() { fetchGrid("audit"); }
function resetHistoryFilters() { ["history-search","history-origin","history-destination","history-vehicle"].forEach((id) => document.getElementById(id).value = ""); reloadHistory(); }
function resetAuditFilters() { ["audit-search","audit-username","audit-action"].forEach((id) => document.getElementById(id).value = ""); reloadAudit(); }
function ruleById(id) { return grids.rules.rows.find((rule) => String(rule.id) === String(id)); }
function getColumnIndex(key, columnKey) { return TABLE_SCHEMAS[key].columns.indexOf(columnKey); }
function isVisibleColumn(key, columnKey) { return columnVisibility[key][columnKey] !== false; }
function resetRuleForm() { ["rule-id","f-name","f-origins","f-destinations","f-vehicle"].forEach((id) => document.getElementById(id).value = ""); document.getElementById("f-need").value = "1"; document.getElementById("f-enabled").value = "true"; }
function openEditRule(id) { const row = ruleById(id); if (!row) return; document.getElementById("rule-id").value = row.id; document.getElementById("f-name").value = row.name || ""; document.getElementById("f-origins").value = (row.origins || []).join(", "); document.getElementById("f-destinations").value = (row.destinations || []).join(", "); document.getElementById("f-vehicle").value = (row.vehicle_types || []).join(", "); document.getElementById("f-need").value = row.need || 1; document.getElementById("f-enabled").value = String(Boolean(row.enabled)); bootstrap.Modal.getOrCreateInstance(document.getElementById("addRuleModal")).show(); }
async function saveRule() { const id = document.getElementById("rule-id").value; const payload = { name: document.getElementById("f-name").value.trim(), origins: splitCsv(document.getElementById("f-origins").value), destinations: splitCsv(document.getElementById("f-destinations").value), vehicle_types: splitCsv(document.getElementById("f-vehicle").value), need: Number.parseInt(document.getElementById("f-need").value, 10) || 1, enabled: document.getElementById("f-enabled").value === "true" }; const method = id === "" ? "POST" : "PUT"; const url = id === "" ? `${API}/rules` : `${API}/rules/${encodeURIComponent(id)}`; const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); if (!res.ok) return showToast("บันทึก rule ไม่สำเร็จ", true); bootstrap.Modal.getOrCreateInstance(document.getElementById("addRuleModal")).hide(); resetRuleForm(); showToast("บันทึก rule แล้ว"); fetchGrid("rules"); }
function previewRule(id) { const row = ruleById(id); if (!row) return; document.getElementById("notification-preview").textContent = JSON.stringify({ rule: row, preview: `Rule "${row.name}" จะจับคู่เมื่อ origin/destination/vehicle ตรงตามเงื่อนไข` }, null, 2); document.getElementById("notifications-tab").click(); }
async function updateRule(id, data, message) { try { const row = ruleById(id); if (!row) throw new Error("Missing rule"); const { id: _ruleId, ...ruleValues } = row; const payload = { ...ruleValues, ...data }; const res = await fetch(`${API}/rules/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); if (!res.ok) throw new Error("Failed"); showToast(message); fetchGrid("rules"); } catch { showToast("เกิดข้อผิดพลาด", true); } }
function requestDeleteRule(id) { pendingDeleteRuleId = id; bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmDeleteModal")).show(); }
async function confirmDeleteRule() { if (!pendingDeleteRuleId && pendingDeleteRuleIds.length === 0) return; try { if (pendingDeleteRuleIds.length > 0) { for (const id of pendingDeleteRuleIds) { const res = await fetch(`${API}/rules/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!res.ok) throw new Error("Failed"); } showToast(`ลบ ${pendingDeleteRuleIds.length} รายการแล้ว`); } else { const res = await fetch(`${API}/rules/${encodeURIComponent(pendingDeleteRuleId)}`, { method: "DELETE" }); if (!res.ok) throw new Error("Failed"); showToast("ลบรายการแล้ว"); } fetchGrid("rules"); reloadAudit(); } catch { showToast("เกิดข้อผิดพลาด", true); } finally { pendingDeleteRuleId = null; pendingDeleteRuleIds = []; pendingDeleteRuleConfirmMessage = ""; document.getElementById("confirm-delete-rule-button").textContent = "ลบรายการ"; document.querySelector("#confirmDeleteModal .modal-body p").textContent = "ต้องการลบรายการค้นหานี้หรือไม่?"; bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmDeleteModal")).hide(); } }
async function addUser() { const username = document.getElementById("u-username").value.trim(); const password = document.getElementById("u-password").value.trim(); const role = document.getElementById("u-role").value; if (!username || !password) return showToast("กรุณากรอกข้อมูลให้ครบถ้วน", true); if (password.length < MIN_PASSWORD_LENGTH) return showToast(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`, true); try { const res = await fetch(`${API}/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, role }) }); if (!res.ok) throw new Error("Failed"); document.querySelectorAll("#addUserModal input").forEach((input) => { input.value = ""; }); bootstrap.Modal.getOrCreateInstance(document.getElementById("addUserModal")).hide(); showToast("เพิ่มผู้ใช้งานสำเร็จ"); fetchGrid("users"); } catch { showToast("เกิดข้อผิดพลาด หรือชื่อผู้ใช้ซ้ำ", true); } }
function openChangePassword(id) { document.getElementById("pwd-user-id").value = id; document.getElementById("pwd-new").value = ""; bootstrap.Modal.getOrCreateInstance(document.getElementById("changePasswordModal")).show(); }
async function changePassword() { const id = document.getElementById("pwd-user-id").value; const password = document.getElementById("pwd-new").value.trim(); if (password.length < MIN_PASSWORD_LENGTH) return showToast(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`, true); try { const res = await fetch(`${API}/users/${encodeURIComponent(id)}/password`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }); if (!res.ok) throw new Error("Failed"); bootstrap.Modal.getOrCreateInstance(document.getElementById("changePasswordModal")).hide(); showToast("เปลี่ยนรหัสผ่านสำเร็จ"); fetchGrid("users"); } catch { showToast("เกิดข้อผิดพลาด", true); } }
async function downloadReport(path, filename) { const res = await fetch(`${API}${path}`); if (!res.ok) return showToast("ดาวน์โหลดรายงานไม่สำเร็จ", true); const blob = await res.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
async function previewNotification() { const res = await fetch(`${API}/notifications/preview`, { method: "POST" }); document.getElementById("notification-preview").textContent = JSON.stringify(await res.json(), null, 2); }
async function testNotification() { const res = await fetch(`${API}/notifications/test`, { method: "POST" }); document.getElementById("notification-preview").textContent = JSON.stringify(await res.json(), null, 2); }
async function saveSettings(event) { event.preventDefault(); const data = { API_URL: document.getElementById("s-api-url").value.trim(), COOKIE: document.getElementById("s-cookie").value.trim(), DEVICE_ID: document.getElementById("s-device-id").value.trim(), LINE_NOTIFY_TOKEN: document.getElementById("s-line-token").value.trim(), DISCORD_WEBHOOK_URL: document.getElementById("s-discord-url").value.trim(), POLL_INTERVAL_MS: document.getElementById("s-poll-interval").value.trim() }; const res = await fetch(`${API}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); if (!res.ok) return showToast("เกิดข้อผิดพลาดในการบันทึกการตั้งค่า", true); showToast("บันทึกการตั้งค่าแล้ว เซิร์ฟเวอร์กำลังรีสตาร์ทตัวเอง..."); setTimeout(() => window.location.reload(), 4000); }
async function loadSettings() { try { const res = await fetch(`${API}/settings`); if (!res.ok) return; const settings = await res.json(); document.getElementById("s-api-url").value = settings.API_URL || ""; document.getElementById("s-cookie").value = settings.COOKIE || ""; document.getElementById("s-device-id").value = settings.DEVICE_ID || ""; document.getElementById("s-line-token").value = settings.LINE_NOTIFY_TOKEN || ""; document.getElementById("s-discord-url").value = settings.DISCORD_WEBHOOK_URL || ""; document.getElementById("s-poll-interval").value = settings.POLL_INTERVAL_MS || "30000"; } catch { showToast("ไม่สามารถโหลด settings ได้", true); } }
async function logout() { if (eventSource) { eventSource.close(); eventSource = null; } await fetch(`${API}/logout`, { method: "POST" }); window.location.reload(); }
function setSseStatus(state) { const dot = document.getElementById("sse-dot"); const label = document.getElementById("sse-label"); if (!dot || !label) return; dot.className = `sse-dot ${state}`; label.textContent = state === "connected" ? "live" : state === "connecting" ? "connecting..." : "offline"; }
function connectSse() { if (eventSource) eventSource.close(); if (sseReconnectTimer) clearTimeout(sseReconnectTimer); setSseStatus("connecting"); eventSource = new EventSource(EVENTS_URL); eventSource.onopen = () => setSseStatus("connected"); eventSource.addEventListener("metrics", (e) => { try { const data = JSON.parse(e.data); renderMetrics(data); pushChartData(data); } catch {} }); eventSource.onerror = () => { setSseStatus("disconnected"); if (eventSource) eventSource.close(); eventSource = null; sseReconnectTimer = setTimeout(connectSse, SSE_RECONNECT_MS); }; }
function createCharts() { if (typeof Chart === "undefined") return; const palette = getChartPalette(); createLatencyChart(palette); createSuccessChart(palette); }
function getChartPalette() { return { gridColor: "rgba(148,163,184,0.1)", tickColor: "#94a3b8" }; }
function getCommonChartScales(palette) { return { x: { display: true, grid: { color: palette.gridColor }, ticks: { color: palette.tickColor, maxTicksLimit: 8, font: { size: 10 } } } }; }
function createLatencyChart(palette) { const latencyCtx = document.getElementById("chart-latency"); if (!latencyCtx) return; latencyChart = new Chart(latencyCtx, { type: "line", data: { labels: [], datasets: [{ label: "p95", data: [], borderColor: "#22d3ee", backgroundColor: "rgba(34,211,238,0.08)", borderWidth: 2, tension: 0.3, fill: true, pointRadius: 0 }, { label: "avg", data: [], borderColor: "#a855f7", backgroundColor: "rgba(168,85,247,0.08)", borderWidth: 2, tension: 0.3, fill: true, pointRadius: 0 }] }, options: { responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, plugins: { legend: { labels: { color: palette.tickColor, boxWidth: 12, font: { size: 11 } } } }, scales: { ...getCommonChartScales(palette), y: { beginAtZero: true, grid: { color: palette.gridColor }, ticks: { color: palette.tickColor, font: { size: 10 } } } } } }); }
function createSuccessChart(palette) { const successCtx = document.getElementById("chart-success"); if (!successCtx) return; successChart = new Chart(successCtx, { type: "line", data: { labels: [], datasets: [{ label: "Success %", data: [], borderColor: "#34d399", backgroundColor: "rgba(52,211,153,0.08)", borderWidth: 2, tension: 0.3, fill: true, pointRadius: 0 }] }, options: { responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, plugins: { legend: { labels: { color: palette.tickColor, boxWidth: 12, font: { size: 11 } } } }, scales: { ...getCommonChartScales(palette), y: { min: 0, max: 100, grid: { color: palette.gridColor }, ticks: { color: palette.tickColor, callback: (v) => `${v}%`, font: { size: 10 } } } } } }); }
function pushChartData(metrics) { if (!latencyChart || !successChart || !metrics) return; const timeLabel = metrics.lastPoll?.timestamp ? new Date(metrics.lastPoll.timestamp).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); latencyChart.data.labels.push(timeLabel); latencyChart.data.datasets[0].data.push(metrics.polling?.latency?.p95 ?? 0); latencyChart.data.datasets[1].data.push(metrics.polling?.latency?.avg ?? 0); if (latencyChart.data.labels.length > CHART_MAX_POINTS) { latencyChart.data.labels.shift(); latencyChart.data.datasets[0].data.shift(); latencyChart.data.datasets[1].data.shift(); } latencyChart.update("none"); successChart.data.labels.push(timeLabel); successChart.data.datasets[0].data.push(metrics.polling?.successRate ?? 0); if (successChart.data.labels.length > CHART_MAX_POINTS) { successChart.data.labels.shift(); successChart.data.datasets[0].data.shift(); } successChart.update("none"); }
function openAcceptConfirm(bookingId, requestId) { pendingAcceptBookingId = Number(bookingId); pendingAcceptRequestIds = [Number(requestId)]; document.getElementById("accept-preview").textContent = JSON.stringify({ bookingId: pendingAcceptBookingId, requestIds: pendingAcceptRequestIds }, null, 2); bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmAcceptModal")).show(); }
async function confirmAcceptJob() { if (!pendingAcceptBookingId || !pendingAcceptRequestIds) return; try { const res = await fetch(`${API}/bidding/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookingId: pendingAcceptBookingId, requestIds: pendingAcceptRequestIds, confirm: true }) }); const result = await res.json(); if (res.ok && result.ok) { showToast("รับงานสำเร็จ"); reloadHistory(); reloadAudit(); } else { showToast(result?.error?.message || "รับงานไม่สำเร็จ", true); } } catch { showToast("เกิดข้อผิดพลาดในการรับงาน", true); } finally { pendingAcceptBookingId = null; pendingAcceptRequestIds = null; bootstrap.Modal.getOrCreateInstance(document.getElementById("confirmAcceptModal")).hide(); } }
function bindNavEvents() {
  document.getElementById("refresh-page-button")?.addEventListener("click", () => window.location.reload());
  document.getElementById("logout-button")?.addEventListener("click", logout);
  document.getElementById("notification-preview-button")?.addEventListener("click", previewNotification);
  document.getElementById("notification-test-button")?.addEventListener("click", testNotification);
}
function bindModalEvents() {
  document.getElementById("add-rule-button")?.addEventListener("click", resetRuleForm);
  document.getElementById("save-rule-button")?.addEventListener("click", saveRule);
  document.getElementById("add-user-button")?.addEventListener("click", addUser);
  document.getElementById("change-password-button")?.addEventListener("click", changePassword);
  document.getElementById("confirm-delete-rule-button")?.addEventListener("click", confirmDeleteRule);
  document.getElementById("settingsForm")?.addEventListener("submit", saveSettings);
  document.getElementById("confirm-accept-button")?.addEventListener("click", confirmAcceptJob);
}
function bindTableEvents() {
  document.getElementById("history-search-button")?.addEventListener("click", reloadHistory);
  document.getElementById("history-reset-button")?.addEventListener("click", resetHistoryFilters);
  document.getElementById("audit-search-button")?.addEventListener("click", reloadAudit);
  document.getElementById("audit-reset-button")?.addEventListener("click", resetAuditFilters);
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
  document.querySelectorAll("[data-report-path]").forEach((button) => button.addEventListener("click", () => downloadReport(button.dataset.reportPath, button.dataset.reportFile)));
}
function bindEvents() {
  bindNavEvents();
  bindModalEvents();
  bindTableEvents();
}
function loadAllGrids() { Promise.all([fetchGrid("rules"), fetchGrid("history"), fetchGrid("audit"), fetchGrid("users")]); }
document.addEventListener("DOMContentLoaded", () => { initTheme(); bindEvents(); bindSortHeaders(); bindGridControls(); createCharts(); loadAllGrids(); loadMetrics(); loadMetricsHistory(); loadSettings(); connectSse(); setInterval(loadMetrics, FALLBACK_POLL_MS); });
async function loadMetrics() { try { const res = await fetch(METRICS_URL); if (!res.ok) throw new Error("Failed"); const data = await res.json(); renderMetrics(data); pushChartData(data); } catch { showToast("ไม่สามารถโหลด metrics ได้", true); } }
function normalizeHistoryRows(rows) { return [...rows].reverse(); }
function appendMetricHistoryToCharts(rows) { for (const row of rows) { const label = row.createdAt ? new Date(row.createdAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""; if (latencyChart) { latencyChart.data.labels.push(label); latencyChart.data.datasets[0].data.push(row.latencyP95 ?? 0); latencyChart.data.datasets[1].data.push(row.latencyAvg ?? 0); } if (successChart) { successChart.data.labels.push(label); successChart.data.datasets[0].data.push(Number(row.successRate) || 0); } }
  if (latencyChart) latencyChart.update("none"); if (successChart) successChart.update("none"); }
async function loadMetricsHistory() { try { const res = await fetch(`${METRICS_URL}/history?limit=60`); if (!res.ok) return; const rows = await res.json(); if (!Array.isArray(rows) || rows.length === 0) return; const historyRows = normalizeHistoryRows(rows); appendMetricHistoryToCharts(historyRows); } catch {} }
