const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const dbPath = path.join(root, "db.json");
const envPath = path.join(root, ".env");

loadEnvFile();

const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || "0.0.0.0";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const emptyIcon = Buffer.from(
  "AAABAAEAEBAAAAAAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "base64"
);

const sessions = new Map();

function loadEnvFile() {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) return;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  });
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return {
    url: url.replace(/\/$/, ""),
    key
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 60_000_000) {
        request.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function send(response, statusCode, body, contentType = "application/json; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function googleSheetExcelUrl(inputUrl) {
  const rawUrl = String(inputUrl || "").trim();
  const match = rawUrl.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) return rawUrl;
  const gid = rawUrl.match(/[?&]gid=([^&]+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=xlsx${gid ? `&gid=${gid}` : ""}`;
}

async function fetchGoogleSheetExcel(inputUrl) {
  const targetUrl = googleSheetExcelUrl(inputUrl);
  const parsedTarget = new URL(targetUrl);
  const isGoogleSheet = parsedTarget.hostname === "docs.google.com" && parsedTarget.pathname.includes("/spreadsheets/");
  if (!isGoogleSheet) {
    throw new Error("Only public Google Sheets links are supported");
  }

  const sheetResponse = await fetch(targetUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 Temporary Warehouses Importer"
    }
  });

  if (!sheetResponse.ok) {
    throw new Error(`Google Sheets export failed: ${sheetResponse.status}`);
  }

  return Buffer.from(await sheetResponse.arrayBuffer());
}

function makeToken(userId = "") {
  return `u:${encodeURIComponent(userId)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
}

function getBearerToken(request) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function requireSession(request, response) {
  const token = getBearerToken(request);
  const session = token ? sessions.get(token) : null;
  if (session) {
    session.lastSeen = Date.now();
    return session;
  }

  const tokenUserMatch = token?.match(/^u:([^:]+):/);
  const fallbackUserId = tokenUserMatch ? decodeURIComponent(tokenUserMatch[1]) : String(request.headers["x-user-id"] || "");
  if (fallbackUserId) {
    return { userId: fallbackUserId, createdAt: Date.now(), lastSeen: Date.now(), recovered: true };
  }

  if (!session) {
    send(response, 401, JSON.stringify({ ok: false, error: "Unauthorized" }));
    return null;
  }
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
}

function applyTransferToState(data, transfer) {
  if (transfer.applied) return;
  (transfer.lines || []).forEach((line) => {
    const item = data.items?.find((entry) => entry.id === line.itemId);
    if (!item) return;
    const qty = Number(line.receivedQty ?? line.sentQty);
    item.stock = item.stock || {};
    item.stock[transfer.fromWarehouseId] = Number(item.stock[transfer.fromWarehouseId] || 0) - qty;
    item.stock[transfer.toWarehouseId] = Number(item.stock[transfer.toWarehouseId] || 0) + qty;
  });
  transfer.applied = true;
}

function mergeTransfer(data, transfer) {
  data.transfers = Array.isArray(data.transfers) ? data.transfers : [];
  const index = data.transfers.findIndex((entry) => entry.id === transfer.id);
  if (index === -1) {
    data.transfers.unshift(transfer);
  } else {
    data.transfers[index] = { ...data.transfers[index], ...transfer };
  }
}

function mergeNotification(data, notification) {
  if (!notification) return;
  data.notifications = Array.isArray(data.notifications) ? data.notifications : [];
  if (!data.notifications.some((entry) => entry.id === notification.id)) {
    data.notifications.unshift(notification);
  }
}

function mergeActivity(data, activity) {
  if (!activity) return;
  data.activity = Array.isArray(data.activity) ? data.activity : [];
  if (!data.activity.some((entry) => entry.at === activity.at && entry.action === activity.action)) {
    data.activity.unshift(activity);
  }
}

function readDatabase() {
  if (!fs.existsSync(dbPath)) return null;
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDatabase(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf8");
}

function mainStateOnly(data) {
  return {
    ...data,
    transfers: []
  };
}

function mergeTransferLists(primary, legacy) {
  const out = [];
  const seen = new Set();
  [...(primary || []), ...(legacy || [])].forEach((transfer) => {
    if (!transfer || !transfer.id || seen.has(transfer.id)) return;
    seen.add(transfer.id);
    out.push(transfer);
  });
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function readCloudTransferRows() {
  const config = supabaseConfig();
  if (!config) return [];

  const response = await fetch(`${config.url}/rest/v1/app_state?select=id,data&id=like.transfer:*&order=updated_at.desc`, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase transfer read failed: ${response.status}`);
  }

  const rows = await response.json();
  return rows.map((row) => row.data).filter(Boolean);
}

async function readCloudTransfer(id) {
  const config = supabaseConfig();
  if (!config || !id) return null;

  const response = await fetch(`${config.url}/rest/v1/app_state?id=eq.${encodeURIComponent(`transfer:${id}`)}&select=data`, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase transfer read failed: ${response.status}`);
  }

  const rows = await response.json();
  return rows[0]?.data || null;
}

async function writeCloudRows(rows) {
  const config = supabaseConfig();
  if (!config || !rows.length) return false;

  const response = await fetch(`${config.url}/rest/v1/app_state`, {
    method: "POST",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify(rows)
  });

  if (!response.ok) {
    throw new Error(`Supabase write failed: ${response.status}`);
  }

  return true;
}

async function writeCloudTransfer(transfer) {
  if (!transfer?.id) throw new Error("Invalid transfer id");
  return writeCloudRows([{
    id: `transfer:${transfer.id}`,
    data: transfer,
    updated_at: new Date().toISOString()
  }]);
}

async function writeCloudTransfers(transfers) {
  const rows = (Array.isArray(transfers) ? transfers : [])
    .filter((transfer) => transfer?.id)
    .map((transfer) => ({
      id: `transfer:${transfer.id}`,
      data: transfer,
      updated_at: new Date().toISOString()
    }));

  for (let index = 0; index < rows.length; index += 50) {
    await writeCloudRows(rows.slice(index, index + 50));
  }
}

async function readCloudDatabase() {
  const config = supabaseConfig();
  if (!config) return null;

  const response = await fetch(`${config.url}/rest/v1/app_state?id=eq.main&select=data`, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase read failed: ${response.status}`);
  }

  const rows = await response.json();
  const mainData = rows[0]?.data || null;
  if (!mainData) return null;

  let transferRows = [];
  try {
    transferRows = await readCloudTransferRows();
  } catch (error) {
    console.warn(error.message);
  }
  mainData.transfers = mergeTransferLists(transferRows, mainData.transfers);
  return mainData;
}

async function writeCloudDatabase(data) {
  const config = supabaseConfig();
  if (!config) return false;

  await writeCloudTransfers(data.transfers);
  await writeCloudRows([{
    id: "main",
    data: mainStateOnly(data),
    updated_at: new Date().toISOString()
  }]);
  return true;
}

async function readAppState() {
  if (supabaseConfig()) {
    const cloudData = await readCloudDatabase();
    if (cloudData) return cloudData;
    const localData = readDatabase();
    if (localData) await writeCloudDatabase(localData);
    return localData;
  }

  return readDatabase();
}

async function writeAppState(data) {
  if (supabaseConfig()) {
    await writeCloudDatabase(data);
  }
  writeDatabase(data);
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(root, requestedPath));

  if (!filePath.startsWith(root)) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  fs.readFile(filePath, (error, file) => {
    if (error) {
      send(response, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }

    const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    send(response, 200, file, contentType);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/api/health" && request.method === "GET") {
    send(response, 200, JSON.stringify({
      ok: true,
      app: "مخازن التخزين المؤقت",
      storage: supabaseConfig() ? "supabase" : "local-json"
    }));
    return;
  }

  if (request.url === "/favicon.ico" && request.method === "GET") {
    send(response, 200, emptyIcon, "image/x-icon");
    return;
  }

  if (request.url === "/api/login" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const username = String(body.username || "").trim().toUpperCase();
      const password = String(body.password || "");
      const data = await readAppState();
      const user = data?.users?.find((entry) => {
        return String(entry.username || "").toUpperCase() === username && entry.password === password && entry.active;
      });

      if (!user) {
        send(response, 401, JSON.stringify({ ok: false, error: "Invalid login" }));
        return;
      }

      const token = makeToken(user.id);
      sessions.set(token, { userId: user.id, createdAt: Date.now(), lastSeen: Date.now() });
      send(response, 200, JSON.stringify({ ok: true, token, user: publicUser(user), state: data || {} }));
    } catch (error) {
      send(response, 500, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (request.url === "/api/logout" && request.method === "POST") {
    const token = getBearerToken(request);
    if (token) sessions.delete(token);
    send(response, 200, JSON.stringify({ ok: true }));
    return;
  }

  if (request.url.startsWith("/api/google-sheet-excel") && request.method === "GET") {
    if (!requireSession(request, response)) return;
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const sourceUrl = url.searchParams.get("url");
      if (!sourceUrl) {
        send(response, 400, JSON.stringify({ ok: false, error: "Missing Google Sheets URL" }));
        return;
      }

      const file = await fetchGoogleSheetExcel(sourceUrl);
      send(response, 200, file, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (error) {
      send(response, 502, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (request.url === "/api/state" && request.method === "GET") {
    if (!requireSession(request, response)) return;
    try {
      const data = await readAppState();
      send(response, 200, JSON.stringify(data || {}));
    } catch (error) {
      send(response, 500, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (request.url === "/api/state" && request.method === "POST") {
    if (!requireSession(request, response)) return;
    try {
      const data = await readJsonBody(request);
      await writeAppState(data);
      send(response, 200, JSON.stringify({ ok: true }));
    } catch (error) {
      send(response, 400, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (request.url === "/api/transfer" && request.method === "POST") {
    if (!requireSession(request, response)) return;
    try {
      const body = await readJsonBody(request);
      const transfer = body.transfer;
      if (!transfer?.id || !Array.isArray(transfer.lines)) {
        send(response, 400, JSON.stringify({ ok: false, error: "Invalid transfer" }));
        return;
      }
      if (supabaseConfig()) {
        await writeCloudTransfer(transfer);
        const localData = readDatabase() || {};
        mergeTransfer(localData, transfer);
        mergeNotification(localData, (localData.notifications || []).find((entry) => entry.transferId === transfer.id) || {
          id: `n-${Date.now()}`,
          userId: transfer.receiverId,
          warehouseId: transfer.toWarehouseId,
          transferId: transfer.id,
          read: false,
          readBy: {},
          text: `تحويل جديد من ${transfer.fromWarehouseId} إلى ${transfer.toWarehouseId}`
        });
        mergeActivity(localData, transfer.history?.[transfer.history.length - 1]);
        writeDatabase(localData);
        send(response, 200, JSON.stringify({ ok: true, transfer, mode: "fast-transfer-row" }));
        return;
      }
      const data = await readAppState();
      mergeTransfer(data, transfer);
      mergeNotification(data, (data.notifications || []).find((entry) => entry.transferId === transfer.id) || {
        id: `n-${Date.now()}`,
        userId: transfer.receiverId,
        warehouseId: transfer.toWarehouseId,
        transferId: transfer.id,
        read: false,
        readBy: {},
        text: `تحويل جديد من ${transfer.fromWarehouseId} إلى ${transfer.toWarehouseId}`
      });
      mergeActivity(data, transfer.history?.[transfer.history.length - 1]);
      await writeAppState(data);
      send(response, 200, JSON.stringify({ ok: true, transfer }));
    } catch (error) {
      send(response, 400, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (request.url === "/api/receive" && request.method === "POST") {
    const session = requireSession(request, response);
    if (!session) return;
    try {
      const body = await readJsonBody(request);
      if (supabaseConfig()) {
        const transfer = await readCloudTransfer(body.transferId);
        if (!transfer || transfer.status !== "pending") {
          send(response, 404, JSON.stringify({ ok: false, error: "Transfer not found" }));
          return;
        }
        transfer.lines = Array.isArray(body.lines) ? body.lines : transfer.lines;
        transfer.status = "approved";
        transfer.locked = true;
        transfer.approvedAt = body.approvedAt || new Date().toISOString();
        transfer.history = Array.isArray(transfer.history) ? transfer.history : [];
        transfer.history.push({ at: transfer.approvedAt, by: session.userId, action: `اعتماد استلام التحويل ${transfer.id}` });
        await writeCloudTransfer(transfer);
        const localData = readDatabase() || {};
        mergeTransfer(localData, transfer);
        mergeNotification(localData, { id: `n-${Date.now()}`, userId: transfer.createdBy, warehouseId: transfer.fromWarehouseId, transferId: transfer.id, read: false, readBy: {}, text: `تم اعتماد استلام التحويل ${transfer.id}` });
        writeDatabase(localData);
        send(response, 200, JSON.stringify({ ok: true, transfer, mode: "fast-transfer-row" }));
        return;
      }
      const data = await readAppState();
      const transfer = data.transfers?.find((entry) => entry.id === body.transferId);
      if (!transfer || transfer.status !== "pending") {
        send(response, 404, JSON.stringify({ ok: false, error: "Transfer not found" }));
        return;
      }
      transfer.lines = Array.isArray(body.lines) ? body.lines : transfer.lines;
      transfer.status = "approved";
      transfer.locked = true;
      transfer.approvedAt = body.approvedAt || new Date().toISOString();
      transfer.history = Array.isArray(transfer.history) ? transfer.history : [];
      transfer.history.push({ at: transfer.approvedAt, by: session.userId, action: `اعتماد استلام التحويل ${transfer.id}` });
      applyTransferToState(data, transfer);
      mergeNotification(data, { id: `n-${Date.now()}`, userId: transfer.createdBy, warehouseId: transfer.fromWarehouseId, transferId: transfer.id, read: false, readBy: {}, text: `تم اعتماد استلام التحويل ${transfer.id}` });
      await writeAppState(data);
      send(response, 200, JSON.stringify({ ok: true, transfer }));
    } catch (error) {
      send(response, 400, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`Warehouse app running on ${host}:${port}`);
  console.log(`Database file: ${dbPath}`);
});
