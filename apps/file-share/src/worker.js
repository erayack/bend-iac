const APP_VERSION = "1";
const LIMIT = 1048576;
const ID = /^[0-9a-f]{32}$/;
const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const random = () => hex(crypto.getRandomValues(new Uint8Array(16)));

const hash = async (value) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));

const headers = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

const json = (value, status = 200, extra = {}) =>
  Response.json(value, { status, headers: { ...headers, ...extra } });

const fail = (message, status) => json({ error: message }, status);
const method = (allow) => json({ error: "Method not allowed" }, 405, { allow });

async function upload(request, env) {
  if (Number(request.headers.get("content-length")) > LIMIT)
    return fail("Files must be 1 MiB or smaller", 413);
  let name;

  try {
    name = decodeURIComponent(request.headers.get("x-file-name") || "Untitled");
  } catch {
    return fail("Invalid filename encoding", 400);
  }

  name = name.replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, "_").trim();

  if (!name || encoder.encode(name).length > 240)
    return fail("Use a filename of 1–240 UTF-8 bytes", 400);
  const mimeHeader = request.headers.get("content-type") || "application/octet-stream";

  const mime =
    /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeHeader) && mimeHeader.length <= 100
      ? mimeHeader.toLowerCase()
      : "application/octet-stream";

  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;

  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;
        size += value.byteLength;

        if (size > LIMIT) {
          await reader.cancel();

          return fail("Files must be 1 MiB or smaller", 413);
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const id = random();
  const deleteToken = random() + random();
  const created = new Date().toISOString();
  await env.FILES.put(id, bytes);

  try {
    await env.DB.prepare(
      "INSERT INTO files (id, name, size, mime, created, delete_hash) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, name, size, mime, created, await hash(deleteToken))
      .run();
  } catch (error) {
    await env.FILES.delete(id);
    throw error;
  }

  return json({ id, name, size, mime, created, deleteToken }, 201);
}

async function route(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    if (request.method !== "GET") return method("GET");

    return new Response(PAGE, {
      headers: {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "x-app-version": APP_VERSION,
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      },
    });
  }

  if (url.pathname === "/api/files") {
    if (request.method !== "POST") return method("POST");
    await initialize(env);

    return upload(request, env);
  }

  const match = /^\/api\/files\/([^/]+)(\/download)?$/.exec(url.pathname);

  if (!match || !ID.test(match[1])) return fail("File not found", 404);
  const [, id, download] = match;

  if (download ? request.method !== "GET" : !["GET", "DELETE"].includes(request.method))
    return method(download ? "GET" : "GET, DELETE");
  await initialize(env);

  const file = await env.DB.prepare("SELECT id, name, size, mime, created FROM files WHERE id = ?")
    .bind(id)
    .first();

  if (!file) return fail("File not found", 404);

  if (request.method === "DELETE") {
    const authorization = request.headers.get("authorization") || "";

    if (!/^Bearer [0-9a-f]{64}$/.test(authorization))
      return fail("Delete capability required", 403);

    const allowed = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND delete_hash = ?")
      .bind(id, await hash(authorization.slice(7)))
      .first();

    if (!allowed) return fail("Delete capability required", 403);
    // Keep metadata/capability until object deletion succeeds, so retries remain possible.
    await env.FILES.delete(id);
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();

    return new Response(null, { status: 204, headers });
  }

  if (!download) return json(file);
  const object = await env.FILES.get(id);

  if (!object) return fail("File not found", 404);

  const encoded = encodeURIComponent(file.name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

  return new Response(object.body, {
    headers: {
      ...headers,
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}

async function initialize(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, created TEXT NOT NULL, delete_hash TEXT NOT NULL)",
  ).run();
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch {
      return fail("Unable to complete the request. Try again.", 500);
    }
  },
};

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>File share</title>
<style>
:root{color-scheme:light;--paper:#f4f1e9;--ink:#292b26;--muted:#66685e;--accent:#a33e22}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-monospace,Menlo,Consolas,monospace}main{max-width:1080px;margin:auto;padding:40px 32px}header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px solid var(--ink);padding-bottom:22px}h1{font:normal 42px/1.1 Georgia,serif;margin:0;letter-spacing:-1.5px}header p{color:var(--muted);font-size:12px;margin:0}h2{font-size:13px;font-weight:normal;text-transform:uppercase;letter-spacing:1px;margin:42px 0 16px}.drop{position:relative;border-top:1px solid var(--muted);border-bottom:1px solid var(--muted);padding:42px 0;transition:background .15s,padding .15s}.drop.over{background:#e9e3d5;padding-left:20px}.drop strong{display:block;font:normal 28px Georgia,serif;margin-bottom:12px}.drop p{color:var(--muted);font-size:12px}button,.choose,a{font:inherit;color:var(--accent);cursor:pointer}button,.choose{background:none;border:1px solid var(--accent);padding:9px 14px;display:inline-block;transition:background .15s,color .15s}button:hover,.choose:hover{background:var(--accent);color:var(--paper)}button:disabled{opacity:.5;cursor:wait}a{padding:8px 0;text-underline-offset:4px}:focus-visible{outline:3px solid var(--accent);outline-offset:5px}input{max-width:100%;margin:12px 0}#status{min-height:26px;color:var(--accent);margin:20px 0}ul{padding:0;list-style:none;margin:0}li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;border-top:1px solid #bdbdb0;padding:20px 0;animation:arrive .2s ease-out}.name{overflow-wrap:anywhere;font-size:16px}.detail{font-size:12px;color:var(--muted);margin-top:5px}.actions{display:flex;align-items:center;gap:16px}.actions button{border:0;padding:8px 0;text-decoration:underline;text-underline-offset:4px}.actions button:hover{background:none;color:var(--ink)}.empty,footer{color:var(--muted);font-size:12px}footer{margin-top:60px;border-top:1px solid #bdbdb0;padding-top:16px}@keyframes arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@media(max-width:600px){main{padding:26px 20px}header{display:block}header p{margin-top:14px}li{grid-template-columns:1fr}.actions{justify-content:flex-start}h1{font-size:36px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style></head><body><main><header><h1>File share</h1><p>Worker / D1 / R2</p></header>
<section aria-labelledby="upload-title"><h2 id="upload-title">Upload</h2><div class="drop" id="drop"><strong>Drop a file here.</strong><label for="pick">Or choose a file</label><br><input type="file" id="pick"><p>Up to 1 MiB per file. Anyone with the link can download.</p></div></section>
<p id="status" role="status" aria-live="polite">Ready.</p><section aria-labelledby="files-title"><h2 id="files-title">Your files</h2><p class="empty" id="empty">Files you upload in this browser appear here.</p><ul id="files"></ul></section><footer>Delete access stays in this browser. Keep it to manage your files.</footer></main>
<script>
const pick = document.querySelector("#pick"),
  drop = document.querySelector("#drop"),
  status = document.querySelector("#status"),
  list = document.querySelector("#files"),
  empty = document.querySelector("#empty");
const key = "file-share-v1";
let files = [];
let busy = false;
try {
  const stored = JSON.parse(localStorage.getItem(key) || "[]");
  if (Array.isArray(stored))
    files = stored.filter(
      (f) =>
        f &&
        /^[0-9a-f]{32}$/.test(f.id) &&
        /^[0-9a-f]{64}$/.test(f.deleteToken) &&
        typeof f.name === "string" &&
        typeof f.size === "number",
    );
} catch {
  status.textContent = "Browser storage unavailable. Keep this page open to manage uploads.";
}
function save() {
  try {
    localStorage.setItem(key, JSON.stringify(files));
  } catch {
    status.textContent =
      "File saved. Browser storage unavailable; keep this page open to retain delete access.";
  }
}
function node(tag, text) {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
}
function render() {
  list.replaceChildren();
  empty.hidden = files.length > 0;
  for (const f of files) {
    const row = node("li", ""),
      info = node("div", ""),
      name = node("div", f.name),
      detail = node("div", f.size.toLocaleString() + " bytes");
    name.className = "name";
    detail.className = "detail";
    info.append(name, detail);
    const actions = node("div", "");
    actions.className = "actions";
    const copy = node("button", "Copy link");
    copy.type = "button";
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(location.origin + "/api/files/" + f.id + "/download");
        status.textContent = "Download link copied.";
      } catch {
        status.textContent = "Could not copy. Use the Download link to copy its address.";
      }
    };
    const download = node("a", "Download");
    download.href = "/api/files/" + f.id + "/download";
    const del = node("button", "Delete");
    del.type = "button";
    del.onclick = async () => {
      if (!confirm("Delete " + f.name + "?")) return;
      del.disabled = true;
      try {
        const r = await fetch("/api/files/" + f.id, {
          method: "DELETE",
          headers: { authorization: "Bearer " + f.deleteToken },
        });
        if (!r.ok && r.status !== 404) throw new Error((await r.json()).error);
        files = files.filter((item) => item.id !== f.id);
        status.textContent = "File deleted.";
        save();
        render();
      } catch (e) {
        status.textContent = e.message;
        del.disabled = false;
      }
    };
    actions.append(copy, download, del);
    row.append(info, actions);
    list.append(row);
  }
}
async function upload(file) {
  if (!file || busy) return;
  if (file.size > 1048576) {
    status.textContent = "Files must be 1 MiB or smaller.";
    return;
  }
  busy = true;
  pick.disabled = true;
  status.textContent = "Uploading " + file.name + "…";
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/files");
  xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
  xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
  xhr.timeout = 30000;
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable)
      status.textContent = "Uploading " + Math.round((e.loaded / e.total) * 100) + "%";
  };
  xhr.onload = () => {
    try {
      const value = JSON.parse(xhr.responseText);
      if (xhr.status !== 201) throw new Error(value.error || "Upload failed.");
      files.unshift(value);
      status.textContent = "Uploaded. Copy a link to share.";
      save();
      render();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  xhr.onerror = () => {
    status.textContent = "Upload failed. Check your connection and try again.";
  };
  xhr.ontimeout = () => {
    status.textContent = "Upload timed out. Try again.";
  };
  xhr.onloadend = () => {
    busy = false;
    pick.disabled = false;
    pick.value = "";
  };
  xhr.send(file);
}
pick.onchange = () => upload(pick.files[0]);
for (const event of ["dragenter", "dragover"])
  drop.addEventListener(event, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
for (const event of ["dragleave", "drop"])
  drop.addEventListener(event, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
drop.addEventListener("drop", (e) => upload(e.dataTransfer.files[0]));
render();
</script></body></html>`;
