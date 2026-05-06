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

function makeToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getBearerToken(request) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function requireSession(request, response) {
  const token = getBearerToken(request);
  const session = token ? sessions.get(token) : null;
  if (!session) {
    send(response, 401, JSON.stringify({ ok: false, error: "Unauthorized" }));
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
}

function readDatabase() {
  if (!fs.existsSync(dbPath)) return null;
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDatabase(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf8");
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
  return rows[0]?.data || null;
}

async function writeCloudDatabase(data) {
  const config = supabaseConfig();
  if (!config) return false;

  const response = await fetch(`${config.url}/rest/v1/app_state`, {
    method: "POST",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      id: "main",
      data,
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(`Supabase write failed: ${response.status}`);
  }

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

      const token = makeToken();
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

  serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`Warehouse app running on ${host}:${port}`);
  console.log(`Database file: ${dbPath}`);
});
