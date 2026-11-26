const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
/* ---------- fake database ---------- */
const tables = { google_connection: [{ id: 1, email: 'sonsoles@dma.com', refresh_token: 'r', folder_id: null, clients: ['sal'] }], google_folders: [], posts: [], clients: [{ id: 'sal', name: 'Saltair' }, { id: 'bee', name: 'BeeCee' }], members: [{ email: 'sonsoles@dma.com', role: 'admin' }, { email: 'grace@dma.com', role: 'team' }] };
function q(table) {
  const filters = []; let op = 'select', payload;
  const hit = () => tables[table].filter((r) => filters.every(([k, v]) => r[k] === v));
  const b = { select() { return b; }, eq(k, v) { filters.push([k, v]); return b; },
    update(p) { op = 'update'; payload = p; return b; }, delete() { op = 'delete'; return b; },
    upsert(row) { const key = table === 'google_folders' ? 'key' : 'id'; const ex = tables[table].find((r) => r[key] === row[key]); if (ex) Object.assign(ex, row); else tables[table].push({ ...row }); return Promise.resolve({ error: null }); },
    maybeSingle() { return Promise.resolve({ data: hit()[0] ? JSON.parse(JSON.stringify(hit()[0])) : null }); },
    then(res, rej) { let out; if (op === 'update') { hit().forEach((r) => Object.assign(r, payload)); out = { error: null }; } else if (op === 'delete') { const h = hit(); tables[table] = tables[table].filter((r) => !h.includes(r)); out = { error: null }; } else out = { data: hit(), error: null }; return Promise.resolve(out).then(res, rej); } };
  return b;
}
let caller = 'sonsoles@dma.com';
globalThis.__supa = { createClient: () => ({ from: q, auth: { getUser: async () => ({ data: { user: { email: caller } } }) }, storage: { from: () => ({}) } }) };
/* ---------- fake Google Drive ---------- */
const drive = new Map(); let nextId = 0; let calls = 0;
const mk = (f) => { const id = '1AbC' + String(nextId++).padStart(6, '0') + '_dRiVe-' + 'x'.repeat(20); drive.set(id, { id, trashed: false, appProperties: {}, ...f }); return id; };
const ROOT = 'ROOT';
function list(qs) {
  const parent = (qs.match(/'([^']+)' in parents/) || [])[1];
  const nameM = qs.match(/name='((?:[^'\\]|\\.)*)'/); const name = nameM ? nameM[1].replace(/\\(.)/g, '$1') : null;
  const folderOnly = /mimeType='application\/vnd.google-apps.folder'/.test(qs);
  return [...drive.values()].filter((f) => !f.trashed && (!parent || f.parents[0] === (parent === 'root' ? ROOT : parent)) && (!name || f.name === name) && (!folderOnly || f.mimeType === 'application/vnd.google-apps.folder'));
}
const sessions = new Map();
globalThis.fetch = async (url, init = {}) => {
  calls++;
  const u = new URL(url); const method = (init.method || 'GET').toUpperCase();
  const resp = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(4), body: null });
  if (u.host === 'oauth2.googleapis.com') return resp({ access_token: 'tok' });
  if (u.pathname === '/upload/drive/v3/files' && u.searchParams.get('uploadType') === 'resumable') { const meta = JSON.parse(init.body); const s = 'https://upload.sim/s' + sessions.size; sessions.set(s, meta); return resp({}, 200, { location: s }); }
  if (u.host === 'upload.sim') { const meta = sessions.get(url); const id = mk({ name: meta.name, parents: meta.parents, appProperties: meta.appProperties, mimeType: 'image/jpeg' }); return resp({ id }); }
  if (u.pathname === '/drive/v3/files' && method === 'GET') return resp({ files: list(u.searchParams.get('q')).map((f) => ({ id: f.id, name: f.name })) });
  if (u.pathname === '/drive/v3/files' && method === 'POST') { const b = JSON.parse(init.body); const id = mk({ name: b.name, mimeType: b.mimeType, parents: b.parents || [ROOT], appProperties: b.appProperties || {} }); return resp({ id }); }
  const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
  if (m) { const f = drive.get(m[1]); if (!f) return resp({ error: 'nf' }, 404);
    if (method === 'PATCH') { const b = init.body ? JSON.parse(init.body) : {}; if (b.name) f.name = b.name; if ('trashed' in b) f.trashed = b.trashed; const add = u.searchParams.get('addParents'); if (add) { const rm = (u.searchParams.get('removeParents') || '').split(','); f.parents = [add, ...f.parents.filter((p) => !rm.includes(p))].slice(0, 1); } return resp({ id: f.id }); }
    return resp({ ...f }); }
  return resp({ error: 'unhandled ' + method + ' ' + url }, 500);
};
const env = { SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' };
let handler; globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => (handler = h) };
require('./out/gd.run.js');
const call = async (route, body) => { const r = await handler(new Request('https://sb/functions/v1/google-drive' + route, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) })); return r.json(); };
/* ---------- helpers ---------- */
const pathOf = (id) => { const out = []; let f = drive.get(id); while (f) { out.unshift(f.name); f = drive.get(f.parents && f.parents[0]); } return out.join(' / '); };
const live = () => [...drive.values()].filter((f) => !f.trashed);
const folderOf = (postId) => (tables.google_folders.find((r) => r.key === 'post/' + postId) || {}).folder_id;
const filesIn = (folderId) => live().filter((f) => f.parents[0] === folderId).map((f) => f.name).sort();
async function upload(postId, client, date, title, part, name = 'IMG.jpg') {
  const s = await call('/upload-session', { post: postId, client, date, title, part, name, type: 'image/jpeg', size: 10 });
  if (s.error) throw new Error(s.error);
  const r = await fetch(s.uploadUrl, { method: 'PUT' }); return (await r.json()).id;
}
function savePost(p) { const ex = tables.posts.find((r) => r.id === p.id); if (ex) Object.assign(ex, p); else tables.posts.push(p); }
const sync = (id) => call('/sync', { post: id });
(async () => {
  // 1. Upload before a title exists, cover + 3 carousel photos at the same time
  const ids = await Promise.all([upload('mwv3post-one1', 'sal', '2026-12-03', '', 'cover', 'cov.JPG'), upload('mwv3post-one1', 'sal', '2026-12-03', '', '1', 'a.jpg'), upload('mwv3post-one1', 'sal', '2026-12-03', '', '2', 'b.png'), upload('mwv3post-one1', 'sal', '2026-12-03', '', '3', 'c.jpg')]);
  const f1 = folderOf('mwv3post-one1');
  ok(live().filter((f) => f.mimeType === 'application/vnd.google-apps.folder' && f.name === 'Dec 03 – Untitled').length === 1, '4 uploads at once → one post folder: ' + pathOf(f1));
  ok(live().filter((f) => f.name === 'December').length === 1 && live().filter((f) => f.name === '2026').length === 1, 'one December and one 2026 folder');
  ok(JSON.stringify(filesIn(f1)) === JSON.stringify(['Dec 03 – Untitled – 01.jpg', 'Dec 03 – Untitled – 02.png', 'Dec 03 – Untitled – 03.jpg', 'Dec 03 – Untitled – cover.jpg']), 'untitled names, numbers padded: ' + filesIn(f1).join(', '));
  // 2. Give it a title and save
  const files = (n) => ids.slice(1).map((id, i) => ({ id: 'prev' + i, drive: id, name: ['a.jpg', 'b.png', 'c.jpg'][i] }));
  savePost({ id: 'mwv3post-one1', client_id: 'sal', post_date: '2026-12-03', title: 'Holiday gift guide', cover_file: { id: 'pc', drive: ids[0], name: 'cov.JPG' }, asset_file: files(), history: [] });
  await sync('mwv3post-one1');
  ok(pathOf(f1) === 'declan / 2026 / Saltair / December / Dec 03 – Holiday gift guide', 'title added → folder renamed: ' + pathOf(f1));
  ok(JSON.stringify(filesIn(f1)) === JSON.stringify(['Dec 03 – Holiday gift guide – 01.jpg', 'Dec 03 – Holiday gift guide – 02.png', 'Dec 03 – Holiday gift guide – 03.jpg', 'Dec 03 – Holiday gift guide – cover.jpg']), 'files renamed with the title');
  // 3. Nothing changed → nothing touched
  const before = calls; const again = await sync('mwv3post-one1');
  ok(again.changes.length === 0, 'saving again with no changes renames nothing (' + (calls - before) + ' Drive reads)');
  // 4. Reorder carousel: c, a, b
  const p1 = tables.posts.find((r) => r.id === 'mwv3post-one1'); const [a, b, c] = p1.asset_file; p1.asset_file = [c, a, b];
  await sync('mwv3post-one1');
  ok(drive.get(c.drive).name.endsWith('– 01.jpg') && drive.get(a.drive).name.endsWith('– 02.jpg') && drive.get(b.drive).name.endsWith('– 03.png'), 'reordered carousel → numbers follow the new order');
  // 5. Remove a photo (it goes to Drive's trash) → the rest renumber
  drive.get(a.drive).trashed = true; p1.asset_file = [c, b]; await sync('mwv3post-one1');
  ok(JSON.stringify(filesIn(f1)) === JSON.stringify(['Dec 03 – Holiday gift guide – 01.jpg', 'Dec 03 – Holiday gift guide – 02.png', 'Dec 03 – Holiday gift guide – cover.jpg']), 'removed photo → remaining renumber 01, 02: ' + filesIn(f1).join(', '));
  // 6. Move the date to next year
  p1.post_date = '2027-01-05'; await sync('mwv3post-one1');
  ok(pathOf(f1) === 'declan / 2027 / Saltair / January / Jan 05 – Holiday gift guide', 'date moved → folder moved and renamed: ' + pathOf(f1));
  ok(filesIn(f1).every((n) => n.startsWith('Jan 05 – ')), 'files renamed to the new date');
  // 7. Switch client
  p1.client_id = 'bee'; await sync('mwv3post-one1');
  ok(pathOf(f1) === 'declan / 2027 / BeeCee / January / Jan 05 – Holiday gift guide', 'client changed → folder moved: ' + pathOf(f1));
  // 8. Another post, same day and title, in the same place
  await upload('mwv3post-two2', 'sal', '2027-01-05', 'Holiday gift guide', 'cover');
  savePost({ id: 'mwv3post-two2', client_id: 'bee', post_date: '2027-01-05', title: 'Holiday gift guide', cover_file: { id: 'x', drive: [...drive.values()].at(-1).id, name: 'IMG.jpg' }, asset_file: [], history: [] });
  await sync('mwv3post-two2');
  ok(drive.get(folderOf('mwv3post-two2')).name === 'Jan 05 – Holiday gift guide (2)', 'same day + same title → "(2)": ' + drive.get(folderOf('mwv3post-two2')).name);
  await sync('mwv3post-two2'); await sync('mwv3post-one1');
  ok(drive.get(folderOf('mwv3post-two2')).name === 'Jan 05 – Holiday gift guide (2)' && drive.get(f1).name === 'Jan 05 – Holiday gift guide', 'saving either again keeps both names steady (no flip-flopping)');
  // 9. A duplicated post shares P1's photo: syncing the copy never moves P1's file
  const shared = p1.cover_file;
  await upload('mwv3post-thr3', 'sal', '2026-12-20', 'Copy', 'cover');
  savePost({ id: 'mwv3post-thr3', client_id: 'sal', post_date: '2026-12-20', title: 'Holiday gift guide (copy)', cover_file: shared, asset_file: [], history: [] });
  await sync('mwv3post-thr3');
  ok(drive.get(shared.drive).parents[0] === f1 && drive.get(shared.drive).name.endsWith('cover.jpg') && drive.get(shared.drive).name.startsWith('Jan 05 – Holiday gift guide'), "duplicate's sync leaves the original's photo where it is");
  // 10. Odd titles
  p1.title = "Kiehl's / Before: \"Glow\" 🎄"; await sync('mwv3post-one1');
  ok(drive.get(f1).name === "Jan 05 – Kiehl's Before Glow 🎄", 'odd title cleaned: ' + drive.get(f1).name);
  // 11. Two saves at the same moment
  p1.title = 'Final title'; await Promise.all([sync('mwv3post-one1'), sync('mwv3post-one1'), sync('mwv3post-one1')]);
  ok(drive.get(f1).name === 'Jan 05 – Final title' && filesIn(f1).filter((n) => n.includes('cover')).length === 1, 'three syncs at once → one clean result');
  // 12. Delete a post while another post still uses one of its photos → folder kept
  p1.history = [{ type: 'deleted' }]; drive.get(c.drive).trashed = true; drive.get(b.drive).trashed = true;
  await sync('mwv3post-one1');
  ok(!drive.get(f1).trashed && !drive.get(shared.drive).trashed, 'deleted post whose cover is still used by a copy → folder and photo kept');
  // 13. Delete a post whose files are all gone → folder trashed
  const f2 = folderOf('mwv3post-two2'); drive.get(tables.posts.find((r) => r.id === 'mwv3post-two2').cover_file.drive).trashed = true;
  tables.posts.find((r) => r.id === 'mwv3post-two2').history = [{ type: 'deleted' }]; await sync('mwv3post-two2');
  ok(drive.get(f2).trashed && !folderOf('mwv3post-two2'), 'deleted post with no files left → its folder goes to the trash');
  // 14. Someone trashes the folder by hand in Drive, then the post is saved → folder comes back
  const f3 = folderOf('mwv3post-thr3'); drive.get(f3).trashed = true; await sync('mwv3post-thr3');
  ok(!drive.get(f3).trashed, 'folder trashed by hand in Drive → restored on next save');
  // 15. Syncing a post that never had Drive files does nothing
  savePost({ id: 'mwv3post-nin9', client_id: 'sal', post_date: '2026-12-01', title: 'No files', history: [] });
  ok((await sync('mwv3post-nin9')).changes.length === 0, 'post with no Drive files → nothing happens');
  // 16. Only declan people can sync; a client account can't
  caller = 'client@x.com'; tables.members.push({ email: 'client@x.com', role: 'client' });
  ok((await sync('mwv3post-one1')).error === 'Not allowed', 'client accounts are refused'); caller = 'sonsoles@dma.com';
  ok((await call('/sync', { post: "../etc'" })).error === 'Missing post', 'malformed post id refused');
  // 17. Photos added to a new post that's then closed without saving → photos and the empty folder go to the trash
  const u1 = await upload('mwv3post-unsv1', 'sal', '2026-12-09', '', 'cover'); const u2 = await upload('mwv3post-unsv1', 'sal', '2026-12-09', '', '1');
  const fu = folderOf('mwv3post-unsv1');
  await call('/trash', { ids: [u1, u2] });
  ok(drive.get(u1).trashed && drive.get(u2).trashed && drive.get(fu).trashed && !folderOf('mwv3post-unsv1'), 'unsaved post closed → photos and its empty folder trashed');
  // 18. Removing one photo from a saved post never trashes its folder
  const f3b = folderOf('mwv3post-thr3'); const extra = await upload('mwv3post-thr3', 'sal', '2026-12-20', 'x', '1'); await call('/trash', { ids: [extra] });
  ok(!drive.get(f3b).trashed, 'removing a photo from a saved post keeps its folder');
  console.log(process.exitCode ? 'SOME FAILED' : 'ALL PASSED');
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
