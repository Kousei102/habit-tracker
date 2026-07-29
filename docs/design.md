# 設計メモ

`docs/phases.md` が「何を満たすべきか」なら、こちらは「なぜそう作るか」です。実装で迷ったときの判断基準として使ってください。

> **⚠ Phase 7 でサーバーを廃止しました。**
> 恒久的に無料でホストする要件のため、Node サーバーと SQLite と認証を撤去し、データを
> ブラウザの `localStorage` に移しました。以下のうち **「API」「認証」「データモデル」と
> 「ディレクトリ構成」の節、および環境の前提の SQLite に関する行は、もう実態を表して
> いません**（履歴として残しています）。
>
> **「判断とその理由」の 1〜5 は全て有効なままです。** 保存先が変わっても、日付は常に
> クライアントが決め、達成判定は `isAchieved()` 一箇所で、今日が未達成でも現在ストリーク
> は途切れず、削除は論理削除で、統計は JS の純関数で計算します。
>
> 現在の保存形式:
>
> - `localStorage` のキー `habit-tracker` に JSON 1 件
> - `{ version, next_habit_id, habits: Habit[], entries: { [habitId]: { [YYYY-MM-DD]: number } } }`
> - `entries` を「習慣 → 日付 → 値」の入れ子にしているのは容量のため。1 行 1 レコードの
>   配列だと 10 習慣 × 5 年（18,250 件）で 1.49 MB、入れ子なら 0.27 MB
> - `version` が未知、または JSON が壊れているときは **読み込みを失敗させ、書き込みを
>   止めます**。読めなかったデータを空で上書きするのが最悪の壊れ方だからです
> - id は `next_habit_id` の単調増加カウンタ。削除しても再利用しません

## 環境の前提（検証済み）

| 事実 | 構成への影響 |
|---|---|
| `node:sqlite` がフラグなしで動く（`ExperimentalWarning` のみ） | SQLite ドライバの依存パッケージは入れない。npm script に `--disable-warning=ExperimentalWarning` を付ける |
| `node xxx.ts` が直接動く（Node 22.18+ の型ストリッピング） | サーバー側に tsx / ts-node / ビルド手順は不要。`node --watch` も使える |
| Docker / DB サーバーが無い | SQLite ファイル 1 個で完結させる |

**型ストリッピングの制約**: 型を消すだけなので `enum` / `namespace` / パラメータプロパティは使えません。型の import は必ず `import type` に。tsconfig の `verbatimModuleSyntax: true` で型エラーとして検出させます。

## 判断とその理由

### 1. サーバーは日付を計算しない

「今日」は常にクライアントが決め、`YYYY-MM-DD` の文字列としてサーバーに渡します（統計 API は `?today=YYYY-MM-DD`）。

サーバーが `new Date()` から日付を導出すると、結果がサーバーの TZ 設定に依存します。デプロイ先が UTC なら、日本時間の朝 8 時に記録した習慣が「前日」に入りかねません。日付を文字列として受け取ってしまえば、ストリークは日付文字列の連続性だけで判定でき、TZ の概念自体が出てきません。

E2E で時刻を固定できるのも、この設計の副産物です。

### 2. 達成判定は `shared/domain.ts` の `isAchieved()` 一箇所だけ

```ts
isAchieved(habit, value)
  boolean … value >= 1
  numeric … target があれば value >= target、無ければ value > 0
```

クライアント（表示）とサーバー（統計）が同じ判定を必要としますが、**両方に書いてはいけません**。片方だけ直したときに、画面では達成に見えるのにストリークが伸びない、という最悪の形でズレます。

### 3. 現在ストリークは今日が未達成でも途切れさせない

today が未達成なら昨日から遡って数えます。素直に「today から連続」で実装すると、毎朝目覚めた時点でストリークが 0 に見えます。継続を支えるためのアプリでそれをやると本末転倒です。

### 4. 習慣の削除は論理削除

`archived_at` をセットし、`entries` は残します。物理削除すると過去のヒートマップに穴が空きます。「もうやらない習慣」を消したいだけで、やった事実まで消したいわけではありません。

残した以上、**画面から読めなければ意味がありません**。ヒートマップの習慣セレクタには、期間内に記録のある削除済み習慣も「〇〇（削除済み）」として並びます。全体ビューの分母は有効な習慣だけなので、有効な習慣が 0 件のときは全体ビューを出さず、削除済み習慣の履歴を直接表示します。

削除に確認ダイアログは出しません。代わりに削除直後に「削除を取り消す」を出します（`POST /api/habits/:id/restore`）。取り消せない削除に確認を付けるより、取り消せる削除のほうが安全です。

### 5. 統計は SQL ではなく JS で計算

個人利用なら `entries` は年間でも数千行です。全件読んで JS で計算するほうが読みやすく、何より `node:test` で純関数として単体テストが書けます。ストリーク計算はこのアプリで最もバグりやすい箇所なので、テストしやすさを優先します。

## データモデル

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- scrypt: "salt:hash"
  created_at TEXT NOT NULL);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL);

CREATE TABLE habits (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('boolean','numeric')),
  target REAL,                              -- numeric の 1 日の目標値。boolean は NULL
  unit TEXT,                                -- '分' '回' 等。boolean は NULL
  color TEXT NOT NULL,                      -- ヒートマップ用パレットキー
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,                         -- 論理削除
  created_at TEXT NOT NULL);

CREATE TABLE entries (
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                       -- 'YYYY-MM-DD'
  value REAL NOT NULL,                      -- boolean は 0/1、numeric は実績値
  updated_at TEXT NOT NULL,
  PRIMARY KEY (habit_id, date)) WITHOUT ROWID;

CREATE INDEX idx_entries_date ON entries(date);
CREATE INDEX idx_habits_user ON habits(user_id);
```

接続時に `PRAGMA journal_mode = WAL;` と `PRAGMA foreign_keys = ON;` を実行します。**`foreign_keys` は SQLite の既定が OFF** なので、明示しないと外部キー制約が効きません。

## API

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → HttpOnly セッション Cookie |
| POST | `/api/auth/logout` | セッション削除 |
| GET | `/api/auth/me` | 認証状態確認（未認証は 401） |
| GET / POST | `/api/habits` | 一覧（`archived_at IS NULL`。`?include_archived=1` で削除済みも）/ 作成 |
| PATCH / DELETE | `/api/habits/:id` | 更新（`target: null` で目標を解除）/ 論理削除 |
| POST | `/api/habits/:id/restore` | 論理削除の取り消し（`archived_at` を NULL に戻す） |
| GET | `/api/entries?from=&to=` | 期間内の記録。ヒートマップは 1 年分を 1 リクエストで取得 |
| PUT | `/api/entries/:habitId/:date` | `{value}` を upsert。`value: 0` で記録解除 |
| GET | `/api/stats?today=YYYY-MM-DD` | 現在 / 最長ストリーク、直近 30 日達成率 |

`/api/habits` 以降は全て認証ミドルウェアを通し、**必ず `user_id` で絞り込みます**。単一ユーザー運用でも最初からこの形にしておくのは、後から入れるのが面倒だからです。

存在しない / 他ユーザーのリソースは 403 ではなく **404** を返します。403 は「存在はする」という情報を漏らします。

## 認証

- `node:crypto` の `scrypt` でハッシュ（bcrypt 等の外部依存を足さない）。比較は `timingSafeEqual`
- セッショントークンは `randomBytes(32).toString('hex')`。Cookie は `HttpOnly` / `SameSite=Lax` / `Path=/`。有効期限 30 日
- `Secure` は **リクエストが実際に来たスキーム**で決める（`X-Forwarded-Proto` 優先、`COOKIE_SECURE` で上書き可）。`NODE_ENV` では決めない: `Secure` は接続の性質でありビルド種別ではないので、本番ビルドを http で配信した瞬間にブラウザが Cookie を捨て、原因の分からない 401 だけが残る
- ユーザー登録画面は作らない。`npm run seed-user` が `.env` から作成する
- 開発時は Vite proxy 経由で same-origin になるため CORS 設定は不要

## ディレクトリ構成

```
├── shared/{types.ts, domain.ts}        # client/server 双方から相対 import（ビルド不要）
├── server/
│   ├── src/
│   │   ├── index.ts                    # Hono 起動、本番は client/dist を静的配信
│   │   ├── db.ts, migrations.ts, auth.ts
│   │   ├── stats.ts, stats.test.ts     # ストリーク計算（純関数）とその単体テスト
│   │   └── routes/{auth,habits,entries,stats}.ts
│   └── scripts/{seed-user.ts, seed-e2e.ts}
└── client/
    ├── vite.config.ts                  # /api を localhost:3001 へ proxy
    └── src/
        ├── App.tsx, api.ts, hooks/useHabits.ts
        └── components/{LoginPage,TodayPanel,HabitForm,StatsPanel,Heatmap}.tsx
```

サーバーフレームワークは **Hono + @hono/node-server**。TypeScript の型推論が良く、依存が小さいためです。

## ヒートマップ

- **着手前に `dataviz` スキルを読むこと**（配色・凡例・アクセシビリティの基準）
- 外部チャートライブラリを使わず SVG を直接描く。7 行 × 52〜53 列
- 全体ヒートマップ = その日の「達成習慣数 / 有効習慣数」で 5 段階。習慣別 = `boolean` は 2 値、`numeric` は `value / target` 比で 5 段階
- セルに日付と値のアクセシブルネームを持たせる
- 横スクロールは `overflow-x: auto` のコンテナ内に閉じ込め、ページ本体は横スクロールさせない
