/* declan ↔ Google Drive (test version).
   Proves four things before we build the real feature:
     1. declan can connect to the DMA Google account and stay connected (a saved refresh token)
     2. an upload lands in a "declan" folder in Drive
     3. the file comes back out of Drive fast enough to show in the calendar
     4. declan can make a Slides deck with a post's image and caption
   Deploy with JWT verification OFF: Google's redirect can't carry a Supabase login. Every other
   route checks the caller's declan login itself, and only the admin can connect or run the test.
   Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. Table: google_connection (service role only). */
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const url = Deno.env.get("SUPABASE_URL")!;
const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  (secretKeys ? JSON.parse(secretKeys).default : "");
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
const SITE = "https://declanbyp.vercel.app";
const CALLBACK = url + "/functions/v1/google-drive/callback";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive"].join(" ");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

/* ---------- who's asking ---------- */
async function callerFrom(request: Request) {
  const token = (request.headers.get("authorization") || "").replace("Bearer ", "");
  const { data } = await db.auth.getUser(token);
  const email = data.user?.email?.toLowerCase() || "";
  if (!email) return { email: "", role: "" };
  const { data: member } = await db.from("members").select("role").eq("email", email).maybeSingle();
  return { email, role: member ? member.role : "" };
}

/* ---------- a signed "state" so the Google redirect can't be forged ---------- */
async function hmac(text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(serviceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function makeState(email: string) {
  const body = btoa(JSON.stringify({ email, at: Date.now() }));
  return body + "." + (await hmac(body));
}
async function readState(state: string) {
  const [body, mac] = String(state || "").split(".");
  if (!body || mac !== (await hmac(body))) return null;
  const data = JSON.parse(atob(body));
  return Date.now() - data.at < 15 * 60000 ? data : null;
}

/* ---------- Google tokens ---------- */
async function connection() {
  const { data } = await db.from("google_connection").select("*").eq("id", 1).maybeSingle();
  return data;
}
async function accessToken() {
  const saved = await connection();
  if (!saved || !saved.refresh_token) throw new Error("Not connected to Google yet");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: saved.refresh_token, grant_type: "refresh_token" }),
  });
  const result = await response.json();
  if (!result.access_token) throw new Error("Google refused the saved connection: " + (result.error || "unknown"));
  return { token: result.access_token as string, saved };
}
async function google(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(path.startsWith("http") ? path : "https://www.googleapis.com" + path, {
    ...init, headers: { Authorization: "Bearer " + token, ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error("Google " + response.status + " on " + path.split("?")[0] + ": " + (await response.text()).slice(0, 300));
  return response;
}

/* ---------- Drive folders ---------- */
/* Folders are remembered once made (declan/2026/Saltair/December -> its ID), so two uploads at the
   same moment can't each create their own "December". */
const folderMemory = new Map<string, Promise<string>>();
function folder(token: string, name: string, parent = "") {
  const key = (parent || "root") + "/" + name;
  if (!folderMemory.has(key)) {
    folderMemory.set(key, (async () => {
      const { data } = await db.from("google_folders").select("folder_id").eq("key", key).maybeSingle();
      if (data && data.folder_id) return data.folder_id as string;
      const id = await findOrMakeFolder(token, name, parent);
      await db.from("google_folders").upsert({ key, folder_id: id });
      return id;
    })().catch((problem) => { folderMemory.delete(key); throw problem; }));
  }
  return folderMemory.get(key)!;
}
async function findOrMakeFolder(token: string, name: string, parent = "") {
  const query = "mimeType='application/vnd.google-apps.folder' and trashed=false and name='" + name.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'" + (parent ? " and '" + parent + "' in parents" : " and 'root' in parents");
  const found = await (await google(token, "/drive/v3/files?q=" + encodeURIComponent(query) + "&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true")).json();
  if (found.files && found.files.length) return found.files[0].id as string;
  const made = await (await google(token, "/drive/v3/files?supportsAllDrives=true&fields=id", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parent ? { parents: [parent] } : {}) }),
  })).json();
  return made.id as string;
}

/* ---------- the real thing: where a post's files go ---------- */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((month) => month.slice(0, 3));
/* declan / 2026 / Saltair / December */
async function monthFolder(token: string, saved: any, clientId: string, date: string) {
  const root = saved.folder_id || await folder(token, "declan");
  if (!saved.folder_id) await db.from("google_connection").update({ folder_id: root }).eq("id", 1);
  const { data: client } = await db.from("clients").select("name").eq("id", clientId).maybeSingle();
  const year = /^\d{4}-\d{2}/.test(date) ? date.slice(0, 4) : String(new Date().getFullYear());
  const month = /^\d{4}-\d{2}/.test(date) ? MONTHS[Number(date.slice(5, 7)) - 1] : "No date";
  const yearId = await folder(token, year, root);
  const clientFolder = await folder(token, (client && client.name) || "No client", yearId);
  return await folder(token, month, clientFolder);
}
/* "Dec 03 – Holiday gift guide – cover.jpg" */
function fileName(date: string, title: string, part: string, original: string) {
  const day = /^\d{4}-\d{2}-\d{2}/.test(date) ? SHORT[Number(date.slice(5, 7)) - 1] + " " + date.slice(8, 10) : "No date";
  const ext = (String(original).match(/\.[a-zA-Z0-9]{1,5}$/) || [""])[0].toLowerCase();
  const clean = String(title || "Untitled").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Untitled";
  return day + " – " + clean + " – " + part + ext;
}
/* A Drive file declan made, so nobody can use declan to read the rest of the Drive. */
async function ownFile(token: string, id: string) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return null;
  const meta = await (await google(token, "/drive/v3/files/" + id + "?fields=id,name,mimeType,appProperties,trashed&supportsAllDrives=true")).json();
  return meta.appProperties && meta.appProperties.declan === "1" ? meta : null;
}

/* ---------- the four checks ---------- */
async function runTest() {
  const out: Record<string, unknown> = {};
  const timed = async <T>(label: string, work: () => Promise<T>) => {
    const start = performance.now();
    const value = await work();
    out[label + "Ms"] = Math.round(performance.now() - start);
    return value;
  };
  // 1. Stay connected: trade the saved refresh token for a fresh access token.
  const { token, saved } = await timed("connect", accessToken);
  out.connectedAs = saved.email;
  // 2. Upload a real post image into declan / Test.
  const root = saved.folder_id || await folder(token, "declan");
  if (!saved.folder_id) await db.from("google_connection").update({ folder_id: root }).eq("id", 1);
  const testFolder = await folder(token, "Test", root);
  const { data: posts } = await db.from("posts").select("id, title, copy_text, copy_options, cover_file, history").not("cover_file", "is", null).limit(40);
  const post = (posts || []).find((item: any) => item.cover_file && String(item.cover_file.type || "").startsWith("image/") && !(item.history || []).some((entry: any) => entry.type === "deleted"));
  if (!post) throw new Error("No post with a cover image to test with");
  const { data: blob, error } = await db.storage.from("assets").download(post.cover_file.id);
  if (error || !blob) throw new Error("Couldn't read the test image from storage");
  out.imageBytes = blob.size;
  const uploaded = await timed("upload", async () => {
    const boundary = "declan" + crypto.randomUUID();
    const meta = JSON.stringify({ name: post.cover_file.name || post.title + ".jpg", parents: [testFolder] });
    const body = new Blob([
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + boundary + "\r\nContent-Type: " + (blob.type || "image/jpeg") + "\r\n\r\n",
      blob, "\r\n--" + boundary + "--",
    ]);
    return await (await google(token, "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink,thumbnailLink", {
      method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body,
    })).json();
  });
  out.fileLink = uploaded.webViewLink;
  // 3. Read it back: the full file (what declan would show when a post is opened), and Drive's small preview.
  const back = await timed("download", async () => (await google(token, "/drive/v3/files/" + uploaded.id + "?alt=media&supportsAllDrives=true")).arrayBuffer());
  out.downloadBytes = back.byteLength;
  const thumb = await timed("thumbnailLookup", async () => (await google(token, "/drive/v3/files/" + uploaded.id + "?fields=thumbnailLink&supportsAllDrives=true")).json());
  out.hasThumbnail = Boolean(thumb.thumbnailLink);
  // 4. A Slides deck with the post's image and caption.
  const deck = await timed("deck", async () => {
    const made = await (await google(token, "/drive/v3/files?supportsAllDrives=true&fields=id,webViewLink", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "declan test deck", mimeType: "application/vnd.google-apps.presentation", parents: [testFolder] }),
    })).json();
    const slides = await (await google(token, "https://slides.googleapis.com/v1/presentations/" + made.id)).json();
    const page = slides.slides[0].objectId;
    // Slides fetches the image itself, so it gets a short-lived link to the copy in storage.
    const { data: signed } = await db.storage.from("assets").createSignedUrl(post.cover_file.id, 600);
    const caption = post.copy_text || (Array.isArray(post.copy_options) ? post.copy_options[0] : "") || "(no caption)";
    const pt = (n: number) => ({ magnitude: n, unit: "PT" });
    await google(token, "https://slides.googleapis.com/v1/presentations/" + made.id + ":batchUpdate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [
        ...slides.slides[0].pageElements.map((element: any) => ({ deleteObject: { objectId: element.objectId } })),
        { createImage: { url: signed!.signedUrl, elementProperties: { pageObjectId: page, size: { width: pt(260), height: pt(325) }, transform: { scaleX: 1, scaleY: 1, translateX: 30, translateY: 40, unit: "PT" } } } },
        { createShape: { objectId: "title_1", shapeType: "TEXT_BOX", elementProperties: { pageObjectId: page, size: { width: pt(380), height: pt(50) }, transform: { scaleX: 1, scaleY: 1, translateX: 320, translateY: 40, unit: "PT" } } } },
        { insertText: { objectId: "title_1", text: post.title || "Untitled post" } },
        { createShape: { objectId: "caption_1", shapeType: "TEXT_BOX", elementProperties: { pageObjectId: page, size: { width: pt(380), height: pt(260) }, transform: { scaleX: 1, scaleY: 1, translateX: 320, translateY: 100, unit: "PT" } } } },
        { insertText: { objectId: "caption_1", text: caption } },
      ] }),
    });
    return made;
  });
  out.deckLink = deck.webViewLink;
  out.post = post.title;
  return out;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(request.url).pathname.split("/google-drive")[1] || "/";

  // Google sends the person back here after they say yes.
  if (path.startsWith("/callback")) {
    const params = new URL(request.url).searchParams;
    const state = await readState(params.get("state") || "");
    const back = (result: string) => Response.redirect(SITE + "/#google-" + result, 302);
    if (!state || !params.get("code")) return back("failed");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: params.get("code")!, client_id: clientId, client_secret: clientSecret, redirect_uri: CALLBACK, grant_type: "authorization_code" }),
    });
    const tokens = await response.json();
    if (!tokens.refresh_token) { console.error("No refresh token", tokens.error || ""); return back("failed"); }
    const who = await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tokens.access_token } })).json();
    const { error } = await db.from("google_connection").upsert({ id: 1, email: who.email || state.email, refresh_token: tokens.refresh_token, updated_at: new Date().toISOString() });
    if (error) { console.error("Couldn't save the Google connection", error.message); return back("failed"); }
    return back("connected");
  }

  const caller = await callerFrom(request);
  if (!caller.email || !caller.role || caller.role === "client") return json({ error: "Not allowed" }, 401);
  if (!clientId || !clientSecret) return json({ error: "Google isn't set up yet (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)" }, 500);

  // Which clients keep their files in Drive (only these, while we test).
  if (path.startsWith("/status")) {
    const saved = await connection();
    return json({ connected: Boolean(saved && saved.refresh_token), email: saved ? saved.email : "", clients: (saved && saved.clients) || [] });
  }
  // Start an upload: declan makes the folders, then the browser sends the file straight to Drive.
  if (path.startsWith("/upload-session")) {
    try {
      const body = await request.json();
      const { token, saved } = await accessToken();
      if (!((saved.clients || []) as string[]).includes(body.client)) return json({ error: "Drive isn't on for this client" }, 400);
      const parent = await monthFolder(token, saved, body.client, body.date || "");
      const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": body.type || "application/octet-stream", "X-Upload-Content-Length": String(body.size || 0),
          Origin: SITE,
        },
        body: JSON.stringify({ name: fileName(body.date || "", body.title || "", body.part || "file", body.name || ""), parents: [parent], appProperties: { declan: "1" } }),
      });
      const uploadUrl = response.headers.get("location");
      if (!response.ok || !uploadUrl) return json({ error: "Drive didn't start the upload: " + (await response.text()).slice(0, 200) }, 502);
      return json({ uploadUrl });
    } catch (problem) { return json({ error: String((problem as Error).message || problem) }, 500); }
  }
  // The original file, for downloading.
  if (path.startsWith("/file")) {
    try {
      const id = new URL(request.url).searchParams.get("id") || "";
      const { token } = await accessToken();
      const meta = await ownFile(token, id);
      if (!meta) return json({ error: "Not a declan file" }, 404);
      const file = await google(token, "/drive/v3/files/" + id + "?alt=media&supportsAllDrives=true");
      return new Response(file.body, { headers: { ...cors, "Content-Type": meta.mimeType || "application/octet-stream", "Cache-Control": "private, max-age=3600" } });
    } catch (problem) { return json({ error: String((problem as Error).message || problem) }, 500); }
  }
  // Removed from a post: into Drive's trash, which empties itself after 30 days.
  if (path.startsWith("/trash")) {
    try {
      const { ids } = await request.json();
      const { token } = await accessToken();
      let trashed = 0;
      for (const id of (ids || []).slice(0, 50)) {
        if (!(await ownFile(token, id))) continue;
        await google(token, "/drive/v3/files/" + id + "?supportsAllDrives=true", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
        trashed++;
      }
      return json({ trashed });
    } catch (problem) { return json({ error: String((problem as Error).message || problem) }, 500); }
  }

  // Connecting and the test are for the admin only.
  if (caller.role !== "admin") return json({ error: "Only the declan admin can do this" }, 401);
  const admin = caller.email;

  if (path.startsWith("/connect")) {
    const link = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: clientId, redirect_uri: CALLBACK, response_type: "code", scope: SCOPES,
      access_type: "offline", prompt: "consent", login_hint: admin, state: await makeState(admin),
    });
    return json({ link });
  }
  if (path.startsWith("/test")) {
    try { return json(await runTest()); } catch (problem) { return json({ error: String((problem as Error).message || problem) }, 500); }
  }
  return json({ error: "Unknown route" }, 404);
});
