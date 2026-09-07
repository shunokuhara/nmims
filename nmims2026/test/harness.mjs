// D1 と ASSETS を模したテスト用ハーネス。本番では使わない。
// node --experimental-sqlite test/harness.mjs
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");

// ---- D1 shim ----
function bindArgs(sql, args) {
  const nums = [...new Set((sql.match(/\?(\d+)/g) || []).map((s) => Number(s.slice(1))))];
  if (!nums.length) return args;
  const o = {};
  for (const n of nums) {
    let v = args[n - 1];
    if (v === undefined) v = null;
    if (v instanceof ArrayBuffer) v = new Uint8Array(v);
    o[String(n)] = v;
  }
  return [o];
}
class Stmt {
  constructor(db, sql, args = null) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _prep() { const s = this.db.prepare(this.sql); return { s, a: this.args ? bindArgs(this.sql, this.args) : [] }; }
  // 本物の D1 は BLOB を number[] で返すので、それに合わせる
  _row(r) { if (!r) return r; for (const k in r) if (r[k] instanceof Uint8Array) r[k] = Array.from(r[k]); return r; }
  async first() { const { s, a } = this._prep(); const r = s.get(...a); return r === undefined ? null : this._row(r); }
  async all() { const { s, a } = this._prep(); return { results: s.all(...a).map((r) => this._row(r)), success: true }; }
  async run() { const { s, a } = this._prep(); s.run(...a); return { success: true }; }
}
class D1 {
  constructor(file) { this.db = new DatabaseSync(file); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try { const out = []; for (const st of stmts) out.push(await st.run()); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript" };
const ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, "public", p);
    if (!fs.existsSync(f)) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(f), { headers: { "content-type": MIME[path.extname(f)] || "text/plain" } });
  },
};
const DBFILE = path.join(ROOT, "test", "test.db");
fs.rmSync(DBFILE, { force: true });
const env = { DB: new D1(DBFILE), ASSETS, SESSION_SECRET: "testsecret", BOOTSTRAP_TOKEN: "opensesame" };

// ---- テスト補助 ----
const BASE = "https://peereval.test";
let failures = 0;
const ok = (cond, label, extra = "") => { console.log(`${cond ? " OK " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); if (!cond) failures++; };
const jar = {};
async function call(method, p, { body, form, as } = {}) {
  const headers = {};
  if (as && jar[as]) headers.cookie = jar[as];
  let b;
  if (form) b = form; else if (body !== undefined) { headers["content-type"] = "application/json"; b = JSON.stringify(body); }
  const res = await worker.fetch(new Request(BASE + p, { method, headers, body: b }), env);
  const sc = res.headers.get("set-cookie");
  if (sc && as) jar[as] = sc.split(";")[0];
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : ct.startsWith("text/") ? await res.text() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

// ---- 1. 初期化 ----
console.log("\n== 初期化 ==");
ok((await call("GET", "/api/bootstrap/status")).data.initialized === false, "初期化前は initialized=false");
ok((await call("POST", "/api/login", { body: { email: "a@b.c", password: "x" } })).status === 503, "初期化前のログインは 503");
ok((await call("POST", "/api/bootstrap", { body: { token: "wrong" } })).status === 401, "誤ったトークンは 401");
const boot = await call("POST", "/api/bootstrap", { body: { token: "opensesame" } });
ok(boot.status === 200 && boot.data.users === 1, "初期化が成功（管理者1名）", JSON.stringify(boot.data));
ok((await call("POST", "/api/bootstrap", { body: { token: "opensesame" } })).status === 409, "2回目は 409");

// ---- 2. 管理者ログイン（元の videoeval と同じパスワード） ----
console.log("\n== ログイン / 登録 ==");
const admin = "shunokuhara@icloud.com";
let adminPw = "MMDGeHGbizjFYHVbXCqm";
const credFile = path.join(ROOT, "CREDENTIALS.md");
if (fs.existsSync(credFile)) { const m = fs.readFileSync(credFile, "utf8").match(/shunokuhara@icloud\.com[^`]*`([^`]+)`/); if (m) adminPw = m[1]; }
const al = await call("POST", "/api/login", { body: { email: admin, password: adminPw }, as: admin });
ok(al.status === 200 && al.data.role === "admin", "管理者が元のパスワードでログインできる");
ok((await call("POST", "/api/login", { body: { email: admin, password: "wrong" } })).status === 401, "誤パスワードは 401");

const students = Array.from({ length: 12 }, (_, i) => ({ email: `s${i + 1}@nmims.test`, name: `Student ${i + 1}`, sid: `R${100 + i}`, pw: "password" + i }));
ok((await call("POST", "/api/register", { body: { email: "bad", name: "x", password: "password1" } })).data.error === "bad_email", "不正なメールは弾かれる");
ok((await call("POST", "/api/register", { body: { email: "x@y.z", name: "x", password: "short" } })).data.error === "weak_password", "短いパスワードは弾かれる");
ok((await call("POST", "/api/register", { body: { email: "x@y.z", name: "", password: "password1" } })).data.error === "name_required", "氏名なしは弾かれる");
for (const s of students) {
  const r = await call("POST", "/api/register", { body: { email: s.email, name: s.name, student_id: s.sid, password: s.pw }, as: s.email });
  if (r.status !== 200) ok(false, `登録 ${s.email}`, JSON.stringify(r.data));
}
ok((await call("GET", "/api/admin/users", { as: admin })).data.users.length === 13, "学生12名が登録された");
ok((await call("POST", "/api/register", { body: { email: students[0].email, name: "dup", password: "password1" } })).status === 409, "重複登録は 409");
ok((await call("GET", "/api/me", { as: students[0].email })).data.role === "student", "登録直後にログイン状態になる");
ok((await call("GET", "/api/admin/users", { as: students[0].email })).status === 403, "学生が管理APIを叩くと 403");
ok((await call("POST", "/api/admin/settings", { as: admin, body: { register_code: "AGENTIC" } })).data.ok, "登録コードを設定");
ok((await call("POST", "/api/register", { body: { email: "late@nmims.test", name: "Late", password: "password1" } })).data.error === "bad_code", "コードなしの登録は弾かれる");
ok((await call("POST", "/api/register", { body: { email: "late@nmims.test", name: "Late", password: "password1", code: "AGENTIC" }, as: "late@nmims.test" })).status === 200, "コード付きなら登録できる");
await call("POST", "/api/admin/settings", { as: admin, body: { register_code: "" } });

// ---- 3. 提出 ----
console.log("\n== 提出 ==");
const html = (i) => `<!doctype html><html><body><svg viewBox="0 0 1200 1066"><rect id="sky" width="1200" height="600" fill="#f80"/><text x="76" y="140">CHAI ${i}</text></svg><script>document.title='w${i}'</script></body></html>`;
function imageForm(i, { url = "", title = "" } = {}) {
  const fd = new FormData();
  fd.set("track", "image"); fd.set("title", title || `Mumbai remix ${i}`); if (url) fd.set("url", url);
  fd.set("file", new File([html(i)], `shinsekai_remix_${i}.html`, { type: "text/html" }));
  return fd;
}
const noFile = new FormData(); noFile.set("track", "image");
ok((await call("POST", "/api/work", { as: students[0].email, form: noFile })).data.error === "nothing_to_submit", "ファイルもURLもない提出は弾かれる");
const badExt = new FormData(); badExt.set("track", "image"); badExt.set("file", new File(["x"], "a.exe"));
ok((await call("POST", "/api/work", { as: students[0].email, form: badExt })).data.error === "bad_file_type", "拡張子が不正なファイルは弾かれる");
const big = new FormData(); big.set("track", "image"); big.set("file", new File([new Uint8Array(1600000)], "big.html"));
ok((await call("POST", "/api/work", { as: students[0].email, form: big })).data.error === "file_too_large", "1.5MB 超は弾かれる");
const vNoUrl = new FormData(); vNoUrl.set("track", "video");
ok((await call("POST", "/api/work", { as: students[0].email, form: vNoUrl })).data.error === "url_required", "動画は URL 必須");
const vFile = new FormData(); vFile.set("track", "video"); vFile.set("url", "https://youtu.be/abc123"); vFile.set("file", new File(["x"], "a.png"));
ok((await call("POST", "/api/work", { as: students[0].email, form: vFile })).data.error === "file_not_allowed", "動画にファイルは付けられない");

// 10名が画像を提出（うち1名はURLのみ）、9名が動画を提出
for (let i = 0; i < 10; i++) {
  const s = students[i];
  let fd;
  if (i === 9) { fd = new FormData(); fd.set("track", "image"); fd.set("url", "https://1drv.ms/x/abc"); }
  else fd = imageForm(i + 1);
  const r = await call("POST", "/api/work", { as: s.email, form: fd });
  if (!r.data.ok) ok(false, `画像提出 ${s.email}`, JSON.stringify(r.data));
}
for (let i = 0; i < 9; i++) {
  const fd = new FormData(); fd.set("track", "video");
  fd.set("url", i % 3 === 0 ? `https://drive.google.com/file/d/FILE${i}/view?usp=sharing` : i % 3 === 1 ? `https://www.youtube.com/watch?v=vid${i}` : `https://1drv.ms/v/c/x/y${i}`);
  const r = await call("POST", "/api/work", { as: students[i].email, form: fd });
  if (!r.data.ok) ok(false, `動画提出 ${students[i].email}`, JSON.stringify(r.data));
}
const ws = (await call("GET", "/api/admin/works", { as: admin })).data.works;
ok(ws.filter((w) => w.track === "image").length === 10 && ws.filter((w) => w.track === "video").length === 9, "画像10 / 動画9 が登録された", `${ws.length}件`);
ok(ws.find((w) => w.id === "v001").embed_url.includes("/preview"), "Drive URL が埋め込みに変換される");
ok(ws.find((w) => w.id === "v002").embed_url.includes("youtube.com/embed"), "YouTube URL が埋め込みに変換される");
ok(ws.find((w) => w.id === "v003").embed_url === "", "OneDrive はリンクのまま");
const re = await call("POST", "/api/work", { as: students[0].email, form: imageForm(1, { title: "Updated" }) });
ok(re.data.ok && re.data.updated && re.data.id === "i001", "再提出は同じ ID に上書き");
ok((await call("GET", "/api/admin/works?track=image", { as: admin })).data.works.length === 10, "再提出で件数が増えない");
const dash = (await call("GET", "/api/dashboard", { as: students[0].email })).data;
ok(dash.tracks.image.work && dash.tracks.image.work.title === "Updated" && dash.tracks.video.work, "ダッシュボードに自分の提出が出る");

// ---- 4. 割当 ----
console.log("\n== 割当 ==");
const t1 = (await call("GET", "/api/tasks?track=image", { as: students[0].email })).data;
ok(t1.tasks.length === 5, "既定で5本割り当てられる", `${t1.tasks.length}本`);
ok(!t1.tasks.some((t) => t.work_id === "i001"), "自分の作品は割り当てられない");
ok(t1.tasks.every((t) => t.title !== undefined && !("owner_email" in t)), "作者情報は返さない");
const t1b = (await call("GET", "/api/tasks?track=image", { as: students[0].email })).data;
ok(JSON.stringify(t1b.tasks.map((t) => t.work_id)) === JSON.stringify(t1.tasks.map((t) => t.work_id)), "再取得しても割当が変わらない");
for (const s of students.slice(1)) await call("GET", "/api/tasks?track=image", { as: s.email });
const cover = (await call("GET", "/api/admin/works?track=image", { as: admin })).data.works.map((w) => w.n_assigned);
ok(Math.max(...cover) - Math.min(...cover) <= 1, "割当回数が作品間で均される", cover.join(","));
ok(cover.reduce((a, b) => a + b, 0) === 12 * 5, "12名×5本=60割当", cover.reduce((a, b) => a + b, 0));
// 評価数を7に増やすと不足分が補充される
await call("POST", "/api/admin/settings", { as: admin, body: { image_k: "7" } });
ok((await call("GET", "/api/tasks?track=image", { as: students[0].email })).data.tasks.length === 7, "評価数を増やすと補充される");
await call("POST", "/api/admin/settings", { as: admin, body: { image_k: "5" } });
ok((await call("GET", "/api/tasks?track=image", { as: students[0].email })).data.tasks.length === 7, "減らしても割当済みは残る");
ok((await call("GET", "/api/tasks?track=video", { as: students[11].email })).data.tasks.length === 5, "動画も割り当てられる（未提出者でも評価できる）");
ok((await call("GET", "/api/tasks?track=bogus", { as: students[0].email })).status === 400, "不明な track は 400");

// ---- 5. ファイル配信の権限 ----
console.log("\n== ファイル配信 ==");
const assignedId = t1.tasks.find((t) => t.has_file).work_id;
const notAssigned = ws.filter((w) => w.track === "image" && w.has_file && w.id !== "i001" && !t1b.tasks.some((t) => t.work_id === w.id))[0];
const f1 = await call("GET", `/api/work/${assignedId}/file`, { as: students[0].email });
ok(f1.status === 200 && String(f1.headers.get("content-type")).startsWith("text/html"), "割り当てられた作品のファイルは見られる");
ok(String(f1.headers.get("content-security-policy")).startsWith("sandbox"), "HTML は sandbox 付き CSP で返る");
ok(typeof f1.data === "string" && f1.data.startsWith("<!doctype html") || String(f1.data).includes("<html"), "ファイルの中身がバイト列のまま返る（number[] の文字列化ではない）", String(f1.data).slice(0, 30));
ok((await call("GET", `/api/work/i001/file`, { as: students[0].email })).status === 200, "自分の作品は見られる");
if (notAssigned) ok((await call("GET", `/api/work/${notAssigned.id}/file`, { as: students[0].email })).status === 403, "割り当てられていない作品は 403");
ok((await call("GET", `/api/work/${assignedId}/file`, { as: admin })).status === 200, "管理者は全部見られる");
ok((await call("GET", `/api/work/${assignedId}/file`)).status === 401, "未ログインは 401");

// ---- 6. 回答 ----
console.log("\n== 回答 ==");
const s0 = students[0].email;
const good = { i1: 3, i2: 2, i3: 1, i4: 2, i5: "The saffron signboards and the auto-rickshaw at the corner make the street read as Mumbai immediately.", i6: "The sky gradient is still Osaka orange; a hazier monsoon grey would suit the theme better here." };
ok((await call("POST", "/api/response", { as: s0, body: { track: "image", position: 0, answers: { ...good, i1: 4 } } })).data.error === "range:i1", "i1 に 4 は弾かれる");
const short = await call("POST", "/api/response", { as: s0, body: { track: "image", position: 0, answers: { ...good, i5: "Nice colors." } } });
ok(short.data.error === "too_short:i5" && short.data.words === 2, "10語未満のコメントは弾かれる");
ok((await call("POST", "/api/response", { as: s0, body: { track: "image", position: 0, answers: { ...good, i6: Array(45).fill("word").join(" ") } } })).data.error === "too_long:i6", "40語超は弾かれる");
ok((await call("POST", "/api/response", { as: s0, body: { track: "image", position: 99, answers: good } })).status === 404, "存在しない position は 404");
ok((await call("POST", "/api/response", { as: s0, body: { track: "image", position: 0, answers: good } })).data.ok === true, "正しい回答は保存される");
ok((await call("GET", "/api/tasks?track=image", { as: s0 })).data.tasks[0].done === true, "回答済みフラグが立つ");
ok((await call("GET", "/api/tasks?track=image", { as: s0 })).data.tasks[0].answers.i5 === good.i5, "自分の回答が読み戻せる");

let seedN = 7;
const rnd = () => ((seedN = (seedN * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let posted = 0;
for (const s of students) {
  const ts = (await call("GET", "/api/tasks?track=image", { as: s.email })).data.tasks;
  for (const t of ts) {
    const a = { i1: Math.floor(rnd() * 4), i2: Math.floor(rnd() * 4), i3: Math.floor(rnd() * 4), i4: Math.floor(rnd() * 4),
      i5: "The strongest point is the consistent saffron palette across every signboard and the added garland.",
      i6: "It could be improved by removing the leftover Japanese characters on the lower-left board." };
    const r = await call("POST", "/api/response", { as: s.email, body: { track: "image", position: t.position, answers: a, elapsed_ms: 3000 + rnd() * 60000 } });
    if (r.data.ok) posted++;
  }
  const vs = (await call("GET", "/api/tasks?track=video", { as: s.email })).data.tasks;
  for (const t of vs) {
    const a = {}; for (let q = 1; q <= 8; q++) a["q" + q] = q === 2 ? Math.floor(rnd() * 2) : Math.floor(rnd() * 4);
    const r = await call("POST", "/api/response", { as: s.email, body: { track: "video", position: t.position, ...a, elapsed_ms: 20000 } });
    if (r.data.ok) posted++;
  }
}
ok(posted === 62 + 12 * 5, "画像62件 + 動画60件の回答が保存された", `${posted}件`);
ok((await call("POST", "/api/response", { as: s0, body: { track: "video", position: 0, q1: 0, q2: 2, q3: 0, q4: 0, q5: 0, q6: 0, q7: 0, q8: 0 } })).data.error === "range:q2", "q2 は二値");
await call("POST", "/api/admin/settings", { as: admin, body: { image_eval: "0" } });
ok((await call("POST", "/api/response", { as: s0, body: { track: "image", position: 0, answers: good } })).status === 403, "評価停止中は 403");
ok((await call("GET", "/api/tasks?track=image", { as: s0 })).data.eval_open === false, "停止中は eval_open=false");
await call("POST", "/api/admin/settings", { as: admin, body: { image_eval: "1", image_submit: "0" } });
ok((await call("POST", "/api/work", { as: students[10].email, form: imageForm(11) })).status === 403, "提出停止中は 403");
await call("POST", "/api/admin/settings", { as: admin, body: { image_submit: "1" } });

// ---- 7. 集計 ----
console.log("\n== 集計 ==");
const pi = (await call("GET", "/api/admin/progress?track=image", { as: admin })).data;
ok(pi.max === 12 && pi.items.length === 4 && pi.text_items.length === 2, "画像: 満点12、採点4項目、自由記述2");
ok(pi.n_responses === 62, "画像の回答数 62", pi.n_responses);
ok(pi.works.every((w) => w.total == null || (w.total >= 0 && w.total <= 12)), "合計が 0-12 の範囲");
ok(pi.works.some((w) => w.comments.length && w.comments[0].i5.length > 10), "コメントが作品ごとに付く");
ok(pi.raters.length === 12, "評価者12名分");
const pv = (await call("GET", "/api/admin/progress?track=video", { as: admin })).data;
ok(pv.max === 22 && pv.items.length === 8 && pv.usage[1].counts.length === 2, "動画: 満点22、8項目、q2 は2カテゴリ");

// ---- 8. 管理操作 ----
console.log("\n== 管理操作 ==");
ok((await call("POST", "/api/admin/user", { as: admin, body: { email: admin, role: "student" } })).data.error === "self_lockout", "自分の管理者権限は落とせない");
ok((await call("POST", "/api/admin/user", { as: admin, body: { email: students[1].email, password: "newpassword9" } })).data.ok, "学生のパスワードをリセットできる");
ok((await call("POST", "/api/login", { body: { email: students[1].email, password: "newpassword9" } })).status === 200, "新パスワードでログインできる");
ok((await call("POST", "/api/admin/user", { as: admin, body: { email: students[2].email, active: 0 } })).data.ok, "学生を停止できる");
ok((await call("GET", "/api/me", { as: students[2].email })).status === 401, "停止した学生は弾かれる");
await call("POST", "/api/admin/user", { as: admin, body: { email: students[2].email, active: 1 } });
ok((await call("POST", "/api/admin/rebuild", { as: admin, body: { email: s0, track: "image" } })).status === 409, "回答済みの再割当は確認を求める");
ok((await call("POST", "/api/admin/rebuild", { as: admin, body: { email: s0, track: "image", force: true } })).data.n === 5, "force なら再割当できる");
ok((await call("POST", "/api/admin/work", { as: admin, body: { id: "i002", active: false } })).data.ok, "作品を出題対象から外せる");
const proxy = new FormData(); proxy.set("track", "video"); proxy.set("owner_email", students[11].email); proxy.set("url", "https://vimeo.com/12345");
const pr = await call("POST", "/api/work", { as: admin, form: proxy });
ok(pr.data.ok && pr.data.id === "v010", "管理者が代理提出できる", JSON.stringify(pr.data));
ok((await call("POST", "/api/work", { as: admin, form: (() => { const f = new FormData(); f.set("track", "video"); f.set("owner_email", "nobody@x.y"); f.set("url", "https://vimeo.com/1"); return f; })() })).status === 404, "存在しない学生への代理提出は 404");
ok((await call("POST", "/api/admin/work", { as: admin, body: { id: "v010", delete: true } })).data.deleted, "作品を削除できる");
ok((await call("POST", "/api/password", { as: s0, body: { current: "password0", password: "changed123" } })).data.ok, "学生が自分でパスワードを変えられる");
ok((await call("POST", "/api/password", { as: s0, body: { current: "wrong", password: "changed456" } })).status === 401, "現在のパスワードが違えば変えられない");

// ---- 9. CSV と静的ページ ----
console.log("\n== CSV / 静的ページ ==");
const csv = await call("GET", "/api/admin/export.csv?track=image", { as: admin });
const lines = String(csv.data).trim().split("\n");
ok(lines[0].includes("rater_email") && lines[0].includes("i5") && lines[0].includes("owner_student_id"), "画像CSV のヘッダ");
ok(lines.length === 62 - 7 + 1, "画像CSV は再割当後の行数 + ヘッダ", `${lines.length}行`);
const vcsv = String((await call("GET", "/api/admin/export.csv?track=video", { as: admin })).data).trim().split("\n");
ok(vcsv[0].includes("q8") && vcsv.length === 61, "動画CSV は 60行 + ヘッダ", `${vcsv.length}行`);
ok(String((await call("GET", "/api/admin/summary.csv?track=image", { as: admin })).data).includes("mean_total"), "作品別集計CSV");
for (const p of ["/", "/register/", "/setup/", "/student/", "/evaluate/", "/admin/", "/styles.css"]) {
  const r = await worker.fetch(new Request(BASE + p), env);
  ok(r.status === 200, `静的 ${p}`);
}

console.log(`\n${failures === 0 ? "すべて通過" : failures + " 件失敗"}`);
process.exit(failures ? 1 : 0);
