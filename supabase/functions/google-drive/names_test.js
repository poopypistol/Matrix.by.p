const fs = require('fs');
const edge = fs.readFileSync('/home/claude/matrix.by.p/supabase/functions/google-drive/index.ts', 'utf8');
const site = fs.readFileSync('/home/claude/matrix.by.p/index.html', 'utf8');
// Pull the real functions out of the code.
const grab = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const SHORT = MONTHS.map(m => m.slice(0,3));
eval(grab(edge, 'function fileName(', '/* "Dec 03 – Holiday gift guide": one folder per post').replace(/: string/g, ''));
const pathLine = site.match(/const path = "drive\." \+ driveId \+ "\." \+ (.*);/)[1];
const buildPath = (driveId, file) => eval('"drive." + driveId + "." + ' + pathLine);
const parseLine = site.match(/\.map\(\(id\) => (String\(id\)\.split\("\."\)\[1\])\)/)[1];
const parse = (id) => eval(parseLine);
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
// Drive IDs are letters, digits, _ and -, with any of them anywhere.
const ids = ['1dnjLlfg2rKs3uQbdkIJhscpumsP_0WkW', '1EC_ZGd51KSrC-hKkpaBXn8A_P2KGuFyu', '-_-_abcDEF0123456789_-', '0B1234567890abcdefXYZ', '1a__b--c__d'];
const names = ['photo.jpg', 'IMG_1234.HEIC', 'my.holiday.photo.v2.png', '🎄 gift guide!!.jpg', '.jpg', 'no-extension', 'a'.repeat(240) + '.jpeg', 'café crème.JPG', 'file with   spaces.webp', '..hidden..png'];
for (const id of ids) for (const name of names) {
  const p = buildPath(id, { name });
  ok(parse(p) === id && /^[A-Za-z0-9._-]+$/.test(p), 'path ' + JSON.stringify(name).slice(0, 40) + ' id ' + id + ' -> ' + p.slice(0, 60));
}
// Drive file names
const titles = ['Kiehl\x27s \\ test', 'Holiday gift guide', '', '   ', 'Before/After: "Glow" <test> | 50%?', '🎄 Gift guide 🎁', 'x'.repeat(200), "Saltair's best"];
for (const t of titles) {
  const n = fileName('2026-12-03', t, 'cover', 'IMG_1.JPG');
  ok(/^Dec 03 – .+ – cover\.jpg$/.test(n) && !/[\\/:*?"<>|]/.test(n) && n.length < 120, 'title ' + JSON.stringify(t).slice(0, 30) + ' -> ' + n.slice(0, 70));
}
ok(fileName('', 'X', '1', 'a.png') === 'No date – X – 01.png', 'no date -> ' + fileName('', 'X', '1', 'a.png'));
ok(fileName('2026-12-03', 'X', '2', 'noext') === 'Dec 03 – X – 02', 'no extension -> ' + fileName('2026-12-03', 'X', '2', 'noext'));
ok(fileName('2026-01-09', 'X', '1', 'a.tar.gz') === 'Jan 09 – X – 01.gz', 'double extension keeps last -> ' + fileName('2026-01-09', 'X', '1', 'a.tar.gz'));
// Folder lookups: names go inside a quoted Drive search
const q = edge.match(/name='" \+ name((?:\.replace\(\/[^/]*\/g, "[^"]*"\))+)/)[1];
const esc = (name) => eval('name' + q);
for (const client of ["Saltair", "Bee & Cee", "Kiehl's", "A\\B Studio", "Fun 'n' Sun"]) {
  const quoted = "name='" + esc(client) + "'";
  const unescapedQuote = /(^|[^\\])'/.test(quoted.slice(6, -1).replace(/\\\\/g, ''));
  ok(!unescapedQuote && !/(^|[^\\])\\(?!['\\])/.test(quoted.slice(6, -1)), 'client folder ' + client + ' -> ' + quoted);
}
// Normal (non-Drive) uploads must never look like Drive ones
ok(!('8c1f-uuid' + '-' + 'drive.photo.jpg').startsWith('drive.'), 'normal upload with "drive." in its name is not mistaken for Drive');
