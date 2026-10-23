const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const LINGXI_API_KEY = process.env.LINGXI_API_KEY || "";
const LINGXI_BASE_URL = (process.env.LINGXI_BASE_URL || "https://api.aicso.top").replace(/\/$/, "");
const ROOT = __dirname;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/product.html", ["product.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/product.css", ["product.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' https://images.unsplash.com data:",
    "style-src 'self'",
    "script-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("payload too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function serveStatic(request, response, pathname) {
  const entry = staticFiles.get(pathname);
  if (!entry) return false;

  const [filename, contentType] = entry;
  const content = await fs.readFile(path.join(ROOT, filename));
  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
  response.end(request.method === "HEAD" ? undefined : content);
  return true;
}

async function proxyLingxiSpeech(request, response) {
  if (!LINGXI_API_KEY) {
    sendJson(response, 503, { error: "LINGXI_API_KEY is not configured" });
    return;
  }

  const body = await readBody(request, 32 * 1024);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Request body must be valid JSON" });
    return;
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text || text.length > 600) {
    sendJson(response, 400, { error: "text must contain 1 to 600 characters" });
    return;
  }

  const upstream = await fetch(`${LINGXI_BASE_URL}/v1/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINGXI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      input: text,
      voice: payload.voice || "alloy",
    }),
  });

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 500);
    sendJson(response, upstream.status, { error: "Lingxi speech request failed", detail });
    return;
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
    "Content-Length": audio.length,
    "Cache-Control": "no-store",
  });
  response.end(audio);
}

async function proxyLingxiTranscription(request, response) {
  if (!LINGXI_API_KEY) {
    sendJson(response, 503, { error: "LINGXI_API_KEY is not configured" });
    return;
  }

  const contentType = request.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data;")) {
    sendJson(response, 415, { error: "multipart/form-data is required" });
    return;
  }

  const body = await readBody(request, MAX_AUDIO_BYTES);
  const upstream = await fetch(`${LINGXI_BASE_URL}/v1/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINGXI_API_KEY}`,
      "Content-Type": contentType,
    },
    body,
  });

  const result = await upstream.text();
  response.writeHead(upstream.status, {
    ...securityHeaders,
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(result);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if ((request.method === "GET" || request.method === "HEAD") && (await serveStatic(request, response, url.pathname))) {
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/lingxi/status") {
      sendJson(response, 200, {
        configured: Boolean(LINGXI_API_KEY),
        provider: "Lingxi API",
        capabilities: ["gpt-4o-transcribe", "gpt-4o-mini-tts", "gpt-4o-realtime-preview"],
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/lingxi/speech") {
      await proxyLingxiSpeech(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/lingxi/transcriptions") {
      await proxyLingxiTranscription(request, response);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    sendJson(response, statusCode, {
      error: statusCode === 500 ? "Internal server error" : error.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`雾隐镇已启动：http://${HOST}:${PORT}`);
  console.log(`灵汐语音：${LINGXI_API_KEY ? "已配置" : "演示模式（未设置 LINGXI_API_KEY）"}`);
});
