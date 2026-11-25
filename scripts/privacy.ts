// 入库文件的隐私扫描。
//
// 为什么要有它：真机抓的样本（test/fixtures/*.jsonl）和文档里的路径示例，都是很容易
// 带出作者家目录、模型路由名、密钥的地方。本机改的时候看不出来，仓库公开那天就跟着走。
// 所以「以后别再泄漏」得是一条可执行的检查，不能靠记性。
//
// 判定口径与 scripts/verdicts.ts 同源：纯函数、不做 I/O，断言只落在输入输出上，
// 自己有夹具用例（test/privacy.test.ts），也进破坏点表。

/** 豁免文件：这些文件里出现的家目录路径是**故意的**（规则本身、夹具用例）。 */
export const EXEMPT_FILES: readonly string[] = [
  "scripts/privacy.ts",
  "scripts/privacy-gate.ts",
  "scripts/sanitize-fixture.ts",
  "test/privacy.test.ts",
];

/** 允许出现在路径示例里的家目录用户名——其余一律当作泄漏。 */
export const ALLOWED_HOME_USERS: readonly string[] = [
  "x",
  "dev",
  "user",
  "example",
  "test",
  "yourname",
];

/** 家目录前缀。用数组拼正则，免得这个文件自己被自己扫到。 */
const HOME_ROOTS = ["Users", "home"];

/** 密钥类模式。命中即红——宁可误报，密钥不能漏。 */
export const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{10,}/ },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{10,}/ },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{20,}/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer-token", re: /\bBearer [A-Za-z0-9._-]{20,}/ },
];

/** 邮箱：保留域名（.invalid/.example/.test）不算，其余当真邮箱查。 */
const ALLOWED_EMAIL_DOMAINS = ["invalid", "example", "test", "localhost"];

export type Finding = {
  file: string;
  /** 1 起。 */
  line: number;
  /** 命中的类别：home-path / secret / email / model-route */
  kind: string;
  /** 命中的那部分文本（截断）。 */
  text: string;
};

function isAllowedUser(user: string): boolean {
  return ALLOWED_HOME_USERS.includes(user);
}

/**
 * 扫一段文本，返回所有命中。
 *
 * 只认「家目录 + 真实用户名」的组合：`/Users/x/proj` 是占位符，放行；
 * `/home/dev/proj` 是真名，报出来。`/home/dev/...` 同理。
 */
export function scanText(text: string, file = "<text>"): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");

  const homeRe = new RegExp(`/(?:${HOME_ROOTS.join("|")})/([A-Za-z0-9._-]+)`, "g");
  lines.forEach((line, index) => {
    homeRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = homeRe.exec(line)) !== null) {
      const user = match[1]!;
      if (!isAllowedUser(user)) {
        findings.push({
          file,
          line: index + 1,
          kind: "home-path",
          text: match[0],
        });
      }
    }
  });

  for (const { name, re } of SECRET_PATTERNS) {
    lines.forEach((line, index) => {
      const found = re.exec(line);
      if (found) {
        findings.push({ file, line: index + 1, kind: `secret:${name}`, text: found[0] });
      }
    });
  }

  const emailRe = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)\.[A-Za-z]{2,}/g;
  lines.forEach((line, index) => {
    emailRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = emailRe.exec(line)) !== null) {
      const domain = match[1]!.split(".").pop()!.toLowerCase();
      if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) {
        findings.push({ file, line: index + 1, kind: "email", text: match[0] });
      }
    }
  });

  return findings;
}

/** 二进制文件（按扩展名）不扫——扫出来也是乱码。 */
export function isBinaryFile(file: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|ico|webp|pdf|zip|gz|woff2?|ttf)$/i.test(file);
}

/** 这个文件要不要扫（豁免清单里的不扫）。 */
export function isExempt(file: string): boolean {
  return EXEMPT_FILES.includes(file);
}
