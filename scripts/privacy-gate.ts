// 隐私扫描的门禁入口：扫入库文件，命中就红。
//
// 与 scripts/test.ts 一样是「门禁入口」，但它不进 `pnpm test`——测试跑的是纯函数，
// 这里跑的是「当前工作树的入库文件」。所以单独一个脚本 + 单独的 npm script。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isBinaryFile, isExempt, scanText, type Finding } from "./privacy.ts";

/** 入库文件清单。git ls-files 拿不到未跟踪的文件——它们还没进仓库，不算。 */
export function trackedFiles(cwd = process.cwd()): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/** 扫一批文件，返回所有命中。读不动的文件跳过（不该因此让门禁红）。 */
export function scanFiles(files: readonly string[], cwd = process.cwd()): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (isBinaryFile(file)) continue;
    if (isExempt(file)) continue;
    let content: string;
    try {
      content = readFileSync(file === "<text>" ? file : `${cwd}/${file}`, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanText(content, file));
  }
  return findings;
}

function main(): void {
  const files = trackedFiles();
  const findings = scanFiles(files);
  if (findings.length === 0) {
    console.log(`隐私扫描：${files.length} 个入库文件，零命中`);
    return;
  }
  console.error(`隐私扫描：${findings.length} 处命中\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} [${finding.kind}] ${finding.text}`);
  }
  console.error("\n修法：路径换成占位符（/Users/x/…），密钥撤回来并轮换，示例路径别用真名。");
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
