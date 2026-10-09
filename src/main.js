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

const state = {
  password: "",
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
  importPreview: null
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
  app.innerHTML = `<main class="auth-shell">
    <section class="auth-panel" aria-labelledby="login-title">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>
        <span>班级名册</span>
      </div>
      <h1 id="login-title">名册管理</h1>
      <form id="unlock-form">
        <label for="password">访问密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
        <p class="auth-error" role="alert">${escapeHtml(state.authError)}</p>
        <button class="button button-primary auth-submit" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "正在解锁…" : "进入名册"}</button>
      </form>
    </section>
  </main>`;
  document.querySelector("#unlock-form")?.addEventListener("submit", handleUnlock);
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
  return `<tr>
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

function renderMobileRecord(record, index) {
  return `<article class="mobile-record">
    <div class="mobile-record-head">
      <div><span class="mobile-serial">${index + 1}</span><h3>${escapeHtml(record.studentName)}</h3><span class="mobile-class">${escapeHtml(record.className)}</span></div>
      <button class="text-button" type="button" data-action="edit" data-id="${escapeHtml(record.id)}">编辑</button>
    </div>
    <div class="mobile-fields">
      <div><span>家长姓名</span><strong>${escapeHtml(record.parentName) || "—"}</strong></div>
      <div><span>家长电话</span>${record.phone ? `<a class="phone-link" href="tel:${encodeURIComponent(record.phone)}">${escapeHtml(record.phone)}</a>` : "<strong>—</strong>"}</div>
      <div class="mobile-address"><span>地址</span><strong>${escapeHtml(record.address) || "—"}</strong></div>
    </div>
    <div class="mobile-record-foot"><span>签到状态</span>${statusSelect(record, true)}</div>
  </article>`;
}

function renderPager(total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages < 2) return "";
  return `<div class="pager"><span>第 ${state.page + 1} / ${pages} 页</span><div><button class="button button-secondary button-small" type="button" data-action="page" data-page="${state.page - 1}" ${state.page === 0 ? "disabled" : ""}>上一页</button><button class="button button-secondary button-small" type="button" data-action="page" data-page="${state.page + 1}" ${state.page >= pages - 1 ? "disabled" : ""}>下一页</button></div></div>`;
}

function renderRoster() {
  const visible = getVisibleRecords();
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  if (state.page >= pages) state.page = pages - 1;
  const pageRows = visible.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const classes = [...new Set(state.records.map((record) => record.className).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const offset = state.page * PAGE_SIZE;
  return `<section class="roster-view">
    <div class="roster-toolbar">
      <div class="search-wrap"><input type="search" name="search" value="${escapeHtml(state.search)}" placeholder="搜索姓名、班级、电话或地址" aria-label="搜索名册" /></div>
      <label class="filter-control"><span>班级</span><select name="classFilter"><option value="">全部</option>${classes.map((name) => `<option value="${escapeHtml(name)}" ${state.classFilter === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>
      <label class="filter-control"><span>状态</span><select name="statusFilter"><option value="">全部</option>${STATUS.map((item) => `<option value="${item.value}" ${state.statusFilter === item.value ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
      <span class="result-count">${visible.length} 条记录</span>
    </div>
    ${visible.length ? `<div class="table-scroll"><table class="roster-table">
      <thead><tr><th class="serial-cell">序号</th><th>学生姓名</th><th>${sortHeader("className", "班级")}</th><th>家长姓名</th><th>家长电话</th><th>${sortHeader("address", "地址")}</th><th>签到状态</th><th>操作</th></tr></thead>
      <tbody>${pageRows.map((record, index) => renderRecordRow(record, offset + index)).join("")}</tbody>
    </table></div>
    <div class="mobile-records">${pageRows.map((record, index) => renderMobileRecord(record, offset + index)).join("")}</div>
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
  const colors = { checked: "#167b69", pending: "#8b9290", absent: "#c74d4d", leave: "#c28726" };
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
  <dialog id="import-dialog" class="dialog import-dialog"><form method="dialog" class="dialog-form"><div class="dialog-heading"><div><span class="dialog-kicker">名册数据</span><h2>导入 Excel</h2></div><button class="close-button" value="cancel" aria-label="关闭" formnovalidate>×</button></div><label class="file-picker"><span>选择文件</span><input id="import-file" type="file" accept=".xlsx,.xls,.csv" /></label><div id="import-preview" class="import-preview"></div><div class="dialog-actions"><button class="button button-secondary" value="cancel">取消</button><button class="button button-primary" type="button" data-action="confirm-import" disabled>导入</button></div></form></dialog>`;
  bindWorkspaceEvents();
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
  if (error.message === "password_not_configured") return "访问密码尚未配置，请检查 Cloudflare Secret";
  if (error.message === "database_not_configured" || error.message === "database_error") return "数据服务暂不可用，请检查 D1 配置";
  if (error.message === "Failed to fetch") return "无法连接数据服务，请检查网络或部署配置";
  return "数据无法解密，密码或名册数据不匹配";
}

async function handleUnlock(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const password = String(new FormData(form).get("password") || "");
  state.authError = "";
  state.saving = true;
  renderLogin();
  try {
    const vault = await requestJson("/api/unlock", "POST", { password });
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
    state.authError = error.status === 401 || error.message === "invalid_password" ? "密码错误" : errorMessage(error);
    renderLogin();
    document.querySelector("#password")?.focus();
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
    } else if (target.matches("[data-action=status]")) {
      await updateStatus(target.dataset.id, target.value);
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
  const dialog = document.querySelector("#import-dialog");
  dialog.querySelector("#import-file").value = "";
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

async function readImportFile(file) {
  if (!file) return;
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: "", blankrows: false });
    if (!rows.length) throw new Error("empty_file");
    const columns = findImportColumns(rows[0]);
    if (columns.studentName < 0 || columns.className < 0) throw new Error("missing_columns");
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
      imported.push(normalizeRecord({
        id: crypto.randomUUID(),
        studentName,
        className,
        parentName: read(columns.parentName),
        phone: read(columns.phone),
        address: read(columns.address),
        status: normalizeImportedStatus(read(columns.status)),
        updatedAt: new Date().toISOString()
      }));
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
  output.innerHTML = `<div class="import-summary"><strong>${preview.imported.length} 条可导入</strong><span>${preview.skipped ? `跳过 ${preview.skipped} 行` : ""}</span><span class="file-name">${escapeHtml(preview.fileName)}</span></div><div class="preview-table-wrap"><table class="preview-table"><thead><tr><th>学生姓名</th><th>班级</th><th>家长姓名</th><th>签到状态</th></tr></thead><tbody>${samples.map((item) => `<tr><td>${escapeHtml(item.studentName)}</td><td>${escapeHtml(item.className)}</td><td>${escapeHtml(item.parentName)}</td><td>${statusLabel(item.status)}</td></tr>`).join("")}</tbody></table></div>`;
  button.disabled = !preview.imported.length || state.saving;
  button.textContent = `导入 ${preview.imported.length} 条`;
}

async function confirmImport() {
  const preview = state.importPreview;
  if (!preview?.imported.length || state.saving) return;
  const previous = structuredClone(state.records);
  state.records = [...state.records, ...preview.imported];
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
