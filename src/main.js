import "./styles.css";
import { version as APP_VERSION } from "../package.json";

const app = document.querySelector("#app");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PAGE_SIZE = 40;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;
const MAX_CIPHERTEXT_LENGTH = 1_800_000;
let searchTimer;
let composingSearch = false;
let importReadId = 0;
const STATUS = [
  { value: "pending", label: "未签到" },
  { value: "checked", label: "已签到" },
  { value: "absent", label: "缺席" },
  { value: "leave", label: "请假" }
];
const ROSTER_COLUMNS = [
  { key: "serial", label: "序号", width: 48, min: 44, max: 120 },
  { key: "studentName", label: "学生姓名", width: 112, min: 80, max: 320 },
  { key: "className", label: "班级", width: 104, min: 75, max: 220 },
  { key: "parentName", label: "家长姓名", width: 110, min: 80, max: 300 },
  { key: "phone", label: "家长电话", width: 140, min: 110, max: 280 },
  { key: "address", label: "地址", width: 460, min: 160, max: 720 },
  { key: "status", label: "签到状态", width: 118, min: 108, max: 190 },
  { key: "actions", label: "操作", width: 116, min: 116, max: 240 }
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
  addressFilter: "",
  statusFilter: "",
  page: 0,
  saving: false,
  authError: "",
  importPreview: null,
  importReading: false,
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

function statusSelect(record) {
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
        <span class="brand-text"><span>班级名册</span><span class="app-version" aria-label="应用版本 ${escapeHtml(APP_VERSION)}">v${escapeHtml(APP_VERSION)}</span></span>
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
        ${canSubmit ? `<button class="button button-primary auth-submit" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? (isSetup ? "正在创建…" : "正在解锁…") : isSetup ? "创建密码并进入" : "进入名册"}</button>` : state.authMode === "unavailable" ? '<button class="button button-primary" type="button" id="retry-auth">重新连接</button>' : ""}
      </form>
    </section>
  </main>`;
  if (canSubmit) document.querySelector("#unlock-form")?.addEventListener("submit", handleUnlock);
  document.querySelector("#retry-auth")?.addEventListener("click", initializeAuth);
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
    .filter((record) => !state.addressFilter || record.address === state.addressFilter)
    .filter((record) => !state.statusFilter || (record.status || "pending") === state.statusFilter)
    .filter((record) => !query || [record.studentName, record.className, record.parentName, record.phone, record.address]
      .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query)))
    .sort((a, b) => String(a[state.sortKey] || "").localeCompare(String(b[state.sortKey] || ""), "zh-CN", { numeric: true }) * state.sortDirection
      || a.className.localeCompare(b.className, "zh-CN", { numeric: true })
      || a.studentName.localeCompare(b.studentName, "zh-CN", { numeric: true }));
}

function sortHeader(key, label) {
  const selected = state.sortKey === key;
  return `<button class="sort-button ${selected ? "is-active" : ""}" type="button" data-action="sort" data-key="${key}" aria-label="按${label}${selected && state.sortDirection === -1 ? "降序" : "升序"}排序">
    ${label}<span class="sort-indicator ${selected ? (state.sortDirection === 1 ? "ascending" : "descending") : ""}" aria-hidden="true"></span>
  </button>`;
}

function renderRecordRow(record, index) {
  return `<tr class="roster-row status-${escapeHtml(record.status || "pending")}" data-id="${escapeHtml(record.id)}">
    <td class="serial-cell">${index + 1}</td>
    <td class="student-cell"><strong>${escapeHtml(record.studentName)}</strong></td>
    <td>${escapeHtml(record.className)}</td>
    <td>${escapeHtml(record.parentName) || "<span class=muted>—</span>"}</td>
    <td>${record.phone ? `<a class="phone-link" href="tel:${encodeURIComponent(record.phone)}">${escapeHtml(record.phone)}</a>` : "<span class=muted>—</span>"}</td>
    <td class="address-cell" title="${escapeHtml(record.address)}">${escapeHtml(record.address) || "<span class=muted>—</span>"}</td>
    <td>${statusSelect(record)}</td>
    <td class="row-actions"><button type="button" class="text-button" data-action="edit" data-id="${escapeHtml(record.id)}">编辑</button><button type="button" class="text-button text-danger" data-action="delete" data-id="${escapeHtml(record.id)}">删除</button></td>
  </tr>`;
}

function renderMobileRecord(record, index) {
  return `<li class="mobile-record status-${escapeHtml(record.status || "pending")}" data-id="${escapeHtml(record.id)}">
    <div class="mobile-record-heading">
      <div class="mobile-identity"><span class="mobile-serial" aria-label="序号 ${index + 1}">${index + 1}</span><button class="mobile-cell-button mobile-student-name" type="button" data-action="edit" data-id="${escapeHtml(record.id)}" aria-label="查看或编辑${escapeHtml(record.studentName)}的信息">${escapeHtml(record.studentName)}</button></div>
      <button class="mobile-cell-button mobile-class" type="button" data-action="filter-class" data-value="${escapeHtml(record.className)}" aria-label="筛选班级：${escapeHtml(record.className)}">${escapeHtml(record.className)}</button>
    </div>
    ${statusSelect(record)}
    ${record.address ? `<button class="mobile-cell-button mobile-address" type="button" data-action="filter-address" data-value="${escapeHtml(record.address)}" aria-label="筛选同地址学生：${escapeHtml(record.address)}"><span class="mobile-field-label">地址</span><span>${escapeHtml(record.address)}</span></button>` : '<div class="mobile-address"><span class="mobile-field-label">地址</span><span class="muted">未填写</span></div>'}
  </li>`;
}

function renderPager(total, page) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages < 2) return "";
  const first = page * PAGE_SIZE + 1;
  const last = Math.min((page + 1) * PAGE_SIZE, total);
  return `<div class="pager"><span class="pager-info"><span>第 ${first}–${last} 人 / 共 ${total} 人</span><span>第 ${page + 1} / ${pages} 页</span></span><div><button class="button button-secondary button-small" type="button" data-action="page" data-page="${page - 1}" ${page === 0 ? "disabled" : ""}>上一页</button><button class="button button-secondary button-small" type="button" data-action="page" data-page="${page + 1}" ${page >= pages - 1 ? "disabled" : ""}>下一页</button></div></div>`;
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
  return `<th scope="col" data-column="${column.key}"${column.key === "serial" ? ' class="serial-cell"' : ""}>${content}<span class="column-resizer" data-column-resizer="${column.key}" role="separator" aria-orientation="vertical" aria-label="调整${column.label}列宽" aria-valuemin="${column.min}" aria-valuemax="${column.max}" aria-valuenow="${width}" title="拖动调整列宽" tabindex="0"></span></th>`;
}

function renderRoster() {
  const visible = getVisibleRecords();
  const mobileSortValue = `${state.sortKey}:${state.sortDirection}`;
  const resettableCount = state.records.filter((record) => (record.status || "pending") !== "pending").length;
  return `<section class="roster-view">
    <div class="roster-toolbar">
      <div class="search-wrap"><input type="search" name="search" value="${escapeHtml(state.search)}" placeholder="搜索姓名、班级或地址关键词" aria-label="搜索名册" autocomplete="off" enterkeyhint="search" /></div>
      <label class="filter-control"><span>班级</span><select name="classFilter">${renderFilterOptions("className", state.classFilter)}</select></label>
      <label class="filter-control"><span>地址</span><select name="addressFilter">${renderFilterOptions("address", state.addressFilter)}</select></label>
      <label class="filter-control"><span>状态</span><select name="statusFilter"><option value="">全部</option>${STATUS.map((item) => `<option value="${item.value}" ${state.statusFilter === item.value ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
      <label class="filter-control mobile-sort-control"><span>排序</span><select name="mobileSort" aria-label="按班级或地址排序"><option value="className:1" ${mobileSortValue === "className:1" ? "selected" : ""}>班级升序</option><option value="className:-1" ${mobileSortValue === "className:-1" ? "selected" : ""}>班级降序</option><option value="address:1" ${mobileSortValue === "address:1" ? "selected" : ""}>地址升序</option><option value="address:-1" ${mobileSortValue === "address:-1" ? "selected" : ""}>地址降序</option></select></label>
      <button class="button button-secondary button-small desktop-only" type="button" data-action="reset-columns">恢复列宽</button>
      <button class="button button-secondary button-small reset-status-button desktop-only" type="button" data-action="reset-status" title="重置全体学生的签到状态" ${!resettableCount || state.saving ? "disabled" : ""}>重置全部签到</button>
    </div>
    <div class="filter-summary">${renderFilterSummary(visible.length)}</div>
    <p class="mobile-list-hint">点姓名查看详情，点班级或地址筛选；状态修改后自动保存</p>
    <div id="roster-results">${renderRosterResults(visible)}</div>
  </section>`;
}

function renderFilterOptions(key, selected) {
  const values = [...new Set([...state.records.map((record) => record[key]), selected].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  return `<option value="">全部</option>${values.map((value) => `<option value="${escapeHtml(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}`;
}

function renderFilterSummary(total) {
  const filters = [
    ["classFilter", "班级", state.classFilter],
    ["addressFilter", "地址", state.addressFilter],
    ["statusFilter", "状态", state.statusFilter ? statusLabel(state.statusFilter) : ""],
    ["search", "搜索", state.search.trim()]
  ].filter(([, , value]) => value);
  return `<div class="filter-summary-heading"><span class="result-count" role="status">${filters.length ? `筛选 ${total} 人 / 共 ${state.records.length} 人` : `共 ${total} 人`}</span>${filters.length ? '<button class="text-button" type="button" data-action="clear-filters">清除全部筛选</button>' : ""}</div>
    ${filters.length ? `<div class="filter-chips">${filters.map(([key, label, value]) => `<button class="filter-chip" type="button" data-action="clear-filter" data-filter="${key}" aria-label="取消${label}筛选：${escapeHtml(value)}"><span>${label}：${escapeHtml(value)}</span><span aria-hidden="true">×</span></button>`).join("")}</div>` : ""}`;
}

function renderRosterResults(visible) {
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const page = Math.max(0, Math.min(state.page, pages - 1));
  // 保存中的人数变化只是临时结果，保留原页码以便失败时恢复。
  if (!state.saving) state.page = page;
  const offset = page * PAGE_SIZE;
  const pageRows = visible.slice(offset, offset + PAGE_SIZE);
  const tableWidth = ROSTER_COLUMNS.reduce((total, column) => total + state.columnWidths[column.key], 0);
  return visible.length ? `<div class="table-scroll" role="region" aria-label="完整学生信息核对表" tabindex="0"><table class="roster-table" style="--table-width:${tableWidth}px">
      <colgroup>${ROSTER_COLUMNS.map((column) => `<col data-column="${column.key}" style="width:${state.columnWidths[column.key]}px" />`).join("")}</colgroup>
      <thead><tr>${ROSTER_COLUMNS.map(renderRosterHeader).join("")}</tr></thead>
      <tbody>${pageRows.map((record, index) => renderRecordRow(record, offset + index)).join("")}</tbody>
    </table></div>
    <ol class="mobile-records" start="${offset + 1}" role="list" aria-label="学生列表">${pageRows.map((record, index) => renderMobileRecord(record, offset + index)).join("")}</ol>
    ${renderPager(visible.length, page)}` : `<div class="empty-state"><span class="empty-mark" aria-hidden="true"></span><h2>${state.records.length ? "没有匹配的学生" : "暂无学生"}</h2>${state.records.length ? '<button class="button button-secondary" type="button" data-action="clear-filters">清除筛选</button>' : `<button class="button button-primary" type="button" data-action="new-record">添加学生</button>`}</div>`;
}

function updateRosterResults() {
  const output = document.querySelector("#roster-results");
  if (!output) return;
  const visible = getVisibleRecords();
  document.querySelector(".filter-summary").innerHTML = renderFilterSummary(visible.length);
  const previousScroll = output.querySelector(".table-scroll");
  const scrollLeft = previousScroll?.scrollLeft || 0;
  const scrollTop = previousScroll?.scrollTop || 0;
  output.innerHTML = renderRosterResults(visible);
  const nextScroll = output.querySelector(".table-scroll");
  if (nextScroll) {
    nextScroll.scrollLeft = scrollLeft;
    nextScroll.scrollTop = scrollTop;
  }
  bindRosterColumnResizeEvents();
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
  const rosterActions = '<button class="button button-primary" type="button" data-action="import">导入 Excel</button><button class="button button-secondary" type="button" data-action="new-record">添加学生</button>';
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><div class="topbar-inner"><div class="brand-lockup"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span><span class="brand-text"><span>班级名册</span><span class="app-version" aria-label="应用版本 ${escapeHtml(APP_VERSION)}">v${escapeHtml(APP_VERSION)}</span></span></div><div class="topbar-actions">${renderSaveIndicator()}<button class="button button-secondary button-small" type="button" data-action="logout">锁定</button></div></div></header>
    <main class="workspace ${state.activeTab === "roster" ? "roster-workspace" : ""}">
      <div class="page-heading"><div><h1>${state.activeTab === "roster" ? "学生名册" : "统计概览"}</h1><p>${state.records.length} 名学生</p></div>${state.activeTab === "roster" ? `<div class="page-actions desktop-only">${rosterActions}</div><details class="mobile-management"><summary class="button button-secondary button-small">管理</summary><div class="management-menu">${rosterActions}<button class="button button-secondary reset-status-button" type="button" data-action="reset-status">重置全部签到</button></div></details>` : ""}</div>
      ${renderMetrics()}
      <nav class="view-tabs" aria-label="名册视图"><button type="button" data-action="tab" data-tab="roster" class="${state.activeTab === "roster" ? "active" : ""}">名册</button><button type="button" data-action="tab" data-tab="statistics" class="${state.activeTab === "statistics" ? "active" : ""}">统计</button></nav>
      ${state.activeTab === "roster" ? renderRoster() : renderStatistics()}
    </main>
  </div>
  <dialog id="record-dialog" class="dialog" aria-labelledby="record-dialog-title"></dialog>
  <dialog id="import-dialog" class="dialog import-dialog" aria-labelledby="import-dialog-title"><form method="dialog" class="dialog-form"><div class="dialog-heading"><div><span class="dialog-kicker">名册数据</span><h2 id="import-dialog-title">导入 Excel</h2></div><button class="close-button" value="cancel" aria-label="关闭" formnovalidate>×</button></div><label class="file-picker"><span>选择文件</span><input id="import-file" type="file" accept=".xlsx,.xls,.csv" /></label><fieldset class="import-mode"><legend>导入方式</legend><label class="import-mode-option"><input type="radio" name="importMode" value="merge" checked /><span><strong>更新并追加</strong><small>按学生姓名和班级匹配，更新已有记录并新增未匹配记录</small></span></label><label class="import-mode-option import-mode-danger"><input type="radio" name="importMode" value="replace" /><span><strong>清空全部后导入</strong><small>先删除当前名册，再导入文件中的记录</small></span></label></fieldset><div id="import-preview" class="import-preview" role="status"></div><div class="dialog-actions"><button class="button button-secondary" value="cancel">取消</button><button class="button button-primary" type="button" data-action="confirm-import" disabled>导入</button></div></form></dialog>`;
  bindWorkspaceEvents();
  bindRosterColumnResizeEvents();
  updateSavingControls();
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("cancel", (event) => {
      if (state.saving) event.preventDefault();
    });
  });
  document.querySelector("#import-dialog").addEventListener("close", () => {
    importReadId += 1;
    state.importReading = false;
  });
}

function renderSaveIndicator() {
  const label = state.saving ? "保存中…" : state.updatedAt ? "已保存" : "已解锁";
  let timestamp = "";
  if (!state.saving && state.updatedAt) {
    const date = new Date(state.updatedAt);
    if (Number.isNaN(date.getTime())) {
      timestamp = '<span class="save-time">时间未知</span>';
    } else {
      const formatted = new Intl.DateTimeFormat("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
      }).format(date);
      timestamp = `<time class="save-time" datetime="${date.toISOString()}">${formatted}</time>`;
    }
  }
  return `<span class="save-indicator ${state.saving ? "is-saving" : ""}" role="status" aria-atomic="true"><span class="save-label"><i aria-hidden="true"></i>${label}</span> ${timestamp}</span>`;
}

function updateSavingControls() {
  const actions = ["new-record", "edit", "delete", "import", "logout", "tab", "dimension", "filter-class", "filter-address", "reset-columns"];
  const selectors = actions.map((action) => `[data-action="${action}"]`);
  selectors.push(".status-select", "dialog input", "dialog select", "dialog button");
  document.querySelectorAll(selectors.join(",")).forEach((control) => { control.disabled = state.saving; });
  document.querySelectorAll('[data-action="reset-status"]').forEach((reset) => {
    reset.disabled = state.saving || !state.records.some((record) => record.status !== "pending");
  });
  renderImportPreview();
}

function refreshWorkspaceData() {
  document.querySelector(".save-indicator").outerHTML = renderSaveIndicator();
  document.querySelector(".metrics").outerHTML = renderMetrics();
  document.querySelector(".page-heading p").textContent = `${state.records.length} 名学生`;
  if (state.activeTab === "roster") {
    document.querySelector('[name="classFilter"]').innerHTML = renderFilterOptions("className", state.classFilter);
    document.querySelector('[name="addressFilter"]').innerHTML = renderFilterOptions("address", state.addressFilter);
    document.querySelector('[name="statusFilter"]').value = state.statusFilter;
    updateRosterResults();
  } else {
    document.querySelector(".statistics-view").outerHTML = renderStatistics();
  }
  updateSavingControls();
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
  clearTimeout(searchTimer);
  composingSearch = false;
  if (state.key) renderWorkspace();
  else renderLogin();
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "request_failed");
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("request_timeout");
    if (error instanceof TypeError) throw new Error("network_error");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error) {
  if (error.message === "invalid_password") return "密码错误";
  if (error.message === "invalid_setup_token") return "设置码错误或已失效";
  if (error.message === "already_initialized") return "名册已完成初始化，请刷新后使用访问密码登录";
  if (error.message === "legacy_password_required") return "此名册已有加密数据，需要恢复原访问密码";
  if (error.message === "password_not_configured") return "访问密码尚未配置，请检查部署设置";
  if (error.message === "database_not_configured" || error.message === "database_error") return "数据服务暂不可用，请检查 D1 配置";
  if (error.message === "network_error") return "无法连接数据服务，请检查网络后重试";
  if (error.message === "request_timeout") return "请求超时，尚未确认保存结果。请恢复网络后锁定并重新进入，确认最新数据";
  if (error.message === "vault_conflict") return "其他页面或设备已更新名册，本次修改未保存。请保留当前输入，锁定后重新进入再修改";
  if (error.message === "client_update_required") return "页面版本已过期，请保留当前输入并刷新页面后重试";
  if (error.message === "payload_too_large") return "名册数据超过保存上限，请减少记录或缩短过长内容后重试";
  if (error.message === "invalid_vault" || error.name === "OperationError") return "数据无法解密，密码或名册数据不匹配";
  return "请求失败，请稍后重试";
}

async function initializeAuth() {
  state.authMode = "loading";
  state.authError = "";
  renderLogin();
  if (!window.isSecureContext || !crypto.subtle) {
    state.authMode = "unavailable";
    state.authError = "当前地址不支持安全加密，请通过 HTTPS 或本机 localhost 打开";
    renderLogin();
    return;
  }
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
  if (state.saving) return;
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
  const encodedCiphertext = bytesToBase64(ciphertext);
  if (encodedCiphertext.length > MAX_CIPHERTEXT_LENGTH) throw new Error("payload_too_large");
  const result = await requestJson("/api/vault", "PUT", {
    password: state.password,
    baseUpdatedAt: state.updatedAt || null,
    iv: bytesToBase64(iv),
    ciphertext: encodedCiphertext
  });
  state.updatedAt = result.updatedAt;
}

async function saveWithSnapshot(previousRecords) {
  if (state.saving) return false;
  state.saving = true;
  refreshWorkspaceData();
  try {
    await persistRecords();
    return true;
  } catch (error) {
    state.records = previousRecords;
    window.alert(`保存失败：${errorMessage(error)}`);
    return false;
  } finally {
    state.saving = false;
    refreshWorkspaceData();
  }
}

function bindWorkspaceEvents() {
  app.onclick = async (event) => {
    const menu = document.querySelector(".mobile-management[open]");
    if (menu && !menu.contains(event.target)) menu.open = false;
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const { action } = button.dataset;
    button.closest(".mobile-management")?.removeAttribute("open");
    if (state.saving && ["new-record", "edit", "delete", "reset-status", "import", "confirm-import", "logout", "tab", "dimension"].includes(action)) return;
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
      document.querySelector(".roster-toolbar")?.scrollIntoView({ block: "start" });
    } else if (action === "clear-filters") {
      state.search = "";
      state.classFilter = "";
      state.addressFilter = "";
      state.statusFilter = "";
      state.page = 0;
      render();
    } else if (action === "clear-filter") {
      const key = button.dataset.filter;
      if (!["search", "classFilter", "addressFilter", "statusFilter"].includes(key)) return;
      state[key] = "";
      state.page = 0;
      render();
    } else if (action === "filter-class" || action === "filter-address") {
      state[action === "filter-class" ? "classFilter" : "addressFilter"] = button.dataset.value;
      state.page = 0;
      render();
      document.querySelector(".roster-toolbar")?.scrollIntoView({ block: "start" });
    } else if (action === "reset-columns") {
      state.columnWidths = Object.fromEntries(ROSTER_COLUMNS.map((column) => [column.key, column.width]));
      saveRosterColumnWidths();
      updateRosterResults();
    } else if (action === "new-record") {
      openRecordDialog();
    } else if (action === "edit") {
      openRecordDialog(state.records.find((record) => record.id === button.dataset.id));
    } else if (action === "delete") {
      await deleteRecord(button.dataset.id);
    } else if (action === "reset-status") {
      await resetAttendanceStatuses();
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
    } else if (target.matches("[name=addressFilter]")) {
      state.addressFilter = target.value;
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
    if (event.target.matches('#record-form input[required]')) event.target.setCustomValidity("");
    if (!event.target.matches("[name=search]") || event.isComposing || composingSearch) return;
    scheduleSearch(event.target.value);
  };
  app.onsubmit = async (event) => {
    if (!event.target.matches("#record-form")) return;
    event.preventDefault();
    await submitRecordForm(event.target);
  };
}

function scheduleSearch(value) {
  state.search = value;
  state.page = 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!state.key || state.activeTab !== "roster") return;
    updateRosterResults();
    updateSavingControls();
  }, 150);
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

async function resetAttendanceStatuses() {
  if (state.saving) return;
  const resettableCount = state.records.filter((record) => (record.status || "pending") !== "pending").length;
  if (!resettableCount || !window.confirm(`将全体 ${state.records.length} 名学生的签到状态重置为“未签到”，其中 ${resettableCount} 名学生的状态会变化。继续吗？`)) return;

  const previous = structuredClone(state.records);
  const updatedAt = new Date().toISOString();
  state.records = state.records.map((record) => (record.status || "pending") === "pending"
    ? record
    : { ...record, status: "pending", updatedAt });
  state.statusFilter = "";
  state.page = 0;
  await saveWithSnapshot(previous);
}

async function deleteRecord(id) {
  if (state.saving) return;
  const record = state.records.find((item) => item.id === id);
  if (!record || !window.confirm(`删除“${record.studentName}”的名册记录？`)) return;
  const previous = structuredClone(state.records);
  state.records = state.records.filter((item) => item.id !== id);
  if (await saveWithSnapshot(previous)) document.querySelector("#record-dialog")?.close();
}

function openRecordDialog(record) {
  if (state.saving) return;
  const editing = Boolean(record);
  const current = record || { studentName: "", className: "", parentName: "", phone: "", address: "", status: "pending" };
  const dialog = document.querySelector("#record-dialog");
  dialog.innerHTML = `<form id="record-form" class="dialog-form"><div class="dialog-heading"><div><span class="dialog-kicker">${editing ? "编辑记录" : "新建记录"}</span><h2 id="record-dialog-title" tabindex="-1">${editing ? "学生信息" : "添加学生"}</h2></div><button class="close-button" type="button" data-action="close-record" aria-label="关闭">×</button></div>
    <div class="form-grid">
      <label>学生姓名<input name="studentName" required maxlength="80" value="${escapeHtml(current.studentName)}" /></label>
      <label>班级<input name="className" required maxlength="80" value="${escapeHtml(current.className)}" /></label>
      <label>家长姓名<input name="parentName" maxlength="80" value="${escapeHtml(current.parentName)}" /></label>
      <label>家长电话<input name="phone" type="tel" maxlength="40" value="${escapeHtml(current.phone)}" /></label>
      <label class="form-wide">地址<input name="address" maxlength="300" value="${escapeHtml(current.address)}" /></label>
      <label>签到状态<select name="status">${STATUS.map((item) => `<option value="${item.value}" ${current.status === item.value ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
    </div><div class="dialog-actions">${editing ? `<button class="button button-danger delete-record-button" type="button" data-action="delete" data-id="${escapeHtml(record.id)}">删除</button>` : ""}<button class="button button-secondary" type="button" data-action="close-record">取消</button><button class="button button-primary" type="submit" ${state.saving ? "disabled" : ""}>保存</button></div></form>`;
  dialog.querySelectorAll('[data-action="close-record"]').forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.querySelector("form").dataset.id = record?.id || "";
  dialog.showModal();
  dialog.querySelector(matchMedia("(pointer: coarse)").matches ? "#record-dialog-title" : "[name=studentName]")?.focus({ preventScroll: true });
}

async function submitRecordForm(form) {
  if (state.saving) return;
  const previous = structuredClone(state.records);
  const values = Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, String(value).trim()]));
  for (const name of ["studentName", "className"]) {
    if (values[name]) continue;
    form.elements[name].setCustomValidity("请填写有效内容，不能只输入空格");
    form.elements[name].reportValidity();
    return;
  }
  const id = form.dataset.id;
  const normalized = normalizeRecord({ ...values, id: id || crypto.randomUUID(), updatedAt: new Date().toISOString() });
  if (id) state.records = state.records.map((record) => record.id === id ? normalized : record);
  else state.records = [...state.records, normalized];
  if (await saveWithSnapshot(previous)) document.querySelector("#record-dialog")?.close();
}

function openImportDialog() {
  if (state.saving) return;
  importReadId += 1;
  state.importReading = false;
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
  const readId = ++importReadId;
  state.importPreview = null;
  state.importReading = Boolean(file);
  renderImportPreview();
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error("file_too_large");
    const [XLSX, buffer] = await Promise.all([import("xlsx"), file.arrayBuffer()]);
    if (readId !== importReadId) return;
    const workbook = XLSX.read(buffer, { type: "array", cellDates: false, sheets: 0, sheetRows: MAX_IMPORT_ROWS + 2 });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) throw new Error("empty_file");
    const range = XLSX.utils.decode_range(firstSheet["!fullref"] || firstSheet["!ref"] || "A1");
    if (range.e.r > MAX_IMPORT_ROWS) throw new Error("too_many_rows");
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
    state.importPreview = { fileName: file.name, imported, skipped, error: imported.length ? "" : "没有有效记录，请检查学生姓名和班级" };
  } catch (error) {
    if (readId !== importReadId) return;
    const messages = {
      missing_columns: "未识别到学生姓名或班级列",
      empty_file: "文件中没有数据",
      file_too_large: "文件超过 10 MB，请拆分后再导入",
      too_many_rows: "首个工作表超过 5001 行（含表头和空行），请拆分后再导入"
    };
    state.importPreview = {
      fileName: file.name,
      imported: [],
      skipped: 0,
      error: messages[error.message] || "文件读取失败，请检查文件格式和网络后重试"
    };
  } finally {
    if (readId === importReadId) {
      state.importReading = false;
      renderImportPreview();
    }
  }
}

function renderImportPreview() {
  const preview = state.importPreview;
  const output = document.querySelector("#import-preview");
  const button = document.querySelector('[data-action="confirm-import"]');
  if (!output || !button) return;
  if (state.importReading) {
    output.textContent = "正在读取文件…";
    button.disabled = true;
    button.textContent = "正在读取…";
    return;
  }
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
  const samples = preview.imported.slice(0, 20);
  const counts = countImportChanges(preview.imported);
  const summary = state.importMode === "replace"
    ? `清空 ${state.records.length} 条，导入 ${counts.added + counts.updated} 条`
    : `更新 ${counts.updated} 条，新增 ${counts.added} 条`;
  const previewCell = (item, field) => !item.providedFields.includes(field)
    ? '<span class="muted">未提供</span>'
    : escapeHtml(field === "status" ? statusLabel(item.status) : item[field]) || "—";
  output.innerHTML = `<div class="import-summary"><strong>${summary}</strong><span>${preview.skipped ? `跳过 ${preview.skipped} 行` : ""}</span><span class="file-name" title="${escapeHtml(preview.fileName)}">${escapeHtml(preview.fileName)}</span></div><p class="preview-note">文件预览 ${samples.length} / ${preview.imported.length} 条；合并时保留未提供的列。导入后可在名册中核对全部信息。</p><div class="preview-table-wrap" tabindex="0" role="region" aria-label="导入数据预览"><table class="preview-table"><thead><tr><th scope="col">学生姓名</th><th scope="col">班级</th><th scope="col">家长姓名</th><th scope="col">家长电话</th><th scope="col">地址</th><th scope="col">签到状态</th></tr></thead><tbody>${samples.map((item) => `<tr>${["studentName", "className", "parentName", "phone", "address", "status"].map((field) => `<td>${previewCell(item, field)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
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
  if (await saveWithSnapshot(previous)) {
    state.search = "";
    state.classFilter = "";
    state.addressFilter = "";
    state.statusFilter = "";
    render();
  }
}

async function lockApp() {
  if (state.saving) return;
  clearTimeout(searchTimer);
  importReadId += 1;
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  state.password = "";
  state.key = null;
  state.salt = "";
  state.records = [];
  state.updatedAt = "";
  state.search = "";
  state.classFilter = "";
  state.addressFilter = "";
  state.statusFilter = "";
  state.page = 0;
  state.activeTab = "roster";
  state.authError = "";
  state.importPreview = null;
  state.importReading = false;
  render();
}

app.addEventListener("compositionstart", (event) => {
  if (!event.target.matches("[name=search]")) return;
  composingSearch = true;
  clearTimeout(searchTimer);
});

app.addEventListener("compositionend", (event) => {
  if (!event.target.matches("[name=search]")) return;
  composingSearch = false;
  scheduleSearch(event.target.value);
});

window.addEventListener("beforeunload", (event) => {
  if (!state.saving || !state.key) return;
  event.preventDefault();
  event.returnValue = "";
});

render();
initializeAuth();
