// 真机重跑门（手动，不进 pnpm test）：同一个任务分别交给 codex 与 claude，
// 抓两份真流，判词必须一样。
//
// 为什么必须真跑：跨流同判词靠的是「同一件事被两家记成同一个形状」，
// 手搓夹具只能证明归一化器自洽，证明不了它对着真机能认出来。
//
// 用法：pnpm test:audit-cross
// 退出码：0 两流同判词；1 判词不一致；2 环境不对（CLI 缺失 / 跑不起来）
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, normalizeClaude, normalizeCodex } from "../src/audit/index.ts";

/** 任务要小、要确定、要写文件，这样两家都会留下可核对的路径收据。 */
// 选「跑一条命令」而不是「写一个文件」：路径收据在两家不对称（codex 常走 shell 写，
// 那是已知盲区），命令收据两边都有结构化的退出码，才是公平的对照。
const TASK =
  "必须真的执行一次 shell 命令 `pnpm --version`（不要凭空回答）。跑完之后只回复一行：跑通了 `pnpm --version`";
const TIMEOUT = 240_000;

interface Run {
  ok: boolean;
  reason?: string;
  stdout: string;
}

function run(cmd: string, args: string[], cwd: string): Run {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: TIMEOUT });
  if (result.error !== undefined) return { ok: false, reason: result.error.message, stdout: "" };
  if (result.signal !== null)
    return { ok: false, reason: `被信号打断：${result.signal}`, stdout: "" };
  if (result.status !== 0)
    return { ok: false, reason: `退出 ${result.status}`, stdout: result.stdout };
  return { ok: true, stdout: result.stdout };
}

function main(): number {
  const root = mkdtempSync(join(tmpdir(), "audit-cross-"));
  const codexDir = join(root, "codex");
  const claudeDir = join(root, "claude");
  mkdirSync(join(codexDir, "src"), { recursive: true });
  mkdirSync(join(claudeDir, "src"), { recursive: true });

  try {
    const codex = run(
      "codex",
      [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "-C",
        codexDir,
        TASK,
      ],
      codexDir,
    );
    const claude = run(
      "claude",
      [
        "-p",
        // 提示词要排在 `--allowedTools` **前面**：它是变长参数，会把后面的词吃掉。
        TASK,
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Bash",
      ],
      claudeDir,
    );

    for (const [name, result] of [
      ["codex", codex],
      ["claude", claude],
    ] as const) {
      if (!result.ok) {
        console.error(`${name} 跑不起来：${result.reason}`);
        return 2;
      }
    }

    const a = normalizeCodex(codex.stdout.split("\n"));
    const b = normalizeClaude(claude.stdout.split("\n"));
    const verdicts = {
      codex: audit(a.events, a.report, { cwd: codexDir }),
      claude: audit(b.events, b.report, { cwd: claudeDir }),
    };

    const commands = {
      codex: verdicts.codex.receipts.commands.length,
      claude: verdicts.claude.receipts.commands.length,
    };

    console.log(`codex  ${verdicts.codex.deliverable}  收据 ${commands.codex} 命令`);
    console.log(`claude ${verdicts.claude.deliverable}  收据 ${commands.claude} 命令`);

    // 产量断言：适配器要是「什么都没认出来」，两边的判词会一起退化成 unverified，
    // 那样「两边一样」就成了假绿。所以至少一边要认出路径收据。
    if (commands.codex === 0 || commands.claude === 0) {
      console.error("有一边没认出命令收据——适配器可能没认出来，不算通过");
      return 1;
    }

    if (verdicts.codex.deliverable !== verdicts.claude.deliverable) {
      console.error(
        `判词不一致：codex=${verdicts.codex.deliverable} claude=${verdicts.claude.deliverable}`,
      );
      return 1;
    }
    console.log("两流同判词");
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.exit(main());
