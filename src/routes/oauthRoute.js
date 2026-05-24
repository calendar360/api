import express from "express";

const router = express.Router();

const CLIENT_ID =
  process.env.KINGSCHAT_CLIENT_ID || "039a46cc-9aff-4f38-bc3d-73d0a99afef3";
const SCOPES = process.env.KINGSCHAT_SCOPES || '["send_chat_message"]';

function publicBaseUrl(req) {
  return `http://${req.get("host")}`;
}

function buildKingsChatAuthUrl(redirectUri) {
  const scopes = encodeURIComponent(SCOPES);
  const redirect = encodeURIComponent(redirectUri);
  return (
    `https://accounts.kingsch.at/?client_id=${CLIENT_ID}` +
    `&scopes=${scopes}` +
    `&redirect_uri=${redirect}` +
    `&post_redirect=true` +
    `&post_message=1`
  );
}

/** Normalize KingsChat POST/GET body into one JSON object for the app. */
function extractLoginPayload(req) {
  const body = req.body;

  if (body == null || body === "") {
    return null;
  }

  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return { raw: body };
    }
  }

  if (typeof body.login_data === "string") {
    try {
      return JSON.parse(body.login_data);
    } catch {
      return { raw: body.login_data };
    }
  }

  if (body.login_data && typeof body.login_data === "object") {
    return body.login_data;
  }

  if (body.profile || body.accessToken || body.access_token) {
    return body;
  }

  const keys = Object.keys(body);
  if (keys.length === 1) {
    const val = body[keys[0]];
    if (
      typeof val === "string" &&
      (val.startsWith("{") || val.startsWith("["))
    ) {
      try {
        return JSON.parse(val);
      } catch {
        /* continue */
      }
    }
  }

  return body;
}

function renderCallbackPage(res, payload) {
  const loginJson =
    payload == null
      ? "{}"
      : typeof payload === "string"
        ? payload
        : JSON.stringify(payload);

  const safe = loginJson
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  const bridgeScript = `
    function forward(payload) {
      if (!payload || typeof KingsChatAuth === 'undefined') return false;
      var msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
      KingsChatAuth.postMessage(msg);
      return true;
    }
    window.addEventListener('message', function (e) {
      var allowed = ['https://accounts.kingsch.at', 'https://accounts.staging.kingsch.at'];
      if (allowed.indexOf(e.origin) === -1) return;
      if (!e.data) return;
      if (typeof e.data === 'string') {
        try { forward(JSON.parse(e.data)); } catch (err) { forward(e.data); }
      } else {
        forward(e.data);
      }
    }, false);
    function harvest() {
      try {
        var el = document.getElementById('login_data');
        if (el && el.textContent && el.textContent.trim().length > 2) {
          return forward(el.textContent.trim());
        }
      } catch (e) {}
      try {
        if (window.__kcPayload) return forward(window.__kcPayload);
      } catch (e) {}
      return false;
    }
    try {
      window.__kcPayload = JSON.parse(document.getElementById('login_data').textContent);
    } catch (e) {}
    harvest();
    var n = 0;
    var t = setInterval(function () {
      n++;
      if (harvest() || n > 80) clearInterval(t);
    }, 200);
  `;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signing in…</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; margin: 0; background: #fafafa; color: #333; }
    .box { text-align: center; }
    .spinner { width: 40px; height: 40px; border: 3px solid #e0e0e0;
      border-top-color: #1976d2; border-radius: 50%; animation: spin 0.8s linear infinite;
      margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #login_data { display: none; }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <p>Completing sign in…</p>
  </div>
  <script type="application/json" id="login_data">${safe}</script>
  <script>${bridgeScript}</script>
</body>
</html>`);
}

function handleCallback(req, res) {
  const payload = extractLoginPayload(req);
  console.log(
    `[oauth] callback ${req.method} host=${req.get("host")} keys=${Object.keys(req.body || {}).join(",") || "(empty)"}`,
  );
  if (payload?.profile || payload?.accessToken) {
    console.log("[oauth] received login payload");
  }
  renderCallbackPage(res, payload);
}

router.get("/start", (req, res) => {
  const callback = `${publicBaseUrl(req)}/oauth/callback`;
  const authUrl = buildKingsChatAuthUrl(callback);
  console.log("[oauth] start →", callback);
  res.redirect(302, authUrl);
});

/** KingsChat post_redirect sends POST with profile JSON */
router.post("/callback", handleCallback);

router.get("/callback", handleCallback);

export default router;
