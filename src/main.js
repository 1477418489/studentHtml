import * as XLSX from "xlsx";
import "./styles.css";

const app = document.querySelector("#app");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PAGE_SIZE = 40;
const STATUS = [
  { value: "pending", label: "未签到" },
  { value: "checked", label: "已签到" },
  { value: "absent", label: "缺席" },
  { value: "leave", label: "请假" }
];
const ROSTER_COLUMNS = [
  { key: "serial", label: "序号", width: 60, min: 52, max: 120 },
  { key: "studentName", label: "学生姓名", width: 140, min: 80, max: 320 },
  { key: "className", label: "班级", width: 110, min: 75, max: 220 },
  { key: "parentName", label: "家长姓名", width: 135, min: 90, max: 300 },
  { key: "phone", label: "家长电话", width: 155, min: 110, max: 280 },
  { key: "address", label: "地址", width: 390, min: 160, max: 720 },
  { key: "status", label: "签到状态", width: 130, min: 118, max: 190 },
  { key: "actions", label: "操作", width: 150, min: 128, max: 240 }
];
const COLUMN_WIDTHS_KEY = "class-roster-column-widths";

function clampColumnWidth(column, value) {
  return Math.min(column.max, Math.max(column.min, Math.round(value)));
}

function loadColumnWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) || "{}");
    return Object.fromEntries(ROSTER_COLUMNS.map((column) => [
      column.key,
      clampColumnWidth(column, Number(saved[column.key]) || column.width)
    ]));
  } catch {
    return Object.fromEntries(ROSTER_COLUMNS.map((column) => [column.key, column.width]));
  }
}

const state = {
  password: "",
  authMode: "loading",
  key: null,
  salt: "",
  records: [],
  updatedAt: "",
  activeTab: "roster",
  dimension: "className",
  sortKey: "className",
  sortDirection: 1,
  search: "",
  classFilter: "",
  statusFilter: "",
  page: 0,
  saving: false,
  authError: "",
  importPreview: null,
  importMode: "merge",
  columnWidths: loadColumnWidths()
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[character]));

const statusLabel = (value) => STATUS.find((item) => item.value === value)?.label ?? "未签到";

function statusSelect(record, compact = false) {
  return `<select class="status-select status-${escapeHtml(record.status || "pending")}" data-action="status" data-id="${escapeHtml(record.id)}" aria-label="${escapeHtml(record.studentName)}签到状态" ${state.saving ? "disabled" : ""}>
    ${STATUS.map((item) => `<option value="${item.value}" ${record.status === item.value ? "selected" : ""}>${item.label}</option>`).join("")}
  </select>`;
}

function renderLogin() {
  const isSetup = state.authMode === "setup";
  const canSubmit = isSetup || state.authMode === "login";
  const title = isSetup ? "创建访问密码" : state.authMode === "loading" ? "连接数据服务" : "名册管理";
  const unavailableMessage = state.authMode === "unavailable" && !state.authError
    ? "访问密码尚未配置，请检查部署设置"
    : state.authError;
  app.innerHTML = `<main class="auth-shell">
    <section class="auth-panel" aria-labelledby="login-title">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>
        <span>班级名册</span>
      </div>
      <h1 id="login-title">${title}</h1>
      <form id="unlock-form">
        ${isSetup ? `<label for="setup-token">首次设置码</label>
        <input id="setup-token" name="setupToken" type="password" autocomplete="off" required autofocus />` : ""}
        ${canSubmit ? `<label for="password">${isSetup ? "设置访问密码" : "访问密码"}</label>
        <input id="password" name="password" type="password" autocomplete="${isSetup ? "new-password" : "current-password"}" required ${isSetup ? "" : "autofocus"} />` : ""}
        ${isSetup ? `<label for="password-confirm">确认访问密码</label>
        <input id="password-confirm" name="passwordConfirm" type="password" autocomplete="new-password" required />` : ""}
        <p class="auth-error" role="alert">${escapeHtml(unavailableMessage)}</p>
        ${canSubmit ? `<button class="button button-primary auth-submit" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? (isSetup ? "正在创建…" : "正在解锁…") : isSetup ? "创建密码并进入" : "进入名册"}</button>` : ""}
      </form>
    </section>
  </main>`;
  if (canSubmit) document.querySelector("#unlock-form")?.addEventListener("submit", handleUnlock);
}

function summarize(records) {
  const summary = { total: records.length, pending: 0, checked: 0, absent: 0, leave: 0 };
  for (const record of records) summary[record.status in summary ? record.status : "pending"] += 1;
  return summary;
}

function renderMetrics() {
  const metrics = summarize(state.records);
  return `<section class="metrics" aria-label="名册统计">
    <div class="metric metric-total"><span>学生总数</span><strong>${metrics.total}</strong></div>
    <div class="metric metric-checked"><span>已签到</span><strong>${metrics.checked}</strong></div>
    <div class="metric metric-pending"><span>未签到</span><strong>${metrics.pending}</strong></div>
    <div class="metric metric-absent"><span>缺席</span><strong>${metrics.absent}</strong></div>
    <div class="metric metric-leave"><span>请假</span><strong>${metrics.leave}</strong></div>
  </section>`;
}

function getVisibleRecords() {
  const query = state.search.trim().toLocaleLowerCase("zh-CN");
  return state.records
    .filter((record) => !state.classFilter || record.className === state.classFilter)
    .filter((record) => !state.statusFilter || (record.status || "pending") === state.statusFilter)
    .filter((record) => !query || [record.studentName, record.className, record.parentName, record.phone, record.address]
      .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query)))
    .sort((a, b) => String(a[state.sortKey] || "").localeCompare(String(b[state.sortKey] || ""), "zh-CN", { numeric: true }) * state.sortDirection);
}

function sortHeader(key, label) {
  const selected = state.sortKey === key;
  return `<button class="sort-button ${selected ? "is-active" : ""}" type="button" data-action="sort" data-key="${key}" aria-label="按${label}${selected && state.sortDirection === -1 ? "降序" : "升序"}排序">
    ${label}<span class="sort-indicator ${selected ? (state.sortDirection === 1 ? "ascending" : "descending") : ""}" aria-hidden="true"></span>
  </button>`;
}

function renderRecordRow(record, index) {
  return `<tr class="roster-row status-${escapeHtml(record.status || "pending")}">
    <td class="serial-cell">${index + 1}</td>
    <td class="student-cell"><strong>${escapeHtml(record.studentName)}</strong></td>
    <td>${escapeHtml(record.className)}</td>
    <td>${escapeHtml(record.parentName)}</td>
    <td>${record.phone ? `<a class="phone-link" href="tel:${encodeURIComponent(record.phone)}">${escapeHtml(record.phone)}</a>` : "<span class=muted>—</span>"}</td>
    <td class="address-cell" title="${escapeHtml(record.address)}">${escapeHtml(record.address) || "<span class=muted>—</span>"}</td>
    <td>${statusSelect(record)}</td>
    <td class="row-actions"><button type="button" class="text-button" data-action="edit" data-id="${escapeHtml(record.id)}">编辑</button><button type="button" class="text-button text-danger" data-action="delete" data-id="${escapeHtml(record.id)}">删除</button></td>
  </tr>`;
}

function renderMobileRecord(record) {
  return `<article class="mobile-record status-${escapeHtml(record.status || "pending")}">
    <div class="mobile-record-head">
      <div class="mobile-record-identity"><h3>${escapeHtml(record.studentName)}</h3></div>
      <div class="mobile-record-actions">${statusSelect(record, true)}<button class="text-button" type="button" data-action="edit" data-id="${escapeHtml(record.id)}">编辑</button></div>
    </div>
    <div class="mobile-fields">
      <div class="mobile-class-field"><span>班级</span><strong>${escapeHtml(record.className) || "—"}</strong></div>
      <div class="mobile-address"><span>地址</span><strong title="${escapeHtml(record.address)}">${escapeHtml(record.address) || "—"}</strong></div>
    </div>
  </article>`;
}

function renderPager(total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages < 2) return "";
  return `<div class="pager"><span>第 ${state.page + 1} / ${pages} 页</span><div><button class="button button-secondary button-small" type="button" data-action="page" data-page="${state.page - 1}" ${state.page === 0 ? "disabled" : ""}>上一页</button><button class="button button-secondary button-small" type="button" data-action="page" data-page="${state.page + 1}" ${state.page >= pages - 1 ? "disabled" : ""}>下一页</button></div></div>`;
}

function renderRosterHeader(column) {
  const content = {
    serial: "序号",
    studentName: "学生姓名",
    className: sortHeader("className", "班级"),
    parentName: "家长姓名",
    phone: "家长电话",
    address: sortHeader("address", "地址"),
    status: "签到状态",
    actions: "操作"
  }[column.key];
  const width = state.columnWidths[column.key];
  return `<th${column.key === "serial" ? ' class="serial-cell"' : ""}>${content}<span class="column-resizer" data-column-resizer="${column.key}" role="separator" aria-orientation="vertical" aria-label="调整${column.label}列宽" aria-valuemin="${column.min}" aria-valuemax="${column.max}" aria-valuenow="${width}" title="拖动调整列宽" tabindex="0"></span></th>`;
}

function renderRoster() {
  const visible = getVisibleRecords();
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  if (state.page >= pages) state.page = pages - 1;
  const pageRows = visible.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const classes = [...new Set(state.records.map((record) => record.className).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const offset = state.page * PAGE_SIZE;
  const tableWidth = ROSTER_COLUMNS.reduce((total, column) => total + state.columnWidths[column.key], 0);
  const mobileSortValue = `${state.sortKey}:${state.sortDirection}`;
  return `<section class="roster-view">
    <div class="roster-toolbar">
      <div class="search-wrap"><input type="search" name="search" value="${escapeHtml(state.search)}" placeholder="搜索姓名、班级、电话或地址" aria-label="搜索名册" /></div>
      <label class="filter-control"><span>班级</span><select name="classFilter"><option value="">全部</option>${classes.map((name) => `<option value="${escapeHtml(name)}" ${state.classFilter === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>
      <label class="filter-control"><span>状态</span><select name="statusFilter"><option value="">全部</option>${STATUS.map((item) => `<option value="${item.value}" ${state.statusFilter === item.value ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
      <label class="filter-control mobile-sort-control"><span>排序</span><select name="mobileSort" aria-label="按班级或地址排序"><option value="className:1" ${mobileSortValue === "className:1" ? "selected" : ""}>班级升序</option><option value="className:-1" ${mobileSortValue === "className:-1" ? "selected" : ""}>班级降序</option><option value="address:1" ${mobileSortValue === "address:1" ? "selected" : ""}>地址升序</option><option value="address:-1" ${mobileSortValue === "address:-1" ? "selected" : ""}>地址降序</option></select></label>
      <span class="result-count">${visible.length} 条记录</span>
    </div>
    ${visible.length ? `<div class="table-scroll"><table class="roster-table" style="--table-width:${tableWidth}px">
      <colgroup>${ROSTER_COLUMNS.map((column) => `<col data-column="${column.key}" style="width:${state.columnWidths[column.key]}px" />`).join("")}</colgroup>
      <thead><tr>${ROSTER_COLUMNS.map(renderRosterHeader).join("")}</tr></thead>
      <tbody>${pageRows.map((record, index) => renderRecordRow(record, offset + index)).join("")}</tbody>
    </table></div>
    <div class="mobile-records">${pageRows.map(renderMobileRecord).join("")}</div>
    ${renderPager(visible.length)}` : `<div class="empty-state"><span class="empty-mark" aria-hidden="true"></span><h2>${state.records.length ? "没有匹配的学生" : "暂无学生"}</h2>${state.records.length ? "" : `<button class="button button-primary" type="button" data-action="new-record">添加学生</button>`}</div>`}
  </section>`;
}

function groupRecords(key) {
  const groups = new Map();
  for (const record of state.records) {
    const label = String(record[key] || "未填写");
    if (!groups.has(label)) groups.set(label, { label, total: 0, pending: 0, checked: 0, absent: 0, leave: 0 });
    const item = groups.get(label);
    item.total += 1;
    item[record.status in item ? record.status : "pending"] += 1;
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN", { numeric: true }));
}

function renderDistribution(summary) {
  const colors = {
    checked: "var(--status-checked-mark)",
    pending: "var(--status-pending-mark)",
    absent: "var(--status-absent-mark)",
    leave: "var(--status-leave-mark)"
  };
  return `<div class="distribution-list">${STATUS.map((item) => {
    const amount = summary[item.value];
    const percent = summary.total ? Math.round((amount / summary.total) * 100) : 0;
    return `<div class="distribution-item"><div class="distribution-label"><span><i class="status-dot dot-${item.value}"></i>${item.label}</span><strong>${amount}</strong></div><div class="distribution-track"><span style="width:${percent}%;--bar-color:${colors[item.value]}"></span></div></div>`;
  }).join("")}</div>`;
}

function renderGroupStats() {
  const groups = groupRecords(state.dimension);
  const label = state.dimension === "className" ? "班级" : "地址";
  return `<div class="group-stats-wrap">${groups.length ? `<table class="group-stats-table"><thead><tr><th>${label}</th><th>人数</th><th>已签到</th><th>未签到</th><th>缺席</th><th>请假</th><th>签到率</th></tr></thead>
    <tbody>${groups.map((group) => `<tr><td title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</td><td>${group.total}</td><td><span class="count-positive">${group.checked}</span></td><td>${group.pending}</td><td><span class="count-negative">${group.absent}</span></td><td><span class="count-leave">${group.leave}</span></td><td><div class="rate-cell"><span>${Math.round((group.checked / group.total) * 100)}%</span><div class="rate-track"><i style="width:${Math.round((group.checked / group.total) * 100)}%"></i></div></div></td></tr>`).join("")}</tbody>
  </table>` : `<div class="empty-state compact-empty">暂无统计数据</div>`}</div>`;
}

function renderStatistics() {
  const summary = summarize(state.records);
  return `<section class="statistics-view">
    <div class="statistics-grid">
      <section class="stat-panel"><div class="panel-heading"><div><h2>签到状态</h2><span>全体学生</span></div><strong class="panel-total">${summary.total}</strong></div>${renderDistribution(summary)}</section>
      <section class="stat-panel dimension-panel"><div class="panel-heading"><div><h2>人数分布</h2><span>${state.dimension === "className" ? "按班级" : "按地址"}</span></div><div class="segmented" role="group" aria-label="统计维度"><button type="button" data-action="dimension" data-dimension="className" class="${state.dimension === "className" ? "selected" : ""}">班级</button><button type="button" data-action="dimension" data-dimension="address" class="${state.dimension === "address" ? "selected" : ""}">地址</button></div></div>${renderGroupStats()}</section>
    </div>
  </section>`;
}

function renderWorkspace() {
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><div class="topbar-inner"><div class="brand-lockup"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span><span>班级名册</span></div><div class="topbar-actions"><span class="save-indicator ${state.saving ? "is-saving" : ""}"><i></i>${state.saving ? "保存中" : state.updatedAt ? `已保存 ${formatTime(state.updatedAt)}` : "已解锁"}</span><button class="button button-secondary button-small" type="button" data-action="logout">锁定</button></div></div></header>
    <main class="workspace">
      <div class="page-heading"><div><h1>${state.activeTab === "roster" ? "学生名册" : "统计概览"}</h1><p>${state.records.length} 名学生</p></div><div class="page-actions">${state.activeTab === "roster" ? `<button class="button button-secondary" type="button" data-action="import">导入 Excel</button><button class="button button-primary" type="button" data-action="new-record">添加学生</button>` : ""}</div></div>
      ${renderMetrics()}
      <nav class="view-tabs" aria-label="名册视图"><button type="button" data-action="tab" data-tab="roster" class="${state.activeTab === "roster" ? "active" : ""}">名册</button><button type="button" data-action="tab" data-tab="statistics" class="${state.activeTab === "statistics" ? "active" : ""}">统计</button></nav>
      ${state.activeTab === "roster" ? renderRoster() : renderStatistics()}
    </main>
  </div>
  <dialog id="record-dialog" class="dialog"></dialog>
  <dialog id="import-dialog" class="dialog import-dialog"><form method="dialog" class="dialog-form"><div class="dialog-heading"><div><span class="dialog-kicker">名册数据</span><h2>导入 Excel</h2></div><button class="close-button" value="cancel" aria-label="关闭" formnovalidate>×</button></div><label class="file-picker"><span>选择文件</span><input id="import-file" type="file" accept=".xlsx,.xls,.csv" /></label><fieldset class="import-mode"><legend>导入方式</legend><label class="import-mode-option"><input type="radio" name="importMode" value="merge" checked /><span><strong>更新并追加</strong><small>按学生姓名和班级匹配，更新已有记录并新增未匹配记录</small></span></label><label class="import-mode-option import-mode-danger"><input type="radio" name="importMode" value="replace" /><span><strong>清空全部后导入</strong><small>先删除当前名册，再导入文件中的记录</small></span></label></fieldset><div id="import-preview" class="import-preview"></div><div class="dialog-actions"><button class="button button-secondary" value="cancel">取消</button><button class="button button-primary" type="button" data-action="confirm-import" disabled>导入</button></div></form></dialog>`;
  bindWorkspaceEvents();
  bindRosterColumnResizeEvents();
}

function setRosterColumnWidth(table, handle, column, width) {
  const nextWidth = clampColumnWidth(column, width);
  state.columnWidths[column.key] = nextWidth;
  table.querySelector(`col[data-column="${column.key}"]`)?.style.setProperty("width", `${nextWidth}px`);
  handle.setAttribute("aria-valuenow", String(nextWidth));
  const totalWidth = ROSTER_COLUMNS.reduce((total, item) => total + state.columnWidths[item.key], 0);
  table.style.setProperty("--table-width", `${totalWidth}px`);
}

function saveRosterColumnWidths() {
  try {
    localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(state.columnWidths));
  } catch {
    return;
  }
}

function bindRosterColumnResizeEvents() {
  const table = document.querySelector(".roster-table");
  if (!table) return;

  table.querySelectorAll("[data-column-resizer]").forEach((handle) => {
    const column = ROSTER_COLUMNS.find((item) => item.key === handle.dataset.columnResizer);
    if (!column) return;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = state.columnWidths[column.key];
      handle.classList.add("is-dragging");
      handle.setPointerCapture(pointerId);

      const move = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        setRosterColumnWidth(table, handle, column, startWidth + moveEvent.clientX - startX);
      };
      const finish = (finishEvent) => {
        if (finishEvent.pointerId !== pointerId) return;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        handle.classList.remove("is-dragging");
        saveRosterColumnWidths();
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    });

    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const change = event.key === "ArrowRight" ? 10 : -10;
      setRosterColumnWidth(table, handle, column, state.columnWidths[column.key] + change);
      saveRosterColumnWidths();
    });
  });
}

function render() {
  if (state.key) renderWorkspace();
  else renderLogin();
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "已保存";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(value) {
  let binary = "";
  const bytes = new Uint8Array(value);
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: base64ToBytes(salt), iterations: 600_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function requestJson(path, method, body) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "request_failed");
    error.status = response.status;
    throw error;
  }
  return result;
}

function errorMessage(error) {
  if (error.message === "invalid_password") return "密码错误";
  if (error.message === "invalid_setup_token") return "设置码错误或已失效";
  if (error.message === "already_initialized") return "名册已完成初始化，请刷新后使用访问密码登录";
  if (error.message === "legacy_password_required") return "此名册已有加密数据，需要恢复原访问密码";
  if (error.message === "password_not_configured") return "访问密码尚未配置，请检查部署设置";
  if (error.message === "database_not_configured" || error.message === "database_error") return "数据服务暂不可用，请检查 D1 配置";
  if (error.message === "Failed to fetch") return "无法连接数据服务，请检查网络或部署配置";
  return "数据无法解密，密码或名册数据不匹配";
}

async function initializeAuth() {
  try {
    const status = await requestJson("/api/status", "GET");
    state.authMode = ["login", "setup"].includes(status.mode) ? status.mode : "unavailable";
    if (state.authMode === "unavailable") state.authError = "访问密码尚未配置，请检查部署设置";
  } catch (error) {
    state.authMode = "unavailable";
    state.authError = errorMessage(error);
  }
  renderLogin();
}

async function handleUnlock(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const password = String(formData.get("password") || "");
  const isSetup = state.authMode === "setup";
  if (isSetup && password !== String(formData.get("passwordConfirm") || "")) {
    state.authError = "两次输入的访问密码不一致";
    renderLogin();
    return;
  }
  state.authError = "";
  state.saving = true;
  renderLogin();
  try {
    const vault = isSetup
      ? await requestJson("/api/setup", "POST", { setupToken: String(formData.get("setupToken") || ""), password })
      : await requestJson("/api/unlock", "POST", { password });
    state.authMode = "login";
    const key = await deriveKey(password, vault.salt);
    let records = [];
    if (vault.iv && vault.ciphertext) {
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(vault.iv) }, key, base64ToBytes(vault.ciphertext));
      const payload = JSON.parse(decoder.decode(plaintext));
      if (!payload || payload.version !== 1 || !Array.isArray(payload.records)) throw new Error("invalid_vault");
      records = payload.records.map(normalizeRecord);
    }
    state.password = password;
    state.key = key;
    state.salt = vault.salt;
    state.records = records;
    state.updatedAt = vault.updatedAt || "";
    state.authError = "";
    state.saving = !vault.iv || !vault.ciphertext;
    render();
    if (state.saving) {
      await persistRecords();
      state.saving = false;
      render();
    }
  } catch (error) {
    state.password = "";
    state.key = null;
    state.salt = "";
    state.records = [];
    state.saving = false;
    if (error.message === "already_initialized") state.authMode = "login";
    state.authError = errorMessage(error);
    renderLogin();
    document.querySelector(isSetup ? "#setup-token" : "#password")?.focus();
  }
}

function normalizeRecord(record) {
  return {
    id: String(record.id || crypto.randomUUID()),
    studentName: String(record.studentName || ""),
    className: String(record.className || ""),
    parentName: String(record.parentName || ""),
    phone: String(record.phone || ""),
    address: String(record.address || ""),
    status: STATUS.some((item) => item.value === record.status) ? record.status : "pending",
    updatedAt: String(record.updatedAt || "")
  };
}

async function persistRecords() {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = encoder.encode(JSON.stringify({ version: 1, records: state.records, updatedAt: new Date().toISOString() }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, state.key, payload);
  const result = await requestJson("/api/vault", "PUT", {
    password: state.password,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext)
  });
  state.updatedAt = result.updatedAt;
}

async function saveWithSnapshot(previousRecords) {
  if (state.saving) return false;
  state.saving = true;
  render();
  try {
    await persistRecords();
    return true;
  } catch (error) {
    state.records = previousRecords;
    window.alert(`保存失败：${errorMessage(error)}`);
    return false;
  } finally {
    state.saving = false;
    render();
  }
}

function bindWorkspaceEvents() {
  app.onclick = async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const { action } = button.dataset;
    if (action === "tab") {
      state.activeTab = button.dataset.tab;
      render();
    } else if (action === "dimension") {
      state.dimension = button.dataset.dimension;
      render();
    } else if (action === "sort") {
      const key = button.dataset.key;
      if (state.sortKey === key) state.sortDirection *= -1;
      else {
        state.sortKey = key;
        state.sortDirection = 1;
      }
      state.page = 0;
      render();
    } else if (action === "page") {
      state.page = Number(button.dataset.page);
      render();
    } else if (action === "new-record") {
      openRecordDialog();
    } else if (action === "edit") {
      openRecordDialog(state.records.find((record) => record.id === button.dataset.id));
    } else if (action === "delete") {
      await deleteRecord(button.dataset.id);
    } else if (action === "import") {
      openImportDialog();
    } else if (action === "confirm-import") {
      await confirmImport();
    } else if (action === "logout") {
      lockApp();
    }
  };

  app.onchange = async (event) => {
    const target = event.target;
    if (target.matches("[name=classFilter]")) {
      state.classFilter = target.value;
      state.page = 0;
      render();
    } else if (target.matches("[name=statusFilter]")) {
      state.statusFilter = target.value;
      state.page = 0;
      render();
    } else if (target.matches("[name=mobileSort]")) {
      const [key, direction] = target.value.split(":");
      state.sortKey = key === "address" ? "address" : "className";
      state.sortDirection = direction === "-1" ? -1 : 1;
      state.page = 0;
      render();
    } else if (target.matches("[data-action=status]")) {
      await updateStatus(target.dataset.id, target.value);
    } else if (target.matches("[name=importMode]")) {
      state.importMode = target.value === "replace" ? "replace" : "merge";
      renderImportPreview();
    } else if (target.matches("#import-file")) {
      await readImportFile(target.files?.[0]);
    }
  };

  app.oninput = (event) => {
    if (!event.target.matches("[name=search]")) return;
    const position = event.target.selectionStart;
    state.search = event.target.value;
    state.page = 0;
    render();
    const input = document.querySelector("[name=search]");
    input?.focus();
    input?.setSelectionRange(position, position);
  };

  app.onsubmit = async (event) => {
    if (!event.target.matches("#record-form")) return;
    event.preventDefault();
    await submitRecordForm(event.target);
  };
}

async function updateStatus(id, status) {
  if (!STATUS.some((item) => item.value === status) || state.saving) return;
  const previous = structuredClone(state.records);
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  record.status = status;
  record.updatedAt = new Date().toISOString();
  await saveWithSnapshot(previous);
}

async function deleteRecord(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record || !window.confirm(`删除“${record.studentName}”的名册记录？`)) return;
  const previous = structuredClone(state.records);
  state.records = state.records.filter((item) => item.id !== id);
  await saveWithSnapshot(previous);
}

function openRecordDialog(record) {
  const editing = Boolean(record);
  const current = record || { studentName: "", className: "", parentName: "", phone: "", address: "", status: "pending" };
  const dialog = document.querySelector("#record-dialog");
  dialog.innerHTML = `<form id="record-form" class="dialog-form"><div class="dialog-heading"><div><span class="dialog-kicker">${editing ? "编辑记录" : "新建记录"}</span><h2>${editing ? "学生信息" : "添加学生"}</h2></div><button class="close-button" type="button" data-action="close-record" aria-label="关闭">×</button></div>
    <div class="form-grid">
      <label>学生姓名<input name="studentName" required maxlength="80" value="${escapeHtml(current.studentName)}" /></label>
      <label>班级<input name="className" required maxlength="80" value="${escapeHtml(current.className)}" /></label>
      <label>家长姓名<input name="parentName" maxlength="80" value="${escapeHtml(current.parentName)}" /></label>
      <label>家长电话<input name="phone" type="tel" maxlength="40" value="${escapeHtml(current.phone)}" /></label>
      <label class="form-wide">地址<input name="address" maxlength="300" value="${escapeHtml(current.address)}" /></label>
      <label>签到状态<select name="status">${STATUS.map((item) => `<option value="${item.value}" ${current.status === item.value ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
    </div><div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-record">取消</button><button class="button button-primary" type="submit" ${state.saving ? "disabled" : ""}>保存</button></div></form>`;
  dialog.querySelectorAll('[data-action="close-record"]').forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.querySelector("form").dataset.id = record?.id || "";
  dialog.showModal();
  dialog.querySelector("[name=studentName]")?.focus();
}

async function submitRecordForm(form) {
  if (state.saving) return;
  const previous = structuredClone(state.records);
  const values = Object.fromEntries(new FormData(form).entries());
  const id = form.dataset.id;
  const normalized = normalizeRecord({ ...values, id: id || crypto.randomUUID(), updatedAt: new Date().toISOString() });
  if (id) state.records = state.records.map((record) => record.id === id ? normalized : record);
  else state.records = [...state.records, normalized];
  document.querySelector("#record-dialog")?.close();
  await saveWithSnapshot(previous);
}

function openImportDialog() {
  state.importPreview = null;
  state.importMode = "merge";
  const dialog = document.querySelector("#import-dialog");
  dialog.querySelector("#import-file").value = "";
  dialog.querySelector('[name="importMode"][value="merge"]').checked = true;
  renderImportPreview();
  dialog.showModal();
}

function normalizeHeader(value) {
  return String(value || "").toLocaleLowerCase("zh-CN").replace(/[\s_\-:：()（）.]/g, "");
}

const HEADER_ALIASES = {
  studentName: ["学生姓名", "学生名字", "学生", "姓名", "studentname", "student"],
  className: ["班级", "班级名称", "class", "classname"],
  parentName: ["家长姓名", "监护人姓名", "父母姓名", "家长", "监护人", "parentname", "guardian"],
  phone: ["家长电话", "家长手机号", "联系电话", "手机号", "电话号码", "电话", "phone", "mobile", "parentphone"],
  address: ["家庭住址", "家庭地址", "详细地址", "地址", "address"],
  status: ["签到状态", "考勤状态", "状态", "status"]
};

function findImportColumns(headerRow) {
  const headers = headerRow.map(normalizeHeader);
  return Object.fromEntries(Object.entries(HEADER_ALIASES).map(([field, aliases]) => [
    field,
    headers.findIndex((header) => aliases.includes(header))
  ]));
}

function normalizeImportedStatus(value) {
  const status = normalizeHeader(value);
  if (["已签到", "签到", "到校", "出席", "present", "checked"].includes(status)) return "checked";
  if (["缺席", "未到", "旷课", "absent"].includes(status)) return "absent";
  if (["请假", "病假", "事假", "leave"].includes(status)) return "leave";
  return "pending";
}

function importRecordKey(record) {
  const normalize = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  return `${normalize(record.studentName)}\u0000${normalize(record.className)}`;
}

function countImportChanges(imported) {
  const keys = new Set(state.importMode === "replace" ? [] : state.records.map(importRecordKey));
  let added = 0;
  let updated = 0;
  for (const record of imported) {
    const key = importRecordKey(record);
    if (keys.has(key)) updated += 1;
    else added += 1;
    keys.add(key);
  }
  return { added, updated };
}

async function readImportFile(file) {
  if (!file) return;
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: "", blankrows: false });
    if (!rows.length) throw new Error("empty_file");
    const columns = findImportColumns(rows[0]);
    if (columns.studentName < 0 || columns.className < 0) throw new Error("missing_columns");
    const providedFields = Object.entries(columns).filter(([, column]) => column >= 0).map(([field]) => field);
    const imported = [];
    let skipped = 0;
    for (const row of rows.slice(1)) {
      const studentName = String(row[columns.studentName] || "").trim();
      const className = String(row[columns.className] || "").trim();
      if (!studentName || !className) {
        skipped += 1;
        continue;
      }
      const read = (column) => column < 0 ? "" : String(row[column] || "").trim();
      imported.push({
        ...normalizeRecord({
          id: crypto.randomUUID(),
          studentName,
          className,
          parentName: read(columns.parentName),
          phone: read(columns.phone),
          address: read(columns.address),
          status: normalizeImportedStatus(read(columns.status)),
          updatedAt: new Date().toISOString()
        }),
        providedFields
      });
    }
    state.importPreview = { fileName: file.name, imported, skipped, error: imported.length ? "" : "no_records" };
  } catch (error) {
    state.importPreview = {
      fileName: file.name,
      imported: [],
      skipped: 0,
      error: error.message === "missing_columns" ? "未识别到学生姓名或班级列" : error.message === "empty_file" ? "文件中没有数据" : "文件读取失败"
    };
  }
  renderImportPreview();
}

function renderImportPreview() {
  const preview = state.importPreview;
  const output = document.querySelector("#import-preview");
  const button = document.querySelector('[data-action="confirm-import"]');
  if (!output || !button) return;
  if (!preview) {
    output.innerHTML = "";
    button.disabled = true;
    button.textContent = "导入";
    return;
  }
  if (preview.error) {
    output.innerHTML = `<p class="import-error" role="alert">${escapeHtml(preview.error)}</p>`;
    button.disabled = true;
    button.textContent = "导入";
    return;
  }
  const samples = preview.imported.slice(0, 4);
  const counts = countImportChanges(preview.imported);
  const summary = state.importMode === "replace"
    ? `清空 ${state.records.length} 条，导入 ${counts.added + counts.updated} 条`
    : `更新 ${counts.updated} 条，新增 ${counts.added} 条`;
  output.innerHTML = `<div class="import-summary"><strong>${summary}</strong><span>${preview.skipped ? `跳过 ${preview.skipped} 行` : ""}</span><span class="file-name">${escapeHtml(preview.fileName)}</span></div><div class="preview-table-wrap"><table class="preview-table"><thead><tr><th>学生姓名</th><th>班级</th><th>家长姓名</th><th>签到状态</th></tr></thead><tbody>${samples.map((item) => `<tr><td>${escapeHtml(item.studentName)}</td><td>${escapeHtml(item.className)}</td><td>${escapeHtml(item.parentName)}</td><td>${statusLabel(item.status)}</td></tr>`).join("")}</tbody></table></div>`;
  button.disabled = !preview.imported.length || state.saving;
  button.textContent = state.importMode === "replace"
    ? `清空并导入 ${preview.imported.length} 条`
    : `更新并导入 ${preview.imported.length} 条`;
}

async function confirmImport() {
  const preview = state.importPreview;
  if (!preview?.imported.length || state.saving) return;
  if (state.importMode === "replace" && !window.confirm(`将清空现有 ${state.records.length} 条名册记录，并导入文件中的数据。继续吗？`)) return;
  const previous = structuredClone(state.records);
  const nextRecords = state.importMode === "replace" ? [] : structuredClone(state.records);
  const recordIndexes = new Map();
  nextRecords.forEach((record, index) => {
    const key = importRecordKey(record);
    if (!recordIndexes.has(key)) recordIndexes.set(key, index);
  });
  for (const importedRecord of preview.imported) {
    const { providedFields, ...record } = importedRecord;
    const key = importRecordKey(record);
    const existingIndex = recordIndexes.get(key);
    if (existingIndex !== undefined) {
      const merged = { ...nextRecords[existingIndex], updatedAt: new Date().toISOString() };
      for (const field of providedFields) merged[field] = record[field];
      nextRecords[existingIndex] = normalizeRecord(merged);
    } else {
      recordIndexes.set(key, nextRecords.length);
      nextRecords.push(normalizeRecord(record));
    }
  }
  state.records = nextRecords;
  state.page = 0;
  document.querySelector("#import-dialog")?.close();
  await saveWithSnapshot(previous);
}

async function lockApp() {
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  state.password = "";
  state.key = null;
  state.salt = "";
  state.records = [];
  state.updatedAt = "";
  state.search = "";
  state.classFilter = "";
  state.statusFilter = "";
  state.page = 0;
  state.activeTab = "roster";
  state.authError = "";
  render();
}

render();
initializeAuth();
