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

## HTTPS の後ろに置くとき

TLS を終端するリバースプロキシ（nginx / Caddy など）を前に置く場合は、
プロキシが `X-Forwarded-Proto: https` を付けていれば設定は不要です。付けない
プロキシなら `COOKIE_SECURE=true` を指定してください。逆に、社内 LAN で
http のまま使う場合も設定は不要です（`Secure` は付きません）。
