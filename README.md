# 習慣トラッカー

SQLite 1 ファイルで動く、個人用の習慣トラッカー。

- 仕様と受け入れ基準: [`docs/phases.md`](docs/phases.md)
- 設計の背景: [`docs/design.md`](docs/design.md)

## 必要環境

- Node.js 22.18 以上（`node:sqlite` と TypeScript 型ストリッピングを使うため）
  - `node --version` で確認。これ未満では起動しません
- それ以外は不要です（DB サーバーも Docker も要りません。SQLite ファイル 1 個で動きます）

## セットアップ

クリーンな clone から、この 4 コマンドで動きます。

```bash
npm install
cp .env.example .env      # ADMIN_USER / ADMIN_PASSWORD を自分の値に書き換える
npm run seed-user         # .env の資格情報でユーザーを作成（既にいればパスワード更新）
npm run dev               # http://localhost:5173 を開く
```

`npm install` は Playwright のブラウザまでは入れません。E2E を動かすときだけ
`npx playwright install chromium` を実行してください（アプリの起動には不要です）。

DB ファイル（既定 `data/habits.db`）とその親ディレクトリは初回起動時に自動で作られます。
`seed-user` を先に実行すればその時点で作られます。

ユーザー登録画面はありません。ログインできるユーザーは `npm run seed-user` が作ります。
パスワードは scrypt でハッシュ化して保存され、平文は DB に残りません。

## 開発

```bash
npm run dev
```

- クライアント: http://localhost:5173 （Vite。`/api` は API サーバーへ proxy）
- API: http://localhost:3001 （`GET /api/health` で疎通確認）

## 本番相当の起動

```bash
npm run build                                        # client/dist を生成
node --disable-warning=ExperimentalWarning server/src/index.ts
# または npm start（.env を読み込む）
```

サーバーが `client/dist` を静的配信するので、http://localhost:3001 だけで動きます
（Vite は不要）。`--disable-warning` は `node:sqlite` の ExperimentalWarning を
黙らせるだけで、付けなくても動きます。

## 検査

```bash
npm test          # node:test 単体テスト（server / shared / client の純粋ロジック）
npm run typecheck # 型チェック（ルート / server / client）
npm run e2e       # Playwright E2E（本番ビルドに対して実行）
```

`npm run e2e` は初回のみ `npx playwright install chromium` が必要です。E2E は
`.harness/tmp/e2e.db` を毎回作り直すので、開発用の DB には触りません。

## 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `ADMIN_USER` | （必須） | `npm run seed-user` が作成するユーザー名 |
| `ADMIN_PASSWORD` | （必須） | 同上のパスワード。scrypt でハッシュ化して保存される |
| `PORT` | `3001` | API サーバーの待ち受けポート |
| `DB_PATH` | `data/habits.db` | SQLite ファイルのパス（相対はカレントディレクトリ基準）。親ディレクトリは自動作成 |
| `COOKIE_SECURE` | `auto` | セッション Cookie の `Secure`。`auto` はリクエストのスキーム（`X-Forwarded-Proto` 優先）で判断。`true` / `false` で固定 |
| `API_PORT` | `PORT` → `3001` | 開発時のみ。Vite dev サーバーが `/api` を proxy する先 |

必須の 2 つ以外は未設定でも動きます。`.env.example` に同じ一覧と補足があります。

`npm run dev` / `npm start` / `npm run seed-user` は `.env` があれば読み込みます
（`node --env-file-if-exists`）。実行時の環境変数のほうが `.env` より優先されます。

`NODE_ENV` はサーバーのコードからは読んでいません。Cookie の `Secure` は
`COOKIE_SECURE` とリクエストのスキームだけで決まります — `NODE_ENV=production` の
まま http で配信して Cookie が保存されない、という壊れ方を避けるためです。

## デプロイ（Fly.io）

`Dockerfile` と `fly.toml` が入っています。ローカルに Docker は不要です
（`fly deploy` がリモートビルダーでイメージを作ります）。

### なぜ Fly なのか

このアプリの状態は SQLite ファイル 1 個だけなので、**永続ディスクを持てて、
インスタンスを 1 台に固定できる**実行環境が要ります。Vercel や Cloudflare
Workers のようにファイルシステムが揮発する環境では動きません。Fly はボリュームを
無料枠込みで付けられ、アイドル時にマシンを止められるので、個人用の常時ほぼ無操作な
アプリには向いています。

### ⚠ マシンは 1 台から増やさない

Fly ではマシンごとに別のボリュームが割り当てられます。2 台に増やすと**それぞれが
別の空のデータベースを持ち**、リクエストはプロキシが選んだほうに届きます。習慣が
出たり消えたりするのに、どこにもエラーは出ません。`fly scale count 2` は実行しないで
ください。性能が足りなければ台数ではなくマシンのサイズを上げます。

### 手順

```bash
# 1. flyctl を入れて、ログインする
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. アプリとボリュームを作る（fly.toml の app 名が使われていれば書き換える）
fly apps create habit-tracker
fly volumes create habit_data --region nrt --size 1

# 3. 資格情報を渡す。fly.toml ではなく secrets に入れる（fly.toml は公開リポジトリに入る）
fly secrets set ADMIN_USER=あなたのユーザー名 ADMIN_PASSWORD='十分に長いパスワード'

# 4. デプロイ
fly deploy

# 5. 初回だけ、ボリューム上の DB にユーザーを作る
fly ssh console -C "node --disable-warning=ExperimentalWarning /app/server/scripts/seed-user.ts"

fly open
```

パスワードを変えるときは `fly secrets set ADMIN_PASSWORD=...` のあとに手順 5 を
もう一度実行します。`seed-user` は既存ユーザーならパスワードを更新し、**古い
セッションを全て無効化します**。

`COOKIE_SECURE` は設定しないでください。`fly.toml` の `force_https` により
プロキシが `X-Forwarded-Proto: https` を付けるので、既定の `auto` が正しく
`Secure` を付けます。

### バックアップ

DB はボリューム上の 1 ファイルなので、コピーするだけで完全なバックアップになります。
**ただし `cp habits.db` はバックアップになりません。** WAL モードで動いているため
直近の書き込みは `-wal` サイドカーにあり、本体だけコピーすると黙って失われます。
`npm run backup` は `VACUUM INTO` で、稼働中のまま単体で整合するスナップショットを
作ります。

```bash
fly ssh console -C "node --disable-warning=ExperimentalWarning /app/server/scripts/backup.ts /data/backup.db"
fly sftp get /data/backup.db ./habits-backup-$(date +%F).db
fly ssh console -C "rm /data/backup.db"
```

取り出したファイルは単体で開けます。中身の確認はローカルで
`DB_PATH=./habits-backup-2026-07-29.db npm start` でも、`sqlite3` でも構いません。

ローカルの開発 DB も同じコマンドで取れます。

```bash
npm run backup                    # data/backup-YYYY-MM-DD.db
npm run backup -- /path/to/x.db   # 出力先を指定
```

Fly のボリュームには自動スナップショット（既定 5 日保持）もありますが、これは
ボリューム単位の復旧手段であって、手元にファイルを持っておくことの代わりには
なりません。

### 他の PaaS に載せる場合

`Dockerfile` は Fly 固有の記述を含んでいないので、Render や Railway でもそのまま
使えます。必要なのは同じ 2 点だけです。

- `/data` に永続ディスクをマウントし、`DB_PATH=/data/habits.db` を設定する
- インスタンスを 1 台に固定する

Render は永続ディスクを付けると無料枠から外れ、最低でも有料の Starter プランが
必要になります。

## HTTPS の後ろに置くとき

TLS を終端するリバースプロキシ（nginx / Caddy など）を前に置く場合は、
プロキシが `X-Forwarded-Proto: https` を付けていれば設定は不要です。付けない
プロキシなら `COOKIE_SECURE=true` を指定してください。逆に、社内 LAN で
http のまま使う場合も設定は不要です（`Secure` は付きません）。
