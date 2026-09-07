// NMIMS 2026 相互評価アプリ — Cloudflare Worker + D1
//
// awec2026（videoeval）から派生。別の Worker・別の D1 で動かす。
// 学生は /register/ で自分で登録し、2種類の課題（image / video）を提出して、互いに評価する。
//
//   /           ログイン
//   /register/  学生の自己登録
//   /setup/     初期化（スキーマ作成 + 管理者投入。1回だけ）
//   /student/   学生の画面（提出、評価の進捗）
//   /evaluate/  評価画面（?track=image | video）
//   /admin/     管理画面
//   /api/...    API
//
// ダッシュボードで設定するもの:
//   D1 バインディング  DB               （データベースは自分で作る。名前は peereval など）
//   シークレット       SESSION_SECRET   Cookie の署名鍵。長いランダム文字列
//   シークレット       BOOTSTRAP_TOKEN  /setup/ で使う合言葉。初期化が済めば不要

import { SEED_USERS } from "./seed.js";

// ---------- 評価項目（唯一の出典） ----------
// 学生向けの画面は英語で出す。name_ja / options_ja は元の日本語（LLM 評価器や記録用）。
const ITEMS_VERSION = "1.0.0";

// 課題1: 大阪・新世界の街をムンバイ（自分のテーマ）に作り変える（演習1、shinsekai_remix.html）
const IMAGE_ITEMS = [
  { id: "i1", layer: 1, type: "ordinal",
    name: "Theme clarity", name_ja: "テーマの伝わりやすさ",
    desc: "Does the city, culture and atmosphere the author intended come across?",
    desc_ja: "作者が表現した街・文化・雰囲気が伝わるか。",
    options: [
      "Cannot tell what city or theme was intended",
      "The theme is only vaguely recognizable",
      "The theme is recognizable, though some parts are unclear",
      "The city, culture and atmosphere come across clearly"],
    options_ja: ["どの街・テーマか分からない", "テーマが漠然としか分からない", "テーマは分かるが不明確な部分がある", "街・文化・雰囲気が明確に伝わる"] },
  { id: "i2", layer: 1, type: "ordinal",
    name: "Creativity", name_ja: "創造性",
    desc: "Are there original ideas and devices, beyond simply changing colors?",
    desc_ja: "単なる色変更ではなく、独自のアイデアや工夫があるか。",
    options: [
      "Almost unchanged from the original, or colors only",
      "Standard changes (colors, removed text) with little of the author's own idea",
      "Some original ideas or additions",
      "Distinct, original ideas throughout the work"],
    options_ja: ["ほぼ元のまま、または色を変えただけ", "定型的な変更のみで独自の発想が乏しい", "独自のアイデアや追加がいくつかある", "全体に独自の発想が行き渡っている"] },
  { id: "i3", layer: 1, type: "ordinal",
    name: "Visual quality", name_ja: "視覚的な完成度",
    desc: "Are layout, colors, text and overlaps well organized?",
    desc_ja: "配置、配色、文字、重なりなどが整っているか。",
    options: [
      "Broken: severe overlaps, elements off-screen, unreadable text",
      "Several noticeable problems in layout, color or text",
      "Mostly clean, with minor issues",
      "Clean and well composed"],
    options_ja: ["崩れている（ひどい重なり、はみ出し、読めない文字）", "配置・配色・文字に目立つ問題がいくつかある", "おおむね整っており軽微な問題のみ", "整っていて構成もよい"] },
  { id: "i4", layer: 1, type: "ordinal",
    name: "Appeal", name_ja: "魅力・印象度",
    desc: "Is the work interesting to look at and memorable?",
    desc_ja: "見ていて面白く、印象に残る作品になっているか。",
    options: [
      "Not interesting; I would not remember it",
      "Slightly interesting",
      "Interesting and fairly memorable",
      "Striking; I would remember it"],
    options_ja: ["面白くなく、印象に残らない", "少し面白い", "面白く、ある程度印象に残る", "強く印象に残る"] },
  { id: "i5", layer: 2, type: "text", min_words: 10, max_words: 40,
    name: "What is the strongest point of this work? Please be specific.", name_ja: "この作品の最も優れた点は何ですか。具体的に。",
    hint: "10–30 words" },
  { id: "i6", layer: 2, type: "text", min_words: 10, max_words: 40,
    name: "What could be improved further? Please be specific.", name_ja: "さらに改善できる点は何ですか。具体的に。",
    hint: "10–30 words" },
];
const IMAGE_LAYER_LABEL = { 1: "Rating", 2: "Comment" };

// 課題2: 動画。videoeval の Q1-Q8 をそのまま、北九州市 → ムンバイに置き換えたもの。
const VIDEO_ITEMS = [
  { id: "q1", layer: 1, type: "ordinal", name: "Technical breakdown", name_ja: "技術的破綻", options: [
    "So broken that it is hard to keep watching", "The flaws distract from the content",
    "Some flaws, but the content comes across", "Nothing particularly bothers me"],
    options_ja: ["見続けるのが難しいほど崩れている", "崩れが気になって内容が入ってこない", "気になる箇所はあるが内容は伝わる", "特に気にならない"] },
  { id: "q2", layer: 1, type: "binary", name: "Identifiable as Mumbai", name_ja: "ムンバイの識別", options: [
    "Cannot tell that it introduces Mumbai", "Can tell that it introduces Mumbai"],
    options_ja: ["ムンバイの紹介だとは分からない", "ムンバイの紹介だと分かる"] },
  { id: "q3", layer: 1, type: "ordinal", name: "Message clarity", name_ja: "メッセージ明瞭性", options: [
    "Cannot tell what it wants to say", "Only vaguely says \"this is a nice place\"",
    "Several things it wants to convey are shown", "What it wants to convey is clearly focused"],
    options_ja: ["何を伝えたいのか分からない", "漠然と「良い場所」と言っているだけ", "伝えたいものがいくつか示されている", "何を伝えたいかが明確に絞られている"] },
  { id: "q4", layer: 2, type: "ordinal", name: "City-name replaceability", name_ja: "都市名の置換可能性", options: [
    "Would work as-is with any other city name", "Would work for another city with small changes",
    "Parts of it only work for Mumbai", "Only works for Mumbai"],
    options_ja: ["他の都市名に変えてもそのまま成立する", "少し手を入れれば他の都市でも成立する", "一部はムンバイでないと成立しない", "ムンバイでなければ成立しない"] },
  { id: "q5", layer: 2, type: "ordinal", name: "Specificity of tourism information", name_ja: "観光情報の具体性", options: [
    "Cannot tell what one can do in Mumbai", "Only the atmosphere comes across",
    "One or two places or experiences are shown", "Places or experiences are shown concretely"],
    options_ja: ["ムンバイで何ができるか分からない", "雰囲気だけ伝わる", "行き先や体験が1つ2つ示されている", "行き先や体験が具体的に示されている"] },
  { id: "q6", layer: 2, type: "ordinal", name: "Perceived originality", name_ja: "知覚された独自性", options: [
    "I have seen this kind of video many times", "Feels like a common style",
    "Feels like a style I rarely see", "Feels like a style I have never seen before"],
    options_ja: ["同じような動画を何度も見たことがある", "よくある表現だと感じる", "あまり見ない表現だと感じる", "これまで見たことのない表現だと感じる"] },
  { id: "q7", layer: 3, type: "ordinal", name: "Intention to visit", name_ja: "訪問意欲", options: [
    "I do not feel like visiting", "I got a little interested",
    "I would like to look into it in detail", "I would consider it as a travel destination"],
    options_ja: ["行ってみたいとは思わない", "少し興味を持った", "詳しく調べてみたいと思った", "旅行先の候補として考えたいと思った"] },
  { id: "q8", layer: 3, type: "ordinal", name: "Intention to share", name_ja: "共有意向", options: [
    "I would not share it", "I might mention it in conversation",
    "I would send it to friends individually", "I would post it publicly (e.g. social media) and recommend it"],
    options_ja: ["共有しようと思わない", "話題として口頭で伝える程度", "知人に個別に送りたい", "SNSなどで公開して薦めたい"] },
];
const VIDEO_LAYER_LABEL = { 1: "Eligibility", 2: "Regional specificity", 3: "Appeal" };

const TRACKS = {
  image: { label: "Assignment 1: City remix (Osaka → Mumbai)", label_ja: "課題1 街のリミックス（大阪→ムンバイ）",
    items: IMAGE_ITEMS, layer_label: IMAGE_LAYER_LABEL, prefix: "i",
    submit: "Upload your remixed HTML file (shinsekai_remix.html) or a screenshot (PNG/JPG). Max 1.5 MB.",
    accept: ".html,.htm,.png,.jpg,.jpeg,.webp,.svg" },
  video: { label: "Assignment 2: Video (Mumbai)", label_ja: "課題2 動画（ムンバイ）",
    items: VIDEO_ITEMS, layer_label: VIDEO_LAYER_LABEL, prefix: "v",
    submit: "Paste a shareable link to your video (Google Drive with \"Anyone with the link\", YouTube or Vimeo). Files cannot be uploaded here.",
    accept: "" },
};
const TRACK_IDS = Object.keys(TRACKS);
const trackOf = (t) => (TRACKS[t] ? t : null);
const scoreItems = (track) => TRACKS[track].items.filter((i) => i.type !== "text");
const itemMax = (it) => (it.type === "binary" ? 1 : 3);
const trackMax = (track) => scoreItems(track).reduce((a, it) => a + itemMax(it), 0);

// ---------- スキーマ ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', student_id TEXT NOT NULL DEFAULT '',
     role TEXT NOT NULL DEFAULT 'student', pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL,
     seed INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS works (
     id TEXT PRIMARY KEY, track TEXT NOT NULL, owner_email TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', embed_url TEXT NOT NULL DEFAULT '',
     file_blob BLOB, file_type TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0,
     note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (track, owner_email))`,
  `CREATE TABLE IF NOT EXISTS tasks (
     rater_email TEXT NOT NULL, track TEXT NOT NULL, position INTEGER NOT NULL, work_id TEXT NOT NULL,
     created_at TEXT NOT NULL, PRIMARY KEY (rater_email, track, position))`,
  `CREATE TABLE IF NOT EXISTS responses (
     rater_email TEXT NOT NULL, track TEXT NOT NULL, position INTEGER NOT NULL, work_id TEXT NOT NULL,
     answers TEXT NOT NULL, elapsed_ms INTEGER, items_version TEXT, created_at TEXT, updated_at TEXT,
     PRIMARY KEY (rater_email, track, position))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_work ON tasks(work_id)`,
  `CREATE INDEX IF NOT EXISTS idx_responses_work ON responses(work_id)`,
  `CREATE INDEX IF NOT EXISTS idx_works_track ON works(track)`,
];
const DEFAULT_SETTINGS = [
  ["image_k", "5"], ["video_k", "5"],          // 1人が評価する作品数
  ["image_submit", "1"], ["video_submit", "1"], // 提出の受付
  ["image_eval", "1"], ["video_eval", "1"],    // 評価の受付
  ["image_results", "0"], ["video_results", "0"], // 受けた評価の学生への公開（評価終了後に 1 にする）
  ["register_open", "1"], ["register_code", ""], // 自己登録の受付 / 合言葉（空なら不要）
  ["notice", ""],                              // 学生画面に出す告知
];
const MAX_FILE = 1500000; // D1 の BLOB 上限（2MB）に余裕を残す

// ---------- 小道具 ----------
const json = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", ...h } });
const text = (b, s = 200, h = {}) => new Response(b, { status: s, headers: h });
const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((x) => parseInt(x, 16)));
const nowIso = () => new Date().toISOString();
const wordCount = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

async function pwHash(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(saltHex), iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}
async function hmac(env, msg) {
  const secret = env.SESSION_SECRET || "dev-insecure-secret-change-me";
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const SESSION_DAYS = 30;
async function makeToken(env, email) {
  const body = `${email}.${Date.now() + SESSION_DAYS * 86400000}`;
  return `${body}.${await hmac(env, body)}`;
}
async function readToken(env, token) {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i);
  if ((await hmac(env, body)) !== token.slice(i + 1)) return null;
  const j = body.lastIndexOf(".");
  if (!(Number(body.slice(j + 1)) > Date.now())) return null;
  return body.slice(0, j);
}
function cookieOf(request, name) {
  for (const p of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = p.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
async function getUser(db, env, request) {
  const email = await readToken(env, cookieOf(request, "pe_session"));
  if (!email) return null;
  const row = await db.prepare("SELECT email,name,student_id,role,active,seed FROM users WHERE email=?1").bind(email).first();
  return row && row.active ? row : null;
}
const cookieHeader = (v, maxAge) => `pe_session=${v}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}; Secure`;

async function setting(db, key, dflt) {
  const r = await db.prepare("SELECT value FROM settings WHERE key=?1").bind(key).first();
  return r ? r.value : dflt;
}
async function allSettings(db) {
  const rows = (await db.prepare("SELECT key,value FROM settings").all()).results || [];
  const s = Object.fromEntries(DEFAULT_SETTINGS);
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function toEmbed(url) {
  const u = String(url || "");
  let m = u.match(/drive\.google\.com\/file\/d\/([^/?#]+)/); if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  m = u.match(/drive\.google\.com\/open\?id=([^&]+)/); if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]+)/); if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = u.match(/vimeo\.com\/(\d+)/); if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return "";
}
const isHttpUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ""));

const EXT_TYPE = { html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
const fileTypeOf = (name) => EXT_TYPE[String(name || "").toLowerCase().split(".").pop()] || "";
const isHtmlType = (t) => String(t || "").startsWith("text/html");
// D1 から読んだ BLOB（number[] / ArrayBuffer / Uint8Array のどれでも）を Uint8Array にする
const toBytes = (b) => b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : Array.isArray(b) ? Uint8Array.from(b) : new Uint8Array(0);

// ---------- 出題（評価する作品の割当） ----------
// 呼ばれた時点で、その学生に割り当て済みの作品が k 本未満なら、足りない分を補充する。
// 候補は「有効」「自分の作品でない」「未割当」の作品から、割当回数が少ないものを優先する。
// 同数のときは学生の seed で決まる順にする（再現できる）。
async function ensureTasks(db, user, track) {
  const k = Math.max(0, Number(await setting(db, `${track}_k`, "5")) || 0);
  const have = (await db.prepare("SELECT work_id FROM tasks WHERE rater_email=?1 AND track=?2 ORDER BY position")
    .bind(user.email, track).all()).results || [];
  if (have.length >= k) return have.length;
  const assigned = new Set(have.map((r) => r.work_id));
  const cands = ((await db.prepare(
    `SELECT w.id, (SELECT COUNT(*) FROM tasks t WHERE t.work_id=w.id) AS n
       FROM works w WHERE w.track=?1 AND w.active=1 AND w.owner_email<>?2 ORDER BY w.id`)
    .bind(track, user.email).all()).results || []).filter((w) => !assigned.has(w.id));
  if (!cands.length) return have.length;
  const rnd = mulberry32((user.seed ^ (track === "image" ? 0x1234567 : 0x7654321)) | 0);
  for (const c of cands) c.r = rnd();
  cands.sort((a, b) => a.n - b.n || a.r - b.r);
  const add = cands.slice(0, k - have.length);
  const st = db.prepare("INSERT INTO tasks (rater_email,track,position,work_id,created_at) VALUES (?1,?2,?3,?4,?5)");
  const now = nowIso();
  await db.batch(add.map((c, i) => st.bind(user.email, track, have.length + i, c.id, now)));
  return have.length + add.length;
}

// ---------- 初期化 ----------
async function tablesExist(db) {
  try { await db.prepare("SELECT 1 FROM users LIMIT 1").first(); return true; } catch { return false; }
}
async function apiSetupStatus(db, env) {
  if (!(await tablesExist(db))) return json({ initialized: false, ready: !!env.BOOTSTRAP_TOKEN });
  const n = await db.prepare("SELECT COUNT(*) n FROM users").first();
  return json({ initialized: !!(n && n.n > 0), ready: !!env.BOOTSTRAP_TOKEN });
}
async function apiSetup(db, env, request) {
  if (!env.BOOTSTRAP_TOKEN) return json({ error: "bootstrap_disabled" }, 403);
  let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (String(d.token || "") !== env.BOOTSTRAP_TOKEN) return json({ error: "bad_token" }, 401);
  for (const sql of SCHEMA) await db.prepare(sql).run();
  const n = await db.prepare("SELECT COUNT(*) n FROM users").first();
  if (n && n.n > 0) return json({ error: "already_initialized" }, 409);
  const st = db.prepare("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO NOTHING");
  await db.batch(DEFAULT_SETTINGS.map(([k, v]) => st.bind(k, v)));
  const us = db.prepare(`INSERT INTO users (email,name,student_id,role,pw_salt,pw_hash,seed,active,created_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8)`);
  await db.batch(SEED_USERS.map((u) => us.bind(u.email, u.name, u.student_id || "", u.role, u.pw_salt, u.pw_hash, u.seed, nowIso())));
  return json({ ok: true, users: SEED_USERS.length });
}

// ---------- 集計（モニタリング用） ----------
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const parseAnswers = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };

async function apiProgress(db, track) {
  const items = scoreItems(track), textItems = TRACKS[track].items.filter((i) => i.type === "text");
  const rows = ((await db.prepare(
    `SELECT r.rater_email,r.position,r.work_id,r.elapsed_ms,r.answers,u.name AS rater_name
       FROM responses r LEFT JOIN users u ON u.email=r.rater_email WHERE r.track=?1`).bind(track).all()).results || [])
    .map((r) => ({ ...r, a: parseAnswers(r.answers) }));
  const works = (await db.prepare(
    `SELECT w.id,w.owner_email,w.title,w.url,w.file_name,w.active,u.name AS owner_name,u.student_id,
            (SELECT COUNT(*) FROM tasks t WHERE t.work_id=w.id) AS n_assigned
       FROM works w LEFT JOIN users u ON u.email=w.owner_email WHERE w.track=?1 ORDER BY w.id`).bind(track).all()).results || [];
  const total = (a) => items.reduce((s, it) => s + (Number(a[it.id]) || 0), 0);

  const byWork = {};
  for (const r of rows) (byWork[r.work_id] = byWork[r.work_id] || []).push(r);
  const workRows = works.map((w) => {
    const rs = byWork[w.id] || [], tot = rs.map((r) => total(r.a));
    const per = {};
    for (const it of items) per[it.id] = r2(mean(rs.map((r) => Number(r.a[it.id]) || 0)));
    return { id: w.id, owner_email: w.owner_email, owner_name: w.owner_name, student_id: w.student_id,
      title: w.title, url: w.url, file_name: w.file_name, active: w.active, n_assigned: w.n_assigned, n: rs.length,
      per, total: r2(mean(tot)), total_sd: r2(sd(tot)),
      total_pct: rs.length ? Math.round((100 * mean(tot)) / trackMax(track)) : null,
      comments: rs.map((r) => ({ rater: r.rater_name || r.rater_email,
        ...Object.fromEntries(textItems.map((it) => [it.id, String(r.a[it.id] || "")])) })) };
  });

  const byRater = {};
  for (const r of rows) (byRater[r.rater_email] = byRater[r.rater_email] || { name: r.rater_name, rs: [] }).rs.push(r);
  const raters = Object.entries(byRater).map(([email, { name, rs }]) => {
    const tot = rs.map((r) => total(r.a));
    const ms = rs.map((r) => r.elapsed_ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return { email, name, n: rs.length, total: r2(mean(tot)), total_sd: r2(sd(tot)),
      median_ms: ms.length ? ms[Math.floor(ms.length / 2)] : null,
      fast_rate: ms.length ? r2(ms.filter((x) => x < 10000).length / ms.length) : null };
  }).sort((a, b) => (b.total || 0) - (a.total || 0));

  const usage = items.map((it) => {
    const counts = Array.from({ length: itemMax(it) + 1 }, () => 0);
    for (const r of rows) { const v = Number(r.a[it.id]); if (Number.isInteger(v) && counts[v] != null) counts[v]++; }
    const n = counts.reduce((a, b) => a + b, 0) || 1;
    return { id: it.id, name: it.name, name_ja: it.name_ja, counts, rates: counts.map((c) => r2(c / n)) };
  });

  return json({ track, max: trackMax(track), items: items.map((i) => ({ id: i.id, name: i.name, name_ja: i.name_ja, max: itemMax(i) })),
    text_items: textItems.map((i) => ({ id: i.id, name: i.name })), n_responses: rows.length, works: workRows, raters, usage });
}

function csvCell(v) { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function csvResponse(cols, rows, filename) {
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return text("\uFEFF" + lines.join("\n"), 200, {
    "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"` });
}

// ---------- 提出（自分の作品） ----------
async function apiSubmitWork(db, user, request, isAdmin) {
  let form; try { form = await request.formData(); } catch { return json({ error: "bad_form" }, 400); }
  const track = trackOf(String(form.get("track") || ""));
  if (!track) return json({ error: "bad_track" }, 400);
  if (!isAdmin && (await setting(db, `${track}_submit`, "1")) !== "1") return json({ error: "submit_closed" }, 403);
  // 管理者は owner を指定して代理提出できる
  let owner = user.email;
  if (isAdmin && form.get("owner_email")) {
    owner = String(form.get("owner_email")).trim().toLowerCase();
    const o = await db.prepare("SELECT email FROM users WHERE email=?1").bind(owner).first();
    if (!o) return json({ error: "owner_not_found" }, 404);
  }
  const title = String(form.get("title") || "").trim().slice(0, 500);  // 課題1ではプロンプト欄として使う
  const note = String(form.get("note") || "").trim().slice(0, 2000);
  const url = String(form.get("url") || "").trim();
  if (url && !isHttpUrl(url)) return json({ error: "bad_url" }, 400);

  let blob = null, ftype = "", fname = "", fsize = 0;
  const f = form.get("file");
  if (f && typeof f === "object" && typeof f.arrayBuffer === "function" && f.size > 0) {
    if (track !== "image") return json({ error: "file_not_allowed" }, 400);
    if (f.size > MAX_FILE) return json({ error: "file_too_large", max: MAX_FILE }, 400);
    ftype = fileTypeOf(f.name);
    if (!ftype) return json({ error: "bad_file_type" }, 400);
    blob = await f.arrayBuffer(); fname = String(f.name).slice(0, 120); fsize = f.size;
  }
  const existing = await db.prepare("SELECT id,file_size,url FROM works WHERE track=?1 AND owner_email=?2").bind(track, owner).first();
  if (track === "video" && !url && !(existing && existing.url)) return json({ error: "url_required" }, 400);
  if (!blob && !url && !(existing && (existing.file_size || existing.url))) return json({ error: "nothing_to_submit" }, 400);

  const now = nowIso();
  if (existing) {
    if (blob) {
      await db.prepare(`UPDATE works SET title=?2,url=?3,embed_url=?4,note=?5,file_blob=?6,file_type=?7,file_name=?8,file_size=?9,updated_at=?10 WHERE id=?1`)
        .bind(existing.id, title, url, toEmbed(url), note, blob, ftype, fname, fsize, now).run();
    } else {
      await db.prepare(`UPDATE works SET title=?2,url=?3,embed_url=?4,note=?5,updated_at=?6 WHERE id=?1`)
        .bind(existing.id, title, url, toEmbed(url), note, now).run();
    }
    return json({ ok: true, id: existing.id, updated: true });
  }
  const n = await db.prepare("SELECT COUNT(*) n FROM works WHERE track=?1").bind(track).first();
  let id = "", tries = 0;
  for (;;) {
    id = TRACKS[track].prefix + String((n ? n.n : 0) + 1 + tries).padStart(3, "0");
    const dup = await db.prepare("SELECT id FROM works WHERE id=?1").bind(id).first();
    if (!dup) break;
    if (++tries > 500) return json({ error: "id_exhausted" }, 500);
  }
  await db.prepare(`INSERT INTO works (id,track,owner_email,title,url,embed_url,file_blob,file_type,file_name,file_size,note,active,created_at,updated_at)
                    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12,?12)`)
    .bind(id, track, owner, title, url, toEmbed(url), blob, ftype, fname, fsize, note, now).run();
  return json({ ok: true, id, updated: false });
}

const workPublic = (w) => ({ id: w.id, track: w.track, title: w.title, url: w.url, embed_url: w.embed_url,
  file_type: w.file_type, file_name: w.file_name, file_size: w.file_size, note: w.note, active: w.active,
  has_file: !!w.file_size, is_html: isHtmlType(w.file_type), updated_at: w.updated_at });

// ---------- API ----------
async function handleApi(url, request, env, db) {
  const pathname = url.pathname, m = request.method;

  if (pathname === "/api/items" && m === "GET") {
    const t = trackOf(url.searchParams.get("track") || "");
    if (t) return json({ version: ITEMS_VERSION, track: t, label: TRACKS[t].label, items: TRACKS[t].items, layer_label: TRACKS[t].layer_label });
    return json({ version: ITEMS_VERSION, tracks: Object.fromEntries(TRACK_IDS.map((k) => [k,
      { label: TRACKS[k].label, label_ja: TRACKS[k].label_ja, items: TRACKS[k].items, layer_label: TRACKS[k].layer_label,
        submit: TRACKS[k].submit, accept: TRACKS[k].accept }])) });
  }
  if (pathname === "/api/bootstrap/status" && m === "GET") return await apiSetupStatus(db, env);
  if (pathname === "/api/bootstrap" && m === "POST") return await apiSetup(db, env, request);

  if (pathname === "/api/register" && (m === "POST" || m === "GET")) {
    if (!(await tablesExist(db))) return json({ error: "not_initialized" }, 503);
    const s = await allSettings(db);
    if (m === "GET") return json({ open: s.register_open === "1", code_required: !!s.register_code, notice: s.notice });
    if (s.register_open !== "1") return json({ error: "register_closed" }, 403);
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (s.register_code && String(d.code || "").trim() !== s.register_code) return json({ error: "bad_code" }, 403);
    const email = String(d.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "bad_email" }, 400);
    const name = String(d.name || "").trim().slice(0, 80);
    if (!name) return json({ error: "name_required" }, 400);
    const sid = String(d.student_id || "").trim().slice(0, 40);
    const pw = String(d.password || "");
    if (pw.length < 8) return json({ error: "weak_password" }, 400);
    const exists = await db.prepare("SELECT email FROM users WHERE email=?1").bind(email).first();
    if (exists) return json({ error: "exists" }, 409);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await db.prepare(`INSERT INTO users (email,name,student_id,role,pw_salt,pw_hash,seed,active,created_at)
                      VALUES (?1,?2,?3,'student',?4,?5,?6,1,?7)`)
      .bind(email, name, sid, salt, await pwHash(pw, salt), crypto.getRandomValues(new Uint32Array(1))[0], nowIso()).run();
    return json({ ok: true, role: "student" }, 200,
      { "set-cookie": cookieHeader(encodeURIComponent(await makeToken(env, email)), SESSION_DAYS * 86400) });
  }

  if (pathname === "/api/login" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const email = String(d.email || "").trim().toLowerCase();
    if (!(await tablesExist(db))) return json({ error: "not_initialized" }, 503);
    const row = await db.prepare("SELECT * FROM users WHERE email=?1").bind(email).first();
    if (!row || !row.active) return json({ error: "invalid" }, 401);
    if ((await pwHash(String(d.password || ""), row.pw_salt)) !== row.pw_hash) return json({ error: "invalid" }, 401);
    return json({ ok: true, role: row.role }, 200,
      { "set-cookie": cookieHeader(encodeURIComponent(await makeToken(env, email)), SESSION_DAYS * 86400) });
  }
  if (pathname === "/api/logout" && m === "POST")
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });

  const user = await getUser(db, env, request);
  if (!user) return json({ error: "unauthorized" }, 401);
  const isAdmin = user.role === "admin";

  if (pathname === "/api/me" && m === "GET")
    return json({ email: user.email, name: user.name, student_id: user.student_id, role: user.role });

  if (pathname === "/api/password" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const row = await db.prepare("SELECT pw_salt,pw_hash FROM users WHERE email=?1").bind(user.email).first();
    if ((await pwHash(String(d.current || ""), row.pw_salt)) !== row.pw_hash) return json({ error: "invalid" }, 401);
    if (String(d.password || "").length < 8) return json({ error: "weak_password" }, 400);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await db.prepare("UPDATE users SET pw_salt=?2,pw_hash=?3 WHERE email=?1").bind(user.email, salt, await pwHash(String(d.password), salt)).run();
    return json({ ok: true });
  }

  // 学生の画面用: 自分の提出物と、各課題の評価の進捗
  if (pathname === "/api/dashboard" && m === "GET") {
    const s = await allSettings(db);
    const works = (await db.prepare("SELECT id,track,title,url,embed_url,file_type,file_name,file_size,note,active,updated_at FROM works WHERE owner_email=?1")
      .bind(user.email).all()).results || [];
    const out = {};
    for (const t of TRACK_IDS) {
      const w = works.find((x) => x.track === t);
      const nt = await db.prepare("SELECT COUNT(*) n FROM tasks WHERE rater_email=?1 AND track=?2").bind(user.email, t).first();
      const nd = await db.prepare("SELECT COUNT(*) n FROM responses WHERE rater_email=?1 AND track=?2").bind(user.email, t).first();
      const avail = await db.prepare("SELECT COUNT(*) n FROM works WHERE track=?1 AND active=1 AND owner_email<>?2").bind(t, user.email).first();
      out[t] = { label: TRACKS[t].label, submit_open: s[`${t}_submit`] === "1", eval_open: s[`${t}_eval`] === "1",
        results_open: s[`${t}_results`] === "1",
        k: Number(s[`${t}_k`]) || 0, work: w ? workPublic(w) : null,
        n_tasks: nt ? nt.n : 0, n_done: nd ? nd.n : 0, n_available: avail ? avail.n : 0 };
    }
    return json({ name: user.name || user.email, notice: s.notice, tracks: out });
  }

  if (pathname === "/api/work" && m === "POST") return await apiSubmitWork(db, user, request, isAdmin);

  // 自分の作品が受けた評価。管理者が「結果公開」にした課題だけ。評価者名は出さない。
  if (pathname === "/api/results" && m === "GET") {
    const track = trackOf(url.searchParams.get("track") || "");
    if (!track) return json({ error: "bad_track" }, 400);
    if ((await setting(db, `${track}_results`, "0")) !== "1") return json({ error: "results_closed" }, 403);
    const w = await db.prepare("SELECT id,title FROM works WHERE track=?1 AND owner_email=?2").bind(track, user.email).first();
    if (!w) return json({ track, work: null, n: 0 });
    const rows = ((await db.prepare("SELECT answers FROM responses WHERE work_id=?1 ORDER BY updated_at").bind(w.id).all()).results || [])
      .map((r) => parseAnswers(r.answers));
    const items = scoreItems(track), textItems = TRACKS[track].items.filter((i) => i.type === "text");
    const per = items.map((it) => ({ id: it.id, name: it.name, max: itemMax(it),
      mean: r2(mean(rows.map((a) => Number(a[it.id]) || 0))) }));
    const tot = rows.map((a) => items.reduce((x, it) => x + (Number(a[it.id]) || 0), 0));
    const comments = textItems.map((it) => ({ id: it.id, name: it.name,
      texts: rows.map((a) => String(a[it.id] || "").trim()).filter(Boolean) }));
    return json({ track, work: { id: w.id, title: w.title }, n: rows.length, per, total: r2(mean(tot)), max: trackMax(track), comments });
  }

  // 作品ファイルの配信。閲覧できるのは 管理者 / 提出者本人 / その作品を割り当てられた評価者。
  // HTML は sandbox 付き CSP で返し、アプリのオリジン権限を持たせない（学生の HTML は信用しない）。
  let fm = pathname.match(/^\/api\/work\/([\w-]+)\/file$/);
  if (fm && m === "GET") {
    const id = fm[1];
    const w = await db.prepare("SELECT id,owner_email,file_blob,file_type,file_name,file_size FROM works WHERE id=?1").bind(id).first();
    if (!w || !w.file_size) return json({ error: "not_found" }, 404);
    if (!isAdmin && w.owner_email !== user.email) {
      const t = await db.prepare("SELECT 1 x FROM tasks WHERE rater_email=?1 AND work_id=?2").bind(user.email, id).first();
      if (!t) return json({ error: "forbidden" }, 403);
    }
    // D1 は BLOB を number[] で返す（ArrayBuffer ではない）。そのまま Response に渡すと
    // "137,80,78,..." という文字列になり、画像も HTML も壊れる。必ずバイト列に戻す。
    return new Response(toBytes(w.file_blob), { status: 200, headers: {
      "content-type": w.file_type || "application/octet-stream",
      "content-security-policy": "sandbox allow-scripts; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'",
      "x-content-type-options": "nosniff", "cache-control": "private, max-age=300",
      "content-disposition": `inline; filename="${String(w.file_name || id).replace(/[^\w.\-]/g, "_")}"` } });
  }

  if (pathname === "/api/tasks" && m === "GET") {
    const track = trackOf(url.searchParams.get("track") || "");
    if (!track) return json({ error: "bad_track" }, 400);
    const evalOpen = (await setting(db, `${track}_eval`, "1")) === "1";
    if (evalOpen) await ensureTasks(db, user, track);
    const tasks = (await db.prepare(
      `SELECT t.position,t.work_id,w.title,w.url,w.embed_url,w.file_type,w.file_size,w.note,
              (SELECT answers FROM responses r WHERE r.rater_email=t.rater_email AND r.track=t.track AND r.position=t.position) AS answers
         FROM tasks t JOIN works w ON w.id=t.work_id
        WHERE t.rater_email=?1 AND t.track=?2 ORDER BY t.position`).bind(user.email, track).all()).results || [];
    return json({ track, label: TRACKS[track].label, name: user.name || user.email, eval_open: evalOpen,
      tasks: tasks.map((t) => ({ position: t.position, work_id: t.work_id, title: t.title, url: t.url, embed_url: t.embed_url,
        has_file: !!t.file_size, is_html: isHtmlType(t.file_type), note: t.note, done: !!t.answers,
        answers: t.answers ? parseAnswers(t.answers) : null })) });
  }

  if (pathname === "/api/response" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const track = trackOf(String(d.track || ""));
    if (!track) return json({ error: "bad_track" }, 400);
    if ((await setting(db, `${track}_eval`, "1")) !== "1") return json({ error: "closed" }, 403);
    const pos = Number(d.position);
    const t = await db.prepare("SELECT work_id FROM tasks WHERE rater_email=?1 AND track=?2 AND position=?3").bind(user.email, track, pos).first();
    if (!t) return json({ error: "no_task" }, 404);
    const a = d.answers && typeof d.answers === "object" ? d.answers : d;
    const answers = {};
    for (const it of TRACKS[track].items) {
      if (it.type === "text") {
        const s = String(a[it.id] || "").trim().slice(0, 2000), wc = wordCount(s);
        if (wc < (it.min_words || 1)) return json({ error: "too_short:" + it.id, words: wc, min: it.min_words }, 400);
        if (wc > (it.max_words || 200)) return json({ error: "too_long:" + it.id, words: wc, max: it.max_words }, 400);
        answers[it.id] = s;
      } else {
        const n = Number(a[it.id]);
        if (!Number.isInteger(n) || n < 0 || n > itemMax(it)) return json({ error: "range:" + it.id }, 400);
        answers[it.id] = n;
      }
    }
    const ms = Number.isFinite(Number(d.elapsed_ms)) ? Math.round(Number(d.elapsed_ms)) : null;
    const now = nowIso();
    await db.prepare(
      `INSERT INTO responses (rater_email,track,position,work_id,answers,elapsed_ms,items_version,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)
       ON CONFLICT(rater_email,track,position) DO UPDATE SET answers=?5,elapsed_ms=?6,items_version=?7,updated_at=?8`
    ).bind(user.email, track, pos, t.work_id, JSON.stringify(answers), ms, ITEMS_VERSION, now).run();
    return json({ ok: true });
  }

  if (!pathname.startsWith("/api/admin/")) return json({ error: "not_found" }, 404);
  if (!isAdmin) return json({ error: "forbidden" }, 403);

  if (pathname === "/api/admin/users" && m === "GET")
    return json({ users: (await db.prepare(
      `SELECT u.email,u.name,u.student_id,u.role,u.active,u.created_at,
              (SELECT COUNT(*) FROM works w WHERE w.owner_email=u.email AND w.track='image') AS has_image,
              (SELECT COUNT(*) FROM works w WHERE w.owner_email=u.email AND w.track='video') AS has_video,
              (SELECT COUNT(*) FROM tasks t WHERE t.rater_email=u.email AND t.track='image') AS image_tasks,
              (SELECT COUNT(*) FROM responses r WHERE r.rater_email=u.email AND r.track='image') AS image_done,
              (SELECT COUNT(*) FROM tasks t WHERE t.rater_email=u.email AND t.track='video') AS video_tasks,
              (SELECT COUNT(*) FROM responses r WHERE r.rater_email=u.email AND r.track='video') AS video_done
         FROM users u ORDER BY u.role DESC, u.student_id, u.email`).all()).results || [] });

  if (pathname === "/api/admin/user" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const email = String(d.email || "").trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "bad_email" }, 400);
    const exists = await db.prepare("SELECT * FROM users WHERE email=?1").bind(email).first();
    const role = d.role === "admin" ? "admin" : d.role === "student" ? "student" : exists ? exists.role : "student";
    const active = d.active === undefined ? (exists ? exists.active : 1) : d.active === 0 || d.active === false ? 0 : 1;
    if (email === user.email && (role !== "admin" || active === 0)) return json({ error: "self_lockout" }, 400);
    const name = d.name === undefined ? (exists ? exists.name : "") : String(d.name || "");
    const sid = d.student_id === undefined ? (exists ? exists.student_id : "") : String(d.student_id || "");
    if (!exists) {
      const pw = String(d.password || "");
      if (pw.length < 8) return json({ error: "weak_password" }, 400);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await db.prepare(`INSERT INTO users (email,name,student_id,role,pw_salt,pw_hash,seed,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
        .bind(email, name, sid, role, salt, await pwHash(pw, salt), crypto.getRandomValues(new Uint32Array(1))[0], active, nowIso()).run();
    } else {
      await db.prepare("UPDATE users SET name=?2,student_id=?3,role=?4,active=?5 WHERE email=?1").bind(email, name, sid, role, active).run();
      if (d.password) {
        if (String(d.password).length < 8) return json({ error: "weak_password" }, 400);
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        await db.prepare("UPDATE users SET pw_salt=?2,pw_hash=?3 WHERE email=?1").bind(email, salt, await pwHash(String(d.password), salt)).run();
      }
    }
    return json({ ok: true });
  }

  // 割当のやり直し（回答済みなら確認を求める）
  if (pathname === "/api/admin/rebuild" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const email = String(d.email || "").toLowerCase(), track = trackOf(String(d.track || ""));
    if (!track) return json({ error: "bad_track" }, 400);
    const r = await db.prepare("SELECT email,seed FROM users WHERE email=?1").bind(email).first();
    if (!r) return json({ error: "not_found" }, 404);
    const done = await db.prepare("SELECT COUNT(*) n FROM responses WHERE rater_email=?1 AND track=?2").bind(email, track).first();
    if (done && done.n > 0 && !d.force) return json({ error: "has_responses", n: done.n }, 409);
    await db.prepare("DELETE FROM responses WHERE rater_email=?1 AND track=?2").bind(email, track).run();
    await db.prepare("DELETE FROM tasks WHERE rater_email=?1 AND track=?2").bind(email, track).run();
    return json({ ok: true, n: await ensureTasks(db, r, track) });
  }

  if (pathname === "/api/admin/works" && m === "GET") {
    const track = trackOf(url.searchParams.get("track") || "");
    const rows = (await db.prepare(
      `SELECT w.id,w.track,w.owner_email,w.title,w.url,w.embed_url,w.file_type,w.file_name,w.file_size,w.note,w.active,w.created_at,w.updated_at,
              u.name AS owner_name,u.student_id,
              (SELECT COUNT(*) FROM tasks t WHERE t.work_id=w.id) AS n_assigned,
              (SELECT COUNT(*) FROM responses r WHERE r.work_id=w.id) AS n_done
         FROM works w LEFT JOIN users u ON u.email=w.owner_email
        ${track ? "WHERE w.track=?1" : ""} ORDER BY w.track,w.id`).bind(...(track ? [track] : [])).all()).results || [];
    return json({ works: rows.map((w) => ({ ...workPublic(w), owner_email: w.owner_email, owner_name: w.owner_name,
      student_id: w.student_id, n_assigned: w.n_assigned, n_done: w.n_done, created_at: w.created_at })) });
  }

  if (pathname === "/api/admin/work" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!d.id) return json({ error: "missing:id" }, 400);
    if (d.delete) {
      await db.prepare("DELETE FROM responses WHERE work_id=?1").bind(String(d.id)).run();
      await db.prepare("DELETE FROM tasks WHERE work_id=?1").bind(String(d.id)).run();
      await db.prepare("DELETE FROM works WHERE id=?1").bind(String(d.id)).run();
      return json({ ok: true, deleted: true });
    }
    await db.prepare("UPDATE works SET active=?2 WHERE id=?1").bind(String(d.id), d.active ? 1 : 0).run();
    return json({ ok: true });
  }

  if (pathname === "/api/admin/settings") {
    if (m === "GET") return json({ settings: await allSettings(db) });
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const allowed = new Set(DEFAULT_SETTINGS.map(([k]) => k));
    for (const [k, v] of Object.entries(d)) {
      if (!allowed.has(k)) continue;
      await db.prepare("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2").bind(k, String(v)).run();
    }
    return json({ ok: true });
  }

  if (pathname === "/api/admin/progress" && m === "GET") {
    const track = trackOf(url.searchParams.get("track") || "");
    if (!track) return json({ error: "bad_track" }, 400);
    return await apiProgress(db, track);
  }

  // 回答CSV: 1行 = 評価者 × 作品
  if (pathname === "/api/admin/export.csv" && m === "GET") {
    const track = trackOf(url.searchParams.get("track") || "");
    if (!track) return json({ error: "bad_track" }, 400);
    const ids = TRACKS[track].items.map((i) => i.id);
    const rows = ((await db.prepare(
      `SELECT r.rater_email,ru.name AS rater_name,ru.student_id AS rater_student_id,r.position,r.work_id,
              w.owner_email,ou.student_id AS owner_student_id,ou.name AS owner_name,
              r.answers,r.elapsed_ms,r.items_version,r.updated_at
         FROM responses r
         LEFT JOIN users ru ON ru.email=r.rater_email
         LEFT JOIN works w ON w.id=r.work_id
         LEFT JOIN users ou ON ou.email=w.owner_email
        WHERE r.track=?1 ORDER BY r.rater_email,r.position`).bind(track).all()).results || [])
      .map((r) => ({ ...r, ...parseAnswers(r.answers) }));
    return csvResponse(["rater_email", "rater_name", "rater_student_id", "position", "work_id",
      "owner_email", "owner_student_id", "owner_name", ...ids, "elapsed_ms", "items_version", "updated_at"], rows, `${track}_responses.csv`);
  }

  // 作品ごとの集計CSV（成績処理用）
  if (pathname === "/api/admin/summary.csv" && m === "GET") {
    const track = trackOf(url.searchParams.get("track") || "");
    if (!track) return json({ error: "bad_track" }, 400);
    const p = await (await apiProgress(db, track)).json();
    const ids = p.items.map((i) => i.id);
    const rows = p.works.map((w) => ({ work_id: w.id, owner_email: w.owner_email, owner_student_id: w.student_id, owner_name: w.owner_name,
      title: w.title, active: w.active, n_assigned: w.n_assigned, n_responses: w.n,
      ...Object.fromEntries(ids.map((k) => ["mean_" + k, w.per[k]])),
      mean_total: w.total, sd_total: w.total_sd, pct: w.total_pct, max_total: p.max }));
    return csvResponse(["work_id", "owner_email", "owner_student_id", "owner_name", "title", "active", "n_assigned", "n_responses",
      ...ids.map((k) => "mean_" + k), "mean_total", "sd_total", "pct", "max_total"], rows, `${track}_summary.csv`);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!env.DB) return json({ error: "no_db", detail: "D1 バインディング DB が未設定です" }, 500);
      try {
        return await handleApi(url, request, env, env.DB);
      } catch (e) {
        return json({ error: "server", detail: String(e) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
