# 習慣トラッカー

SQLite 1 ファイルで動く、個人用の習慣トラッカー。

- 仕様と受け入れ基準: [`docs/phases.md`](docs/phases.md)
- 設計の背景: [`docs/design.md`](docs/design.md)

## 必要環境

- Node.js 22.18 以上（`node:sqlite` と TypeScript 型ストリッピングを使うため）

## セットアップ

```bash
npm install
cp .env.example .env   # 既定値のままでも動く
```

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
```

サーバーが `client/dist` を静的配信するので、http://localhost:3001 だけで動きます。

## 検査

```bash
npm test          # server の node:test 単体テスト
npx tsc --noEmit  # 型チェック（client / server 双方）
npm run e2e       # Playwright E2E（本番ビルドに対して実行）
```

## 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `PORT` | `3001` | API サーバーの待ち受けポート |
| `DB_PATH` | `data/habits.db` | SQLite ファイルのパス（相対はカレントディレクトリ基準） |
