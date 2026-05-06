const CLIENT_KEY = "temp-warehouses-client-v2";
const EMPTY_STATE = {
  warehouses: [
    { id: "main", name: "المستودع الرئيسي", keeperId: "keeper-main", minAlert: 20 },
    { id: "nasiriya", name: "مستودع الناصرية", keeperId: "keeper-nasiriya", minAlert: 20 },
    { id: "safa", name: "مستودع الصفا", keeperId: "keeper-safa", minAlert: 20 }
  ],
  users: [
    { id: "admin", username: "ADMIN", name: "الأدمن", role: "admin", password: "1991", warehouseId: null, active: true },
    { id: "keeper-main", username: "MAIN", name: "أمين المستودع الرئيسي", role: "keeper", password: "1111", warehouseId: "main", active: true },
    { id: "keeper-nasiriya", username: "NASIRIYA", name: "أمين مستودع الناصرية", role: "keeper", password: "2222", warehouseId: "nasiriya", active: true },
    { id: "keeper-safa", username: "SAFA", name: "أمين مستودع الصفا", role: "keeper", password: "3333", warehouseId: "safa", active: true }
  ],
  items: [
    { id: "itm-1", name: "حليب نوسين", unit: "كرتون", barcodes: ["11111", "22222"], stock: { main: 80, nasiriya: 50, safa: 35 } },
    { id: "itm-2", name: "حليب نوسين", unit: "حبة", barcodes: ["11111", "22222"], stock: { main: 700, nasiriya: 500, safa: 320 } },
    { id: "itm-3", name: "مياه معدنية", unit: "كرتون", barcodes: ["33333"], stock: { main: 160, nasiriya: 70, safa: 95 } },
    { id: "itm-4", name: "عصير برتقال", unit: "كرتون", barcodes: ["44444", "44445"], stock: { main: 46, nasiriya: 18, safa: 22 } }
  ],
  transfers: [
    {
      id: "TR-1001",
      fromWarehouseId: "nasiriya",
      toWarehouseId: "safa",
      createdBy: "keeper-nasiriya",
      receiverId: "keeper-safa",
      status: "pending",
      locked: false,
      createdAt: "2026-05-06 09:15",
      approvedAt: null,
      note: "تحويل تجريبي",
      lines: [{ itemId: "itm-1", barcode: "11111", name: "حليب نوسين", unit: "كرتون", sentQty: 10, receivedQty: 10 }],
      history: [{ at: "2026-05-06 09:15", by: "keeper-nasiriya", action: "إنشاء التحويل" }]
    }
  ],
  notifications: [
    { id: "n-1", userId: "keeper-safa", transferId: "TR-1001", read: false, text: "تحويل جديد من مستودع الناصرية ينتظر الاستلام" }
  ],
  activity: [
    { at: "2026-05-06 09:15", by: "keeper-nasiriya", action: "إنشاء تحويل TR-1001" }
  ],
  settings: { dark: false }
};

let state = clone(EMPTY_STATE);
let client = loadClient();
let view = new URLSearchParams(window.location.search).get("view") || client.view || "dashboard";
let transferDraft = [];
let scannerStream = null;
let scannerOpen = false;
let menuOpen = false;
let refreshTimer = null;

const app = document.getElementById("app");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

window.addEventListener("error", (event) => {
  if (!app) return;
  app.innerHTML = `
    <div class="splash">
      <section class="card" style="max-width:520px">
        <div class="section"><h2>حدث خطأ في تحميل التطبيق</h2></div>
        <p class="muted">${event.message || "خطأ غير معروف"}</p>
        <button class="btn primary" onclick="location.reload()">إعادة التحميل</button>
      </section>
    </div>
  `;
});

window.addEventListener("unhandledrejection", (event) => {
  if (!app) return;
  app.innerHTML = `
    <div class="splash">
      <section class="card" style="max-width:520px">
        <div class="section"><h2>تعذر تحميل البيانات</h2></div>
        <p class="muted">${event.reason?.message || "راجع اتصال السيرفر ثم أعد التحميل"}</p>
        <button class="btn primary" onclick="location.reload()">إعادة التحميل</button>
      </section>
    </div>
  `;
});

function normalizeState(input) {
  const next = clone(EMPTY_STATE);
  if (!input || !Array.isArray(input.users) || !Array.isArray(input.warehouses)) return next;
  return {
    ...next,
    ...input,
    settings: { ...next.settings, ...(input.settings || {}) },
    transfers: Array.isArray(input.transfers) ? input.transfers : [],
    notifications: Array.isArray(input.notifications) ? input.notifications : [],
    activity: Array.isArray(input.activity) ? input.activity : []
  };
}

function loadClient() {
  try {
    return JSON.parse(localStorage.getItem(CLIENT_KEY)) || {};
  } catch {
    return {};
  }
}

function saveClient() {
  localStorage.setItem(CLIENT_KEY, JSON.stringify(client));
}

async function loadState() {
  try {
    const response = await fetch("/api/state", {
      headers: authHeaders()
    });
    if (response.status === 401) {
      client.token = null;
      client.userId = null;
      saveClient();
      state = normalizeState(null);
      return;
    }
    state = normalizeState(await response.json());
  } catch {
    state = normalizeState(null);
  }
  document.body.classList.toggle("dark", !!state.settings.dark);
}

async function persist() {
  if (!client.token) return;
  try {
    await fetch("/api/state", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify(state)
    });
  } catch {
    toast("تعذر الاتصال بالسيرفر، راجع تشغيل server.js");
  }
}

function authHeaders() {
  return client.token ? { Authorization: `Bearer ${client.token}` } : {};
}

function currentUser() {
  return state.users.find((user) => user.id === client.userId && user.active);
}

function isAdmin() {
  return currentUser()?.role === "admin";
}

function warehouseName(id) {
  return state.warehouses.find((warehouse) => warehouse.id === id)?.name || "-";
}

function userName(id) {
  return state.users.find((user) => user.id === id)?.name || "-";
}

function itemByBarcode(barcode) {
  const code = String(barcode || "").trim();
  return state.items.filter((item) => (item.barcodes || []).some((entry) => String(entry).trim() === code));
}

function splitBarcodes(value) {
  return String(value || "")
    .split(/[;,،\n\r]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function now() {
  return new Date().toLocaleString("ar-SA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function addActivity(action, transfer) {
  const user = currentUser();
  const entry = { at: now(), by: user?.id || "system", action };
  state.activity.unshift(entry);
  if (transfer) transfer.history.push(entry);
}

function toast(message) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function moneylessNumber(value) {
  return Number(value || 0).toLocaleString("ar-SA");
}

function statusLabel(status) {
  return { pending: "معلق", approved: "معتمد", rejected: "مرفوض" }[status] || status;
}

function render() {
  const user = currentUser();
  if (!user) {
    renderLogin();
    return;
  }

  const unread = notificationsForUser(user).filter((n) => !notificationRead(n, user.id)).length;
  app.innerHTML = `
    <div class="shell ${menuOpen ? "menu-open" : ""}">
      <header class="mobile-head">
        <button class="menu-toggle" data-action="toggleMenu" aria-label="فتح القائمة">⋮</button>
        <div>
          <b>مخازن التخزين المؤقت</b>
          <span>${user.role === "admin" ? "الأدمن" : warehouseName(user.warehouseId)}</span>
        </div>
      </header>
      <div class="menu-backdrop" data-action="closeMenu"></div>
      <aside class="side">
        <div class="logo">
          <b>مخازن التخزين المؤقت</b>
          <span>إدارة تحويلات ومخزون أونلاين</span>
        </div>
        <div class="profile">
          <b>${user.name}</b>
          <span>${user.role === "admin" ? "حساب الأدمن" : warehouseName(user.warehouseId)}</span>
        </div>
        <nav class="nav">
          ${nav("dashboard", "لوحة التحكم")}
          ${nav("transfers", `التحويلات${unread ? ` (${unread})` : ""}`)}
          ${nav("receive", "الاستلام")}
          ${nav("stock", "الأرصدة")}
          ${nav("items", "الأصناف")}
          ${nav("settings", "الإعدادات")}
          ${isAdmin() ? nav("users", "المستخدمون") : ""}
        </nav>
        <button class="logout" data-action="logout">تسجيل الخروج</button>
      </aside>
      <main class="main">${renderView()}</main>
    </div>
  `;
  bindCommon();
  bindView();
}

function nav(id, label) {
  return `<button class="${view === id ? "active" : ""}" data-view="${id}">${label}</button>`;
}

function renderLogin() {
  app.innerHTML = `
    <section class="login">
      <div class="login-hero">
        <div>
          <h1>مخازن التخزين المؤقت</h1>
          <p>نظام عربي لإدارة المخازن والتحويلات بين المستودعات، مع أرصدة مباشرة وموافقات استلام وسجل نشاط كامل.</p>
        </div>
        <p>المستودع الرئيسي، مستودع الناصرية، مستودع الصفا</p>
      </div>
      <form class="login-panel" id="loginForm">
        <h2>تسجيل الدخول</h2>
        <div class="field">
          <label>اسم المستخدم</label>
          <input id="username" autocomplete="username" />
        </div>
        <div class="field">
          <label>كلمة المرور</label>
          <input id="password" type="password" autocomplete="current-password" />
        </div>
        <button class="btn primary" type="submit">دخول للنظام</button>
        <div class="hint">
          الأدمن: ADMIN / 1991<br />
          الرئيسي: MAIN / 1111، الناصرية: NASIRIYA / 2222، الصفا: SAFA / 3333
        </div>
      </form>
    </section>
  `;
  document.getElementById("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    login();
  });
}

async function login() {
  const username = document.getElementById("username").value.trim().toUpperCase();
  const password = document.getElementById("password").value;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    if (!response.ok) {
      toast("بيانات الدخول غير صحيحة");
      return;
    }

    const result = await response.json();
    state = normalizeState(result.state);
    client.token = result.token;
    client.userId = result.user.id;
    client.view = "dashboard";
    view = "dashboard";
    saveClient();
    render();
  } catch {
    toast("تعذر الاتصال بالسيرفر");
  }
}

function renderTop(title, subtitle, extra = "") {
  return `
    <div class="top">
      <div><h1>${title}</h1><p>${subtitle}</p></div>
      <div class="tools">${extra}<button class="btn" data-action="toggleDark">الوضع الليلي</button></div>
    </div>
  `;
}

function renderView() {
  return ({
    dashboard: renderDashboard,
    transfers: renderTransfers,
    receive: renderReceive,
    stock: renderStock,
    items: renderItems,
    reports: renderReports,
    notifications: renderNotifications,
    settings: renderSettings,
    users: renderUsers
  }[view] || renderDashboard)();
}

function renderDashboard() {
  const transfers = visibleTransfers();
  const today = transfers.filter((t) => t.createdAt.includes(todayKey())).length;
  const low = lowStockRows().length;
  const totalStock = state.items.reduce((sum, item) => sum + Object.values(item.stock).reduce((a, b) => a + Number(b || 0), 0), 0);
  return `
    ${renderTop("لوحة التحكم", "مؤشرات مباشرة للمخزون والتحويلات")}
    <div class="grid stats">
      ${stat("إجمالي الأصناف", state.items.length)}
      ${stat("إجمالي التحويلات", transfers.length)}
      ${stat("تحويلات اليوم", today)}
      ${stat("تنبيهات النقص", low)}
    </div>
    <div class="grid two" style="margin-top:14px">
      <section class="card">
        <div class="section"><h2>آخر الحركات</h2><button class="btn" data-view="transfers">عرض الكل</button></div>
        ${transferTable(transfers.slice(0, 6))}
      </section>
      <section class="card">
        <div class="section"><h2>نشاط المستودعات</h2></div>
        ${warehouseBars()}
      </section>
    </div>
    <section class="card" style="margin-top:14px">
      <div class="section"><h2>الأصناف الأكثر حركة</h2></div>
      ${itemMovementBars()}
    </section>
  `;
}

function stat(label, value) {
  return `<section class="card stat"><b>${moneylessNumber(value)}</b><span class="muted">${label}</span></section>`;
}

function renderTransfers() {
  return `
    ${renderTop("التحويلات", "إنشاء تحويلات جديدة ومتابعة حالاتها", isAdmin() ? `<button class="btn primary" data-action="exportTransfers">تصدير Excel</button>` : "")}
    <div class="grid two">
      <section class="card">
        <div class="section"><h2>تحويل جديد</h2><button class="btn blue" data-action="openScanner">فتح الكاميرا</button></div>
        ${transferForm()}
      </section>
    </div>
    <section class="card" style="margin-top:14px">
      <div class="section"><h2>كل التحويلات</h2></div>
      ${filters()}
      ${transferTable(filteredTransfers())}
    </section>
    ${scannerOpen ? scannerOverlay() : ""}
  `;
}

function scannerOverlay() {
  return `
    <div class="scanner-overlay">
      <section class="scanner-panel">
        <div class="section">
          <h2>قارئ الباركود</h2>
          <button class="btn danger" data-action="stopScanner" type="button">إغلاق</button>
        </div>
        <video id="scannerVideo" muted playsinline></video>
        <p class="muted">وجه الكاميرا على الباركود. بعد القراءة يرجع التطبيق تلقائيًا لشاشة التحويل.</p>
      </section>
    </div>
  `;
}

function transferForm() {
  const user = currentUser();
  const fromOptions = state.warehouses.map((w) => `<option value="${w.id}" ${user.warehouseId === w.id ? "selected" : ""}>${w.name}</option>`).join("");
  const toOptions = state.warehouses.map((w) => `<option value="${w.id}">${w.name}</option>`).join("");
  return `
    <form id="transferForm" class="form">
      <div class="field">
        <label>من مستودع</label>
        <select id="fromWarehouse" ${user.role === "keeper" ? "disabled" : ""}>${fromOptions}</select>
      </div>
      <div class="field">
        <label>إلى مستودع</label>
        <select id="toWarehouse">${toOptions}</select>
      </div>
      <div class="field full">
        <label>بحث باسم الصنف</label>
        <input id="itemSearchInput" placeholder="اكتب اسم الصنف أو جزء منه أو الباركود" />
        <select id="itemSearchResults"><option value="">ابدأ البحث لاختيار صنف</option></select>
      </div>
      <div class="field">
        <label>باركود</label>
        <input id="barcodeInput" placeholder="امسح أو اكتب الباركود" value="${client.scannedBarcode || ""}" />
      </div>
      <div class="field">
        <label>الوحدة</label>
        <select id="unitSelect"><option value="">اكتب الباركود أولًا</option></select>
        <div id="barcodeMatchText" class="hint mini"></div>
      </div>
      <div class="field">
        <label>الكمية</label>
        <input id="qtyInput" type="number" min="1" value="1" />
      </div>
      <div class="field">
        <label>ملاحظة</label>
        <input id="noteInput" placeholder="اختياري" />
      </div>
      <div class="actions full">
        <button class="btn" type="button" data-action="addLine">إضافة للصنف</button>
        <button class="btn primary" type="submit">إرسال التحويل</button>
      </div>
      <div class="full">${draftTable()}</div>
    </form>
  `;
}

function draftTable() {
  if (!transferDraft.length) return `<div class="empty">لم يتم إضافة أصناف للتحويل بعد.</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>الباركود</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>تحكم</th></tr></thead>
        <tbody>${transferDraft.map((line, index) => `
          <tr>
            <td>${line.barcode}</td><td>${line.name}</td><td>${line.unit}</td><td>${line.sentQty}</td>
            <td><button class="btn danger" data-action="removeDraft" data-index="${index}" type="button">حذف</button></td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;
}

function filters() {
  return `
    <div class="filters">
      <input id="filterText" placeholder="بحث بالصنف أو الباركود أو رقم الحركة" value="${client.filterText || ""}" />
      <select id="filterWarehouse"><option value="">كل المستودعات</option>${state.warehouses.map((w) => `<option value="${w.id}" ${client.filterWarehouse === w.id ? "selected" : ""}>${w.name}</option>`).join("")}</select>
      <select id="filterStatus"><option value="">كل الحالات</option><option value="pending" ${client.filterStatus === "pending" ? "selected" : ""}>معلق</option><option value="approved" ${client.filterStatus === "approved" ? "selected" : ""}>معتمد</option><option value="rejected" ${client.filterStatus === "rejected" ? "selected" : ""}>مرفوض</option></select>
      <input id="filterDate" type="date" value="${client.filterDate || ""}" />
      <button class="btn" data-action="clearFilters">مسح الفلاتر</button>
    </div>
  `;
}

function visibleTransfers() {
  const user = currentUser();
  const sorted = [...state.transfers].sort((a, b) => b.id.localeCompare(a.id));
  if (user.role === "admin") return sorted;
  return sorted.filter((t) => t.fromWarehouseId === user.warehouseId || t.toWarehouseId === user.warehouseId);
}

function incomingPendingTransfers() {
  const user = currentUser();
  return [...state.transfers]
    .filter((t) => t.status === "pending" && (isAdmin() || t.toWarehouseId === user.warehouseId))
    .sort((a, b) => b.id.localeCompare(a.id));
}

function filteredTransfers() {
  let list = visibleTransfers();
  const text = (client.filterText || "").trim().toLowerCase();
  if (text) {
    list = list.filter((t) => {
      return t.id.toLowerCase().includes(text) || t.lines.some((l) => `${l.name} ${l.barcode}`.toLowerCase().includes(text));
    });
  }
  if (client.filterWarehouse) list = list.filter((t) => t.fromWarehouseId === client.filterWarehouse || t.toWarehouseId === client.filterWarehouse);
  if (client.filterStatus) list = list.filter((t) => t.status === client.filterStatus);
  if (client.filterDate) list = list.filter((t) => t.createdAt.startsWith(client.filterDate));
  return list;
}

function transferTable(transfers) {
  if (!transfers.length) return `<div class="empty">لا توجد تحويلات مطابقة.</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>رقم الحركة</th><th>من</th><th>إلى</th><th>الأصناف</th><th>الحالة</th><th>التاريخ</th><th>تحكم</th></tr></thead>
        <tbody>${transfers.map((t) => `
          <tr>
            <td>${t.id}</td>
            <td>${warehouseName(t.fromWarehouseId)}</td>
            <td>${warehouseName(t.toWarehouseId)}</td>
            <td>${t.lines.map((l) => `${l.name} - ${l.unit}: ${l.receivedQty ?? l.sentQty}`).join("<br>")}</td>
            <td><span class="badge ${t.status}">${statusLabel(t.status)}</span></td>
            <td>${t.createdAt}</td>
            <td>${transferActions(t)}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;
}

function transferActions(t) {
  const user = currentUser();
  const canReceive = t.status === "pending" && t.toWarehouseId === user.warehouseId;
  const admin = isAdmin();
  const buttons = [];
  if (canReceive || admin && t.status === "pending") buttons.push(`<button class="btn success" data-action="openReceive" data-id="${t.id}">استلام</button>`);
  if (admin) {
    buttons.push(`<button class="btn blue" data-action="printTransfer" data-id="${t.id}">طباعة</button>`);
    buttons.push(`<button class="btn danger" data-action="deleteTransfer" data-id="${t.id}">حذف</button>`);
  }
  return buttons.length ? `<div class="actions">${buttons.join("")}</div>` : `<span class="muted">لا يوجد</span>`;
}

function renderReceive() {
  const selected = state.transfers.find((t) => t.id === client.receiveTransferId && t.status === "pending");
  if (selected && (isAdmin() || selected.toWarehouseId === currentUser().warehouseId)) return receiveEditor(selected);
  const pending = incomingPendingTransfers();
  return `
    ${renderTop("الاستلام", "مراجعة التحويلات الواردة وتأكيد الكميات")}
    <section class="card">
      <div class="section"><h2>تحويلات معلقة للاستلام</h2></div>
      ${transferTable(pending)}
    </section>
  `;
}

function receiveEditor(transfer) {
  return `
    ${renderTop("استلام التحويل", `${transfer.id} من ${warehouseName(transfer.fromWarehouseId)} إلى ${warehouseName(transfer.toWarehouseId)}`)}
    <section class="card">
      <div class="section">
        <h2>أصناف الإذن</h2>
        <button class="btn" data-action="backReceive" type="button">رجوع</button>
      </div>
      <form id="receiveForm" class="form">
        <div class="table-wrap full">
          <table>
            <thead><tr><th>الصنف</th><th>الباركود</th><th>الوحدة</th><th>الكمية المرسلة</th><th>الكمية المستلمة</th></tr></thead>
            <tbody>${transfer.lines.map((line, index) => `
              <tr>
                <td>${line.name}</td>
                <td>${line.barcode}</td>
                <td>${line.unit}</td>
                <td>${line.sentQty}</td>
                <td><input id="receiveQty-${index}" type="number" min="0" value="${line.receivedQty ?? line.sentQty}" /></td>
              </tr>
            `).join("")}</tbody>
          </table>
        </div>
        <button class="btn primary full" type="submit">تأكيد استلام الإذن بالكامل</button>
      </form>
    </section>
  `;
}

function renderStock() {
  return `
    ${renderTop("الأرصدة", "كمية كل صنف في كل مستودع وتنبيهات النقص")}
    <section class="card">
      <div class="section"><h2>بحث وفلترة الأصناف</h2></div>
      <div class="filters">
        <input id="stockSearch" placeholder="اسم الصنف أو الباركود" value="${client.stockSearch || ""}" />
        <select id="stockWarehouse"><option value="">كل المستودعات</option>${state.warehouses.map((w) => `<option value="${w.id}" ${client.stockWarehouse === w.id ? "selected" : ""}>${w.name}</option>`).join("")}</select>
        <button class="btn primary" data-action="exportStock">تصدير الأرصدة</button>
        <button class="btn success" data-action="shareStockWhatsApp">مشاركة Excel واتساب</button>
      </div>
      ${stockTable()}
    </section>
  `;
}

function stockRows() {
  const text = (client.stockSearch || "").trim().toLowerCase();
  return state.items.filter((item) => {
    const hay = `${item.name} ${item.unit} ${item.barcodes.join(" ")}`.toLowerCase();
    return !text || hay.includes(text);
  });
}

function stockTable() {
  const warehouses = client.stockWarehouse ? state.warehouses.filter((w) => w.id === client.stockWarehouse) : state.warehouses;
  const rows = stockRows();
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>الباركود</th><th>الصنف</th><th>الوحدة</th>${warehouses.map((w) => `<th>${w.name}</th>`).join("")}<th>تنبيه</th></tr></thead>
        <tbody>${rows.map((item) => {
          const low = warehouses.some((w) => Number(item.stock[w.id] || 0) <= Number(w.minAlert || 0));
          return `<tr>
            <td>${item.barcodes.join(";")}</td><td>${item.name}</td><td>${item.unit}</td>
            ${warehouses.map((w) => `<td>${moneylessNumber(item.stock[w.id] || 0)}</td>`).join("")}
            <td>${low ? `<span class="badge pending">منخفض</span>` : `<span class="badge approved">جيد</span>`}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
  `;
}

function lowStockRows() {
  return state.items.flatMap((item) => state.warehouses
    .filter((w) => Number(item.stock[w.id] || 0) <= Number(w.minAlert || 0))
    .map((w) => ({ item, warehouse: w, qty: item.stock[w.id] || 0 })));
}

function renderItems() {
  return `
    ${renderTop("الأصناف", "إضافة وتعديل واستيراد الأصناف من Excel أو Google Sheets")}
    <div class="grid two">
      <section class="card">
        <div class="section"><h2>إضافة صنف</h2></div>
        <form id="itemForm" class="form">
          <div class="field"><label>الباركودات</label><input id="itemBarcodes" placeholder="11111;22222" required /></div>
          <div class="field"><label>اسم الصنف</label><input id="itemName" required /></div>
          <div class="field"><label>الوحدة</label><input id="itemUnit" placeholder="كرتون / حبة" required /></div>
          ${state.warehouses.map((w) => `<div class="field"><label>${w.name}</label><input id="stock-${w.id}" type="number" min="0" value="0" /></div>`).join("")}
          <button class="btn primary full" type="submit">حفظ الصنف</button>
        </form>
      </section>
      <section class="card">
        <div class="section"><h2>استيراد الأصناف</h2></div>
        <div class="field">
          <label>الصيغة: الباركود، اسم الصنف، الوحدة، الكمية اختيارية</label>
          <textarea id="importText" placeholder="11111;22222,حليب نوسين,كرتون,50"></textarea>
        </div>
        <div class="field" style="margin-top:10px">
          <label>رابط Google Sheets</label>
          <input id="sheetUrl" placeholder="ضع رابط الشيت هنا" />
        </div>
        <div class="actions" style="margin-top:10px">
          <input id="importFile" type="file" accept=".csv,.txt,.tsv" />
          <button class="btn primary" data-action="importItems">استيراد</button>
          <button class="btn" data-action="importSheet">استيراد من Google Sheets</button>
        </div>
      </section>
    </div>
    <section class="card" style="margin-top:14px">
      <div class="section"><h2>جدول الأصناف</h2></div>
      ${stockTable()}
    </section>
  `;
}

function renderReports() {
  return `
    ${renderTop("التقارير", "إحصائيات ورسوم بيانية ومؤشرات مخزنية", isAdmin() ? `<button class="btn primary" data-action="exportTransfers">تصدير الحركات</button><button class="btn" data-action="exportStock">تصدير الأرصدة</button>` : "")}
    <div class="grid three">
      ${stat("أكثر المستودعات نشاطًا", busiestWarehouse())}
      ${stat("الأصناف منخفضة الكمية", lowStockRows().length)}
      ${stat("الحركات المعتمدة", state.transfers.filter((t) => t.status === "approved").length)}
    </div>
    <div class="grid two" style="margin-top:14px">
      <section class="card"><div class="section"><h2>أرصدة المستودعات</h2></div>${stockBars()}</section>
      <section class="card"><div class="section"><h2>أكثر الأصناف حركة</h2></div>${itemMovementBars()}</section>
    </div>
  `;
}

function renderNotifications() {
  const user = currentUser();
  const notes = notificationsForUser(user);
  return `
    ${renderTop("الإشعارات", "تنبيهات التحويلات والحركات المهمة")}
    <section class="card">
      <div class="section"><h2>إشعاراتي</h2><button class="btn" data-action="readAll">تحديد الكل كمقروء</button></div>
      <div class="notice-list">${notes.length ? notes.map((n) => `<article class="notice"><b>${n.text}</b><p>${notificationRead(n, user.id) ? "مقروء" : "جديد"} - ${n.transferId}</p></article>`).join("") : `<div class="empty">لا توجد إشعارات.</div>`}</div>
    </section>
  `;
}

function notificationsForUser(user = currentUser()) {
  if (!user) return [];
  return state.notifications.filter((note) => {
    if (user.role === "admin") return true;
    if (note.userId === user.id) return true;
    if (note.warehouseId && note.warehouseId === user.warehouseId) return true;
    const transfer = state.transfers.find((entry) => entry.id === note.transferId);
    return transfer?.toWarehouseId === user.warehouseId || transfer?.createdBy === user.id;
  });
}

function notificationRead(note, userId) {
  return !!(note.readBy?.[userId] || note.read);
}

function renderSettings() {
  return `
    ${renderTop("الإعدادات", "إعدادات النظام والنسخ الاحتياطي")}
    <div class="grid two">
      <section class="card">
        <div class="section"><h2>نسخ احتياطي واستعادة</h2></div>
        <div class="actions">
          <button class="btn primary" data-action="backup">تنزيل نسخة احتياطية</button>
          <input id="restoreFile" type="file" accept=".json" />
          <button class="btn" data-action="restore">استعادة</button>
        </div>
      </section>
      <section class="card">
        <div class="section"><h2>حدود النقص</h2></div>
        <form id="alertForm" class="form">
          ${state.warehouses.map((w) => `<div class="field"><label>${w.name}</label><input id="alert-${w.id}" type="number" min="0" value="${w.minAlert || 0}" /></div>`).join("")}
          <button class="btn primary full">حفظ الحدود</button>
        </form>
      </section>
    </div>
  `;
}

function renderUsers() {
  if (!isAdmin()) return renderDashboard();
  return `
    ${renderTop("المستخدمون", "إنشاء أمناء المخازن وتعديل كلمات المرور")}
    <div class="grid two">
      <section class="card">
        <div class="section"><h2>إضافة مستخدم</h2></div>
        <form id="userForm" class="form">
          <div class="field"><label>الاسم</label><input id="newName" required /></div>
          <div class="field"><label>اسم المستخدم</label><input id="newUsername" required /></div>
          <div class="field"><label>كلمة المرور</label><input id="newPassword" required /></div>
          <div class="field"><label>الصلاحية</label><select id="newRole"><option value="keeper">أمين مستودع</option><option value="admin">أدمن</option></select></div>
          <div class="field full"><label>المستودع</label><select id="newWarehouse"><option value="">بدون</option>${state.warehouses.map((w) => `<option value="${w.id}">${w.name}</option>`).join("")}</select></div>
          <button class="btn primary full">إضافة</button>
        </form>
      </section>
      <section class="card">
        <div class="section"><h2>الحسابات</h2></div>
        <div class="table-wrap">
          <table><thead><tr><th>الاسم</th><th>المستخدم</th><th>الدور</th><th>المستودع</th><th>تحكم</th></tr></thead>
          <tbody>${state.users.map((u) => `<tr><td>${u.name}</td><td>${u.username}</td><td>${u.role}</td><td>${warehouseName(u.warehouseId)}</td><td><div class="actions"><button class="btn" data-action="changeUsername" data-id="${u.id}">اسم المستخدم</button><button class="btn" data-action="changePassword" data-id="${u.id}">كلمة المرور</button></div></td></tr>`).join("")}</tbody></table>
        </div>
      </section>
    </div>
  `;
}

function activityList(items) {
  return `<div class="notice-list">${items.length ? items.map((a) => `<article class="notice"><b>${a.action}</b><p>${userName(a.by)} - ${a.at}</p></article>`).join("") : `<div class="empty">لا يوجد نشاط.</div>`}</div>`;
}

function warehouseBars() {
  const counts = state.warehouses.map((w) => ({ label: w.name, value: state.transfers.filter((t) => t.fromWarehouseId === w.id || t.toWarehouseId === w.id).length }));
  return bars(counts);
}

function stockBars() {
  const counts = state.warehouses.map((w) => ({ label: w.name, value: state.items.reduce((sum, item) => sum + Number(item.stock[w.id] || 0), 0) }));
  return bars(counts);
}

function itemMovementBars() {
  const map = {};
  state.transfers.forEach((t) => t.lines.forEach((l) => map[l.name] = (map[l.name] || 0) + Number(l.receivedQty || l.sentQty || 0)));
  return bars(Object.entries(map).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 6));
}

function bars(rows) {
  if (!rows.length) return `<div class="empty">لا توجد بيانات.</div>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="bars">${rows.map((r) => `<div class="bar-row"><div class="bar-meta"><b>${r.label}</b><span>${moneylessNumber(r.value)}</span></div><div class="bar"><span style="width:${Math.max(4, r.value / max * 100)}%"></span></div></div>`).join("")}</div>`;
}

function busiestWarehouse() {
  const rows = state.warehouses.map((w) => ({ name: w.name, count: state.transfers.filter((t) => t.fromWarehouseId === w.id || t.toWarehouseId === w.id).length }));
  return rows.sort((a, b) => b.count - a.count)[0]?.name || "-";
}

function bindCommon() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    view = button.dataset.view;
    client.view = view;
    menuOpen = false;
    saveClient();
    render();
  }));
  document.querySelector("[data-action='logout']")?.addEventListener("click", () => {
    stopScanner();
    fetch("/api/logout", { method: "POST", headers: authHeaders() }).catch(() => {});
    client.token = null;
    client.userId = null;
    saveClient();
    render();
  });
  document.querySelector("[data-action='toggleMenu']")?.addEventListener("click", () => {
    menuOpen = !menuOpen;
    render();
  });
  document.querySelector("[data-action='closeMenu']")?.addEventListener("click", () => {
    menuOpen = false;
    render();
  });
  document.querySelectorAll("[data-action='toggleDark']").forEach((button) => button.addEventListener("click", async () => {
    state.settings.dark = !state.settings.dark;
    document.body.classList.toggle("dark", state.settings.dark);
    await persist();
  }));
}

function bindView() {
  bindFilters();
  document.getElementById("barcodeInput")?.addEventListener("input", updateUnitOptions);
  document.getElementById("itemSearchInput")?.addEventListener("input", updateItemSearchResults);
  document.getElementById("itemSearchResults")?.addEventListener("change", selectSearchedItem);
  document.querySelector("[data-action='addLine']")?.addEventListener("click", addDraftLine);
  if (document.getElementById("barcodeInput")?.value) updateUnitOptions();
  document.getElementById("transferForm")?.addEventListener("submit", createTransfer);
  document.querySelectorAll("[data-action='removeDraft']").forEach((b) => b.addEventListener("click", () => { transferDraft.splice(Number(b.dataset.index), 1); render(); }));
  document.querySelectorAll("[data-action='openReceive']").forEach((b) => b.addEventListener("click", () => openReceive(b.dataset.id)));
  document.querySelector("[data-action='backReceive']")?.addEventListener("click", backReceive);
  document.getElementById("receiveForm")?.addEventListener("submit", confirmReceive);
  document.querySelectorAll("[data-action='deleteTransfer']").forEach((b) => b.addEventListener("click", () => deleteTransfer(b.dataset.id)));
  document.querySelectorAll("[data-action='printTransfer']").forEach((b) => b.addEventListener("click", () => printTransfer(b.dataset.id)));
  document.querySelector("[data-action='exportTransfers']")?.addEventListener("click", exportTransfers);
  document.querySelector("[data-action='exportStock']")?.addEventListener("click", exportStock);
  document.querySelector("[data-action='shareStockWhatsApp']")?.addEventListener("click", shareStockWhatsApp);
  document.querySelector("[data-action='openScanner']")?.addEventListener("click", openScanner);
  document.querySelectorAll("[data-action='stopScanner']").forEach((button) => button.addEventListener("click", stopScanner));
  document.getElementById("itemForm")?.addEventListener("submit", createItem);
  document.querySelector("[data-action='importItems']")?.addEventListener("click", importItems);
  document.querySelector("[data-action='importSheet']")?.addEventListener("click", importSheet);
  document.querySelector("[data-action='readAll']")?.addEventListener("click", readAll);
  document.querySelector("[data-action='backup']")?.addEventListener("click", backup);
  document.querySelector("[data-action='restore']")?.addEventListener("click", restore);
  document.getElementById("alertForm")?.addEventListener("submit", saveAlerts);
  document.getElementById("userForm")?.addEventListener("submit", createUser);
  document.querySelectorAll("[data-action='changeUsername']").forEach((b) => b.addEventListener("click", () => changeUsername(b.dataset.id)));
  document.querySelectorAll("[data-action='changePassword']").forEach((b) => b.addEventListener("click", () => changePassword(b.dataset.id)));
}

function bindFilters() {
  [["filterText", "input"], ["filterWarehouse", "change"], ["filterStatus", "change"], ["filterDate", "change"], ["stockSearch", "input"], ["stockWarehouse", "change"]].forEach(([id, eventName]) => {
    document.getElementById(id)?.addEventListener(eventName, (event) => {
      client[id] = event.target.value;
      if (id === "filterText") client.filterText = event.target.value;
      if (id === "filterWarehouse") client.filterWarehouse = event.target.value;
      if (id === "filterStatus") client.filterStatus = event.target.value;
      if (id === "filterDate") client.filterDate = event.target.value;
      saveClient();
      render();
    });
  });
  document.querySelector("[data-action='clearFilters']")?.addEventListener("click", () => {
    client.filterText = "";
    client.filterWarehouse = "";
    client.filterStatus = "";
    client.filterDate = "";
    saveClient();
    render();
  });
}

function updateUnitOptions() {
  const barcode = document.getElementById("barcodeInput").value.trim();
  const select = document.getElementById("unitSelect");
  const matchText = document.getElementById("barcodeMatchText");
  const matches = itemByBarcode(barcode);
  select.innerHTML = matches.length ? matches.map((item) => `<option value="${item.id}">${item.name} - ${item.unit}</option>`).join("") : `<option value="">لا يوجد صنف مطابق</option>`;
  if (matchText) {
    matchText.textContent = matches.length ? `تم العثور على ${matches.length} وحدة: ${[...new Set(matches.map((item) => item.unit))].join("، ")}` : "";
  }
}

function updateItemSearchResults() {
  const query = document.getElementById("itemSearchInput").value.trim().toLowerCase();
  const select = document.getElementById("itemSearchResults");
  if (!select) return;
  if (!query) {
    select.innerHTML = `<option value="">ابدأ البحث لاختيار صنف</option>`;
    return;
  }
  const words = query.split(/\s+/).filter(Boolean);
  const matches = state.items
    .map((item) => {
      const hay = `${item.name} ${item.unit} ${(item.barcodes || []).join(" ")}`.toLowerCase();
      const score = words.reduce((sum, word) => sum + (hay.includes(word) ? 1 : 0), 0);
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, 30)
    .map((row) => row.item);
  select.innerHTML = matches.length
    ? `<option value="">اختر الصنف</option>${matches.map((item) => `<option value="${item.id}">${item.name} - ${item.unit} - ${item.barcodes.join(";")}</option>`).join("")}`
    : `<option value="">لا توجد نتائج مطابقة</option>`;
}

function selectSearchedItem() {
  const item = state.items.find((entry) => entry.id === document.getElementById("itemSearchResults").value);
  if (!item) return;
  document.getElementById("barcodeInput").value = item.barcodes[0] || "";
  updateUnitOptions();
  document.getElementById("unitSelect").value = item.id;
  document.getElementById("qtyInput")?.focus();
}

function addDraftLine(options = {}) {
  const barcode = document.getElementById("barcodeInput").value.trim();
  const itemId = document.getElementById("unitSelect").value;
  const qty = Number(document.getElementById("qtyInput").value);
  const item = state.items.find((entry) => entry.id === itemId);
  if (!barcode || !item || qty <= 0) {
    if (!options.silent) toast("أدخل باركود صحيح ووحدة وكمية");
    return false;
  }
  transferDraft.push({ itemId: item.id, barcode, name: item.name, unit: item.unit, sentQty: qty, receivedQty: qty });
  client.scannedBarcode = "";
  saveClient();
  document.getElementById("barcodeInput").value = "";
  document.getElementById("qtyInput").value = 1;
  if (!options.silent) render();
  return true;
}

async function createTransfer(event) {
  event.preventDefault();
  const user = currentUser();
  const fromWarehouseId = user.role === "keeper" ? user.warehouseId : document.getElementById("fromWarehouse").value;
  const toWarehouseId = document.getElementById("toWarehouse").value;
  if (!fromWarehouseId || !toWarehouseId || fromWarehouseId === toWarehouseId) {
    toast("اختر مستودعين مختلفين");
    return;
  }
  if (!transferDraft.length) {
    addDraftLine({ silent: true });
    if (!transferDraft.length) {
      toast("أضف صنف واحد على الأقل");
      return;
    }
  }
  const receiverId = state.warehouses.find((w) => w.id === toWarehouseId)?.keeperId || "admin";
  const transfer = {
    id: `TR-${Date.now().toString().slice(-6)}`,
    fromWarehouseId,
    toWarehouseId,
    createdBy: user.id,
    receiverId,
    status: "pending",
    locked: false,
    createdAt: now(),
    approvedAt: null,
    note: document.getElementById("noteInput").value,
    lines: clone(transferDraft),
    history: []
  };
  addActivity(`إنشاء تحويل ${transfer.id}`, transfer);
  state.transfers.unshift(transfer);
  state.notifications.unshift({
    id: `n-${Date.now()}`,
    userId: receiverId,
    warehouseId: toWarehouseId,
    transferId: transfer.id,
    read: false,
    readBy: {},
    text: `تحويل جديد من ${warehouseName(fromWarehouseId)} إلى ${warehouseName(toWarehouseId)}`
  });
  transferDraft = [];
  await persist();
  await loadState();
  client.view = "transfers";
  client.filterStatus = "pending";
  client.filterWarehouse = toWarehouseId;
  saveClient();
  render();
  toast(`تم إرسال التحويل بنجاح رقم ${transfer.id}`);
  alert(`تم إرسال التحويل بنجاح\nرقم الإذن: ${transfer.id}`);
}

function openReceive(id) {
  client.receiveTransferId = id;
  client.view = "receive";
  view = "receive";
  saveClient();
  render();
}

function backReceive() {
  client.receiveTransferId = "";
  saveClient();
  render();
}

async function confirmReceive(event) {
  event.preventDefault();
  const transfer = state.transfers.find((t) => t.id === client.receiveTransferId);
  if (!transfer || transfer.status !== "pending") return;
  transfer.lines.forEach((line, index) => {
    const qty = Number(document.getElementById(`receiveQty-${index}`)?.value);
    if (qty >= 0) line.receivedQty = qty;
  });
  applyTransfer(transfer);
  transfer.status = "approved";
  transfer.locked = true;
  transfer.approvedAt = now();
  addActivity(`اعتماد استلام التحويل ${transfer.id}`, transfer);
  state.notifications.unshift({ id: `n-${Date.now()}`, userId: transfer.createdBy, warehouseId: transfer.fromWarehouseId, transferId: transfer.id, read: false, readBy: {}, text: `تم اعتماد استلام التحويل ${transfer.id}` });
  client.receiveTransferId = "";
  await persist();
  render();
  toast("تم اعتماد الاستلام وتحديث الأرصدة");
}

function applyTransfer(transfer) {
  if (transfer.applied) return;
  transfer.lines.forEach((line) => {
    const item = state.items.find((entry) => entry.id === line.itemId);
    if (!item) return;
    const qty = Number(line.receivedQty ?? line.sentQty);
    item.stock[transfer.fromWarehouseId] = Number(item.stock[transfer.fromWarehouseId] || 0) - qty;
    item.stock[transfer.toWarehouseId] = Number(item.stock[transfer.toWarehouseId] || 0) + qty;
  });
  transfer.applied = true;
}

async function deleteTransfer(id) {
  if (!isAdmin() || !confirm("هل تريد حذف الحركة؟")) return;
  state.transfers = state.transfers.filter((t) => t.id !== id);
  state.notifications = state.notifications.filter((n) => n.transferId !== id);
  addActivity(`حذف الحركة ${id}`);
  await persist();
  render();
}

function printTransfer(id) {
  const transfer = state.transfers.find((t) => t.id === id);
  if (!transfer) return;
  const html = `
    <html lang="ar" dir="rtl"><head><title>${transfer.id}</title><style>body{font-family:Tahoma;padding:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px;text-align:right}</style></head>
    <body><h1>تحويل ${transfer.id}</h1><p>${warehouseName(transfer.fromWarehouseId)} إلى ${warehouseName(transfer.toWarehouseId)}</p>
    <table><thead><tr><th>الصنف</th><th>الوحدة</th><th>المرسل</th><th>المستلم</th></tr></thead><tbody>${transfer.lines.map((l) => `<tr><td>${l.name}</td><td>${l.unit}</td><td>${l.sentQty}</td><td>${l.receivedQty}</td></tr>`).join("")}</tbody></table></body></html>`;
  const win = window.open("", "_blank");
  win.document.write(html);
  win.document.close();
  win.print();
}

async function createItem(event) {
  event.preventDefault();
  const item = {
    id: `itm-${Date.now()}`,
    barcodes: splitBarcodes(document.getElementById("itemBarcodes").value),
    name: document.getElementById("itemName").value.trim(),
    unit: document.getElementById("itemUnit").value.trim(),
    stock: {}
  };
  state.warehouses.forEach((w) => item.stock[w.id] = Number(document.getElementById(`stock-${w.id}`).value || 0));
  state.items.push(item);
  addActivity(`إضافة صنف ${item.name}`);
  await persist();
  render();
}

async function importItems() {
  const file = document.getElementById("importFile")?.files?.[0];
  let text = document.getElementById("importText").value;
  if (file) text = await file.text();
  await importItemsFromText(text);
}

async function importSheet() {
  const url = document.getElementById("sheetUrl")?.value.trim();
  if (!url) {
    toast("ضع رابط Google Sheets أولًا");
    return;
  }
  try {
    const response = await fetch(toGoogleCsvUrl(url));
    if (!response.ok) throw new Error("sheet");
    const text = await response.text();
    await importItemsFromText(text);
  } catch {
    toast("تعذر استيراد الشيت. تأكد أن الرابط متاح للقراءة أو منشور CSV");
  }
}

async function importItemsFromText(text) {
  const rows = parseImportRows(text);
  if (!rows.length) {
    toast("لا توجد أصناف صالحة للاستيراد");
    return;
  }
  rows.forEach((parts) => {
    const [barcodes, name, unit, qty] = parts;
    const stock = {};
    state.warehouses.forEach((w) => stock[w.id] = 0);
    stock.main = Number(qty || 0);
    state.items.push({ id: `itm-${Date.now()}-${Math.random().toString(16).slice(2)}`, barcodes: splitBarcodes(barcodes), name: name.trim(), unit: unit.trim(), stock });
  });
  addActivity("استيراد أصناف");
  await persist();
  render();
  toast("تم استيراد الأصناف إلى المستودع الرئيسي");
}

function parseImportRows(text = "") {
  const rows = text.includes("\t") ? text.split(/\r?\n/).map((line) => line.split("\t")) : parseCsv(text);
  return rows
    .map((row) => row.map((cell) => String(cell || "").trim()))
    .filter((row) => row.length >= 3 && row[0] && row[1] && row[2] && !row[0].includes("الباركود"));
}

function parseCsv(text = "") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function toGoogleCsvUrl(url) {
  const match = url.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) return url;
  const gid = url.match(/[?&]gid=([^&]+)/)?.[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
}

async function openScanner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("الكاميرا غير مدعومة في هذا المتصفح");
    return;
  }
  scannerOpen = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const video = document.getElementById("scannerVideo");
  if (!video) return;
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
  } catch {
    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch {
      toast("تعذر فتح الكاميرا. تأكد من السماح للمتصفح باستخدام الكاميرا");
      stopScanner();
      return;
    }
  }
  if (!scannerOpen) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
    return;
  }
  video.srcObject = scannerStream;
  await video.play().catch(() => {});
  if (!("BarcodeDetector" in window)) {
    toast("المتصفح لا يدعم قراءة الباركود تلقائيًا، استخدم الإدخال اليدوي");
    return;
  }
  const detector = new BarcodeDetector({ formats: ["qr_code", "ean_13", "code_128", "code_39", "upc_a"] });
  const scan = async () => {
    if (!scannerStream) return;
    const codes = await detector.detect(video).catch(() => []);
    if (codes.length) {
      client.scannedBarcode = codes[0].rawValue;
      saveClient();
      navigator.vibrate?.(80);
      toast(`تم قراءة الباركود ${codes[0].rawValue}`);
      stopScanner();
      setTimeout(() => document.getElementById("qtyInput")?.focus(), 100);
      return;
    }
    requestAnimationFrame(scan);
  };
  scan();
}

function stopScanner() {
  scannerStream?.getTracks().forEach((track) => track.stop());
  scannerStream = null;
  scannerOpen = false;
  render();
}

async function readAll() {
  const user = currentUser();
  state.notifications.forEach((n) => {
    if (!notificationsForUser(user).includes(n)) return;
    n.readBy = { ...(n.readBy || {}), [user.id]: true };
    if (n.userId === user.id) n.read = true;
  });
  await persist();
  render();
}

function csvDownload(filename, rows) {
  const csv = "\ufeff" + rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportTransfers() {
  if (!isAdmin()) return;
  const rows = [["رقم الحركة", "من", "إلى", "الحالة", "التاريخ", "الصنف", "الوحدة", "المرسل", "المستلم"]];
  state.transfers.forEach((t) => t.lines.forEach((l) => rows.push([t.id, warehouseName(t.fromWarehouseId), warehouseName(t.toWarehouseId), statusLabel(t.status), t.createdAt, l.name, l.unit, l.sentQty, l.receivedQty])));
  csvDownload("transfers.csv", rows);
}

function exportStock() {
  const rows = [["الباركود", "الصنف", "الوحدة", ...state.warehouses.map((w) => w.name)]];
  state.items.forEach((item) => rows.push([item.barcodes.join(";"), item.name, item.unit, ...state.warehouses.map((w) => item.stock[w.id] || 0)]));
  csvDownload("stock.csv", rows);
}

async function shareStockWhatsApp() {
  const warehouses = client.stockWarehouse ? state.warehouses.filter((w) => w.id === client.stockWarehouse) : state.warehouses;
  const rows = stockRows();
  const html = `
    <html><head><meta charset="utf-8" /></head><body dir="rtl">
      <table border="1">
        <thead><tr><th>الباركود</th><th>الصنف</th><th>الوحدة</th>${warehouses.map((w) => `<th>${w.name}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((item) => `<tr><td>${item.barcodes.join(";")}</td><td>${item.name}</td><td>${item.unit}</td>${warehouses.map((w) => `<td>${item.stock[w.id] || 0}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </body></html>
  `;
  const file = new File([html], `stock-${todayKey()}.xls`, { type: "application/vnd.ms-excel" });
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    await navigator.share({ title: "أرصدة المخزون", text: "ملف Excel لأرصدة المخزون", files: [file] });
    return;
  }
  downloadFile(file.name, html, "application/vnd.ms-excel;charset=utf-8");
  toast("تم تنزيل ملف Excel. افتح واتساب وأرسله من الملفات");
}

function backup() {
  downloadFile("backup.json", JSON.stringify(state, null, 2), "application/json;charset=utf-8");
}

async function restore() {
  const file = document.getElementById("restoreFile")?.files?.[0];
  if (!file) return toast("اختر ملف النسخة الاحتياطية");
  const text = await file.text();
  state = normalizeState(JSON.parse(text.replace(/^\ufeff/, "")));
  await persist();
  render();
}

async function saveAlerts(event) {
  event.preventDefault();
  state.warehouses.forEach((w) => w.minAlert = Number(document.getElementById(`alert-${w.id}`).value || 0));
  await persist();
  toast("تم حفظ حدود النقص");
}

async function createUser(event) {
  event.preventDefault();
  const username = document.getElementById("newUsername").value.trim().toUpperCase();
  if (state.users.some((u) => u.username === username)) {
    toast("اسم المستخدم موجود بالفعل");
    return;
  }
  const user = {
    id: `user-${Date.now()}`,
    name: document.getElementById("newName").value,
    username,
    password: document.getElementById("newPassword").value,
    role: document.getElementById("newRole").value,
    warehouseId: document.getElementById("newWarehouse").value || null,
    active: true
  };
  state.users.push(user);
  if (user.role === "keeper" && user.warehouseId) {
    const warehouse = state.warehouses.find((w) => w.id === user.warehouseId);
    if (warehouse) warehouse.keeperId = user.id;
  }
  addActivity(`إضافة مستخدم ${user.name}`);
  await persist();
  render();
}

async function changeUsername(id) {
  const user = state.users.find((u) => u.id === id);
  const username = prompt(`اسم مستخدم جديد لـ ${user.name}`, user.username)?.trim().toUpperCase();
  if (!username || username === user.username) return;
  if (state.users.some((u) => u.id !== id && u.username === username)) {
    toast("اسم المستخدم موجود بالفعل");
    return;
  }
  user.username = username;
  addActivity(`تعديل اسم مستخدم ${user.name}`);
  await persist();
  render();
}

async function changePassword(id) {
  const user = state.users.find((u) => u.id === id);
  const password = prompt(`كلمة مرور جديدة لـ ${user.name}`);
  if (!password) return;
  user.password = password;
  addActivity(`تعديل كلمة مرور ${user.name}`);
  await persist();
  render();
}

async function init() {
  app.innerHTML = `<div class="splash"><div class="loader"></div></div>`;
  registerServiceWorker();
  if (client.token) await loadState();
  render();
  startAutoRefresh();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (!client.token || scannerOpen || transferDraft.length) return;
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
    await loadState();
    render();
  }, 12000);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

init();
