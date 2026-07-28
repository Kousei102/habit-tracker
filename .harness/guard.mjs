#!/usr/bin/env node
// PreToolUse guard: enforces role separation between the builder and reviewer agents.
//
// The harness is only meaningful if the agent that writes the code is not the same
// one that decides whether it passes. Asking nicely is not enough, so this hook
// blocks the writes that would collapse that separation.
//
//   node .harness/guard.mjs builder    blocks writes to the acceptance tests
//   node .harness/guard.mjs reviewer   blocks writes to the production code
//
// Contract: reads {tool_name, tool_input} as JSON on stdin. Exit 2 blocks the call
// and feeds stderr back to the agent as feedback.

import path from "node:path";

const ROLES = {
  builder: {
    deny: ["e2e/", ".harness/", ".claude/agents/", "docs/phases.md"],
    reason:
      "builder は受け入れテストと受け入れ基準を変更できません。テストが実装に合っていないと感じた場合でも書き換えず、" +
      "完了報告に「この AC は仕様の解釈が曖昧」と書いてください。判断はオーケストレーターが行います。",
  },
  reviewer: {
    deny: [
      "client/",
      "server/",
      "shared/",
      ".claude/agents/",
      "package.json",
      "package-lock.json",
      "tsconfig.base.json",
    ],
    reason:
      "reviewer は製品コードを変更できません。見つけた不具合は判定ファイルのブロッキング指摘として" +
      "「どのファイルの何行目が、どういう入力で、どう壊れるか」まで書いて報告してください。修正は builder が行います。",
  },
};

// Best-effort detection of a Bash command that writes somewhere. Paired with a
// denied-path mention below, so a false positive here alone never blocks anything.
const WRITE_INDICATOR =
  /(^|[\s;&|(])(tee|cp|mv|rm|rmdir|truncate|dd|touch|mkdir|ln)\b|>>?|\bsed\s+-i\b|\bperl\s+-i\b/;

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
}

// Repo-relative POSIX path, or null when the target sits outside the repo
// (scratchpad, /tmp, …) — those are none of this guard's business.
function toRepoRelative(target, cwd) {
  const rel = path.relative(cwd, path.resolve(cwd, target));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function matchDenied(relPath, deny) {
  return deny.find((d) => (d.endsWith("/") ? relPath.startsWith(d) : relPath === d));
}

function block(role, target, reason) {
  process.stderr.write(
    `[harness] ${role} は ${target} に書き込めません。\n\n${reason}\n\n` +
      `禁止パス: ${ROLES[role].deny.join(", ")}\n`,
  );
  process.exit(2);
}

const role = process.argv[2];
const rules = ROLES[role];
if (!rules) {
  process.stderr.write(`[harness] guard.mjs: unknown role "${role}"\n`);
  process.exit(1);
}

const raw = await readStdin();
let event;
try {
  event = JSON.parse(raw);
} catch {
  // Nothing to judge without a parseable target; let the call through rather than
  // wedging the whole run on a malformed event.
  process.exit(0);
}

const cwd = process.cwd();
const toolName = event.tool_name ?? "";
const input = event.tool_input ?? {};

if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
  const rel = toRepoRelative(input.file_path ?? input.notebook_path ?? "", cwd);
  if (rel) {
    const hit = matchDenied(rel, rules.deny);
    if (hit) block(role, rel, rules.reason);
  }
} else if (toolName === "Bash") {
  const command = String(input.command ?? "");
  if (WRITE_INDICATOR.test(command)) {
    // Reading a denied path is fine; only block when the command also looks like a write.
    const hit = rules.deny.find((d) => command.includes(d));
    if (hit) {
      block(
        role,
        hit,
        `${rules.reason}\n\n` +
          `（このコマンドは ${hit} への書き込みの可能性があると判定されました。` +
          `読み取りのみのつもりであれば、リダイレクトや cp/mv/rm を含まない形に分けて実行してください。）`,
      );
    }
  }
}

process.exit(0);
