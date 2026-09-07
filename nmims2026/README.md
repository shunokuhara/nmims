# 相互評価アプリ（NMIMS 2026 / Agentic AI）

集中講義「Agentic AI」（NMIMS、2026年9月）の2つの課題を、受講生同士で相互評価するためのアプリ。
awec2026（videoeval）から派生。Cloudflare Workers + D1。**別の Worker・別の D1** で動かすので、
北九州の実験データには触れない。

| 課題 | 中身 | 評価項目 |
|---|---|---|
| 課題1 image | 演習1：大阪・新世界の街（shinsekai_remix.html）をムンバイ／自分のテーマに作り変えたもの | 4項目（各0-3）＋自由記述2問（各10-30語） |
| 課題2 video | 最終課題の動画 | videoeval の Q1-Q8 をそのまま。「北九州市」→「Mumbai」 |

```
/            ログイン（英語）
/register/   学生の自己登録（英語）
/setup/      初期化（1回だけ。スキーマ作成と管理者投入）
/student/    学生の画面：提出、評価の進捗（英語）
/evaluate/   評価画面（?track=image | video）（英語）
/admin/      管理画面（日本語）
```

学生向け画面は英語、管理画面は日本語。

## 立ち上げ（ダッシュボードだけで完結する）

1. **D1 を作る** … Storage & Databases → D1 → Create。名前は `peereval`。
   表示された Database ID を `wrangler.jsonc` の `REPLACE_WITH_D1_ID` に貼って commit。
2. **Worker を作る** … Workers & Pages → Create → Import a repository → このリポジトリ。
   以後は push で自動デプロイ。
3. **シークレット** … Worker の Settings → Variables and Secrets に2つ。

   | 名前 | 値 |
   |---|---|
   | `SESSION_SECRET` | Cookie の署名鍵。長いランダム文字列 |
   | `BOOTSTRAP_TOKEN` | `/setup/` で使う合言葉。初期化が済んだら削除してよい |

4. **初期化** … `https://nmims2026.<アカウント名>.workers.dev/setup/` を開き、`BOOTSTRAP_TOKEN` を入力。
   テーブルが作られ、管理者1名（shunokuhara@icloud.com、パスワードは videoeval と同じ）が入る。
5. **登録コード（任意）** … 管理画面の設定で「登録コード」を入れると、知らない人が登録できなくなる。
   授業で口頭で伝える。空なら誰でも登録できる。
6. 学生に `/register/` の URL を配る。

## 流れ

1. 学生が `/register/` で登録（氏名、学籍番号、メール、パスワード）
2. 学生が `/student/` から提出
   - 課題1: HTML ファイル（1.5MB まで）か PNG/JPG のスクリーンショット。URL は任意
   - 課題2: 共有リンクのみ（Google Drive「リンクを知っている全員」／YouTube／Vimeo は埋め込み再生。OneDrive はリンクのまま）
3. 学生が「Start evaluating」を押すと、その時点で提出済みの他人の作品から **k本**（既定5、設定で変更）が割り当てられる
   - 割当回数が少ない作品を優先するので、作品ごとの被評価数が均される
   - 自分の作品は割り当てられない。作者名は評価者に見せない
   - 提出していない学生も評価はできる
4. 管理画面で進捗と集計を見て、CSV を落とす

**提出締切を待ってから評価を開かせる**のが安全（設定の「評価受付」を停止にしておく）。
早く評価を始めた学生には、その時点で提出済みの作品しか割り当てられない。
後から評価数を増やせば不足分は自動で補充される。

## 評価項目

`worker/index.js` 冒頭の `IMAGE_ITEMS` / `VIDEO_ITEMS` が唯一の出典。画面はここから生成される。
英語（学生向け）と日本語（記録・LLM評価器用）を並記してある。

### 課題1（image）

| | 項目 | 段階 |
|---|---|---|
| i1 | Theme clarity / テーマの伝わりやすさ | 0-3 |
| i2 | Creativity / 創造性 | 0-3 |
| i3 | Visual quality / 視覚的な完成度 | 0-3 |
| i4 | Appeal / 魅力・印象度 | 0-3 |
| i5 | What is the strongest point of this work? Please be specific. | 自由記述 10-30語（サーバは 10-40語で受理） |
| i6 | What could be improved further? Please be specific. | 同上 |

### 課題2（video）

videoeval の Q1-Q8 と同じ構造。q2「Identifiable as Mumbai」、q4/q5 の文言も Mumbai に置換。満点22。

## 学生の HTML を扱う上の注意

課題1の提出物は学生が生成した HTML で、スクリプトを含みうる。
`/api/work/<id>/file` は `Content-Security-Policy: sandbox allow-scripts` を付けて返し、
評価画面では `sandbox="allow-scripts"` の iframe に入れる。オリジンが不透明になるので、
学生の HTML からアプリの Cookie や API には触れない。閲覧できるのは管理者・提出者本人・
その作品を割り当てられた評価者だけ。

## 出力

- `/api/admin/export.csv?track=image|video` … 1行 = 評価者 × 作品。自由記述も列に入る
- `/api/admin/summary.csv?track=image|video` … 作品ごとの平均（成績処理用）

## テスト

```bash
node --experimental-sqlite test/harness.mjs
```

初期化、登録、提出、割当の均等化、ファイル配信の権限、語数チェック、集計、CSV まで通しで検証する。

## バックアップ

```bash
wrangler d1 export peereval --remote --output peereval-$(date +%F).sql
```

## リポジトリの公開範囲

`worker/seed.js` に管理者のパスワードハッシュが入る。**リポジトリは private にすること。**
提出物（学生の HTML）は D1 の中にあり、リポジトリには入らない。
<!-- rebuild -->
