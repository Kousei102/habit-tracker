# Phase 4 review — attempt 1
VERDICT: PASS

## 受け入れ基準

| ID | 判定 | 根拠 |
|----|------|------|
| AC-4.1 | PASS | `npm test` 117 passed / 0 failed。うち stats 単体は `server/src/stats.test.ts` 26 件 + `server/src/routes/stats.test.ts` 9 件 |
| AC-4.2 | PASS | 単体 `server/src/stats.test.ts:42`（今日は記録なし）/ `:49`（今日を明示的に 0）。E2E でも直接確認: `e2e/specs/phase4-stats.spec.ts:201`（today 未記録 + 昨日から 4 日連続 → 現在ストリーク 4、昨日も未達成にすると 0）、`:183`（UI で今日のチェックを外して 5 → 4、0 にならない） |
| AC-4.3 | PASS | 単体 `server/src/stats.test.ts:34`（today 含む 3 日 → 3）。E2E `e2e/specs/phase4-stats.spec.ts:135` |
| AC-4.4 | PASS | 単体 `server/src/stats.test.ts:137`（記録ゼロで 0/0/0%、例外なし）/ `:147`（全て value 0）。E2E `e2e/specs/phase4-stats.spec.ts:111` で新規習慣が `現在ストリーク 0 日 / 最長ストリーク 0 日 / 直近 30 日の達成率 0%（0 / 30 日）` と表示されることを確認 |
| AC-4.5 | PASS | 単体 `server/src/stats.test.ts:100`（current 2 / longest 5）、`:109`（途中の明示 0 が区切りになる）。E2E `e2e/specs/phase4-stats.spec.ts:166`（5 日連続 → 2 日前を 0 に → current 2 / longest 2） |
| AC-4.6 | PASS | 単体 `server/src/stats.test.ts:160`（29.9 は目標 30 未満なので不達成）/ `:174`（ちょうど目標は達成）。E2E `e2e/specs/phase4-stats.spec.ts:230`（記録 5 日・達成 3 日で current 2 / 達成率 10%（3 / 30 日）、29 → 30 に上げると 4 / 13%） |
| AC-4.7 | PASS | `e2e/specs/phase4-stats.spec.ts:135`（今日含む 5 日 → `現在ストリーク 5 日`）。negative control は `:146` |
| AC-4.8 | PASS | `e2e/specs/phase4-stats.spec.ts:166`（2 日前を未達成 → 5 → 2）、`:183`（UI で今日を外す → 5 → 4） |
| AC-4.9 | PASS | `e2e/specs/phase4-stats.spec.ts:255`（窓内 5 日 / 窓外 2 日 → `17%（5 / 30 日）`、窓外の行が DB に実在することも確認）、`:276`（30/30 → `100%`） |

## 検証方法（実装のスナップショットになっていないかの確認）

指示にあった「builder のテストが実装に合わせて書かれていないか」を、読解だけで済ませずに次の 2 つで確認しました。

1. **差分オラクル（differential test）**: `docs/phases.md` の記述だけを見て独立に書いた参照実装（1 日 = 整数、達成集合、today から遡る現在ストリーク、最古の達成日から today までを 1 日ずつ走査する最長ストリーク、today−29〜today の窓）と、実装 `server/src/stats.ts` の `computeHabitStats()` を、ランダム生成した 4000 パターン（boolean / numeric、target = null/0/5/30、未来 2 日〜過去 40 日、値は目標ちょうど・目標未満・0 を含む、順序シャッフル）で突き合わせ、`current_streak` / `longest_streak` / `achieved_days` が全件一致することを確認しました。参照実装側には「エントリ数を数える素朴な実装なら落ちる」ことを確かめるサニティケースを入れてあります。
   スクリプト: `/tmp/claude-1000/-workspaces-General-Claude-Code-Env-App-Project-1/42049529-9a6a-4463-88f8-e55709574a24/scratchpad/oracle.test.ts`（レビュー用の一時ファイル。リポジトリには入れていません）
2. **E2E アサーションの感度確認**: わざと誤った期待値（`現在ストリーク 99 日` / `99%（29 / 30 日）` / 存在しない習慣行）を書いた使い捨て spec を実行し、3 件とも失敗することを確認してから削除しました。`toContainText` が空振りして通る（vacuous な）アサーションでないことの確認です。観測された行テキストは `感度チェック現在ストリーク 5 日最長ストリーク 5 日直近 30 日の達成率 17%（5 / 30 日）`。

**達成判定の二重化について**: `isAchieved()` の呼び出し元は `shared/domain.ts:29` の定義に対して `server/src/stats.ts:58` と `client/src/components/TodayPanel.tsx:97` のみ。`server/src/stats.ts` にも `client/src/components/StatsPanel.tsx` にも `value >= target` 相当の比較は存在せず（grep 確認済み）、`StatsPanel` は API が返した数値を整形するだけです。二重化はありません。E2E `phase4-stats.spec.ts:230` でも、同一画面上で今日の記録行が `10 / 30 分`（未達成）と表示されている状態と、統計側が今日を達成に数えていないことを同時に assert しています。

## ブロッキング指摘

なし。

## 非ブロッキングの所見

1. **達成率の分母（申し送り 1）は妥当と判断しました。** AC-4.9 は「直近 30 日の達成率」としか書いておらず、固定 30 日窓はもっとも素直な読みです。加えて画面に `5 / 30 日` と分子分母が併記されているため、読み手が値を検算できます。作成日クランプにしないと「作成初日に 1 日達成で 100%」のような紛らわしい表示も避けられます。ただしこれは AC に書かれていない解釈なので、Phase 5/6 で仕様が変わるなら `docs/phases.md` 側の更新が必要です（builder は変更できないため、変更するならオーケストレーター経由）。
2. **`GET /api/stats` の `today` はクライアント申告値をそのまま信頼しています**（`server/src/routes/stats.ts:38`）。単一ユーザー運用かつ自分のデータしか読めないので実害はありませんが、「任意の日付時点の統計を照会できる」API になっている点は認識しておくとよいです（Phase 5 のヒートマップでも同じ設計が要ります）。
3. **数値入力 1 打鍵ごとに `PUT /api/entries` と `GET /api/stats` が飛びます**（`client/src/components/Dashboard.tsx` の `handleSetValue`）。`useStats` の `latestRequest` で古い応答は捨てているので表示は壊れませんが、`/api/stats` は毎回 `entries` を全件読みます（`server/src/routes/stats.ts:60`）。個人用の規模では問題ない一方、Phase 5 でヒートマップ用に 1 年分を読むようになると同じ経路が重くなるので、そのときにデバウンスを検討する余地があります。
4. **`Dashboard` の `today` はマウント時に 1 回だけ確定します**（`useState(() => toISODate(new Date()))`）。画面を開いたまま日付をまたぐと統計が前日基準のままになります。AC には無く、Phase 6 の仕上げで扱えば十分です。
5. **`client/src/api.ts` の `headers` 統合の修正は Phase 4 の AC 外の変更です。** 挙動としては正しい修正（`...init` が後置されて `headers` を丸ごと上書きしていた）で、Phase 1〜3 の spec 31 件が全て通るため回帰は確認できています。フェーズ外の変更であること自体を所見として記録します。
6. `StatsPanel` は統計未取得の習慣に `—` を出します（`client/src/components/StatsPanel.tsx:89`）。習慣作成直後の一瞬だけ見えますが、E2E では自動待機で解消しており、実害は見ていません。

## 実行結果

- `npx tsc --noEmit`（ルート。`e2e/**` を含む）: PASS
- `npm run typecheck`（root + server + client の 3 構成）: PASS
- `npm test`: 117 passed / 0 failed（stats 単体 35 件を含む）
- `npx playwright test`: **43 passed / 0 failed**（Phase 1: 5、Phase 2: 13、Phase 3: 13、Phase 4: 12。Phase 1〜3 の回帰なし）
- 追加検証: 差分オラクル 4000 ケース一致 / E2E アサーションの感度確認 3 件が期待どおり失敗
