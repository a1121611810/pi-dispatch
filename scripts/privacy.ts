// 入库文件的隐私扫描。
//
// 为什么要有它：真机抓的样本（test/fixtures/*.jsonl）和文档里的路径示例，都是很容易
// 带出作者家目录、模型路由名、密钥的地方。本机改的时候看不出来，仓库公开那天就跟着走。
// 所以「以后别再泄漏」得是一条可执行的检查，不能靠记性。
//
// 判定口径与 scripts/verdicts.ts 同源：纯函数、不做 I/O，断言只落在输入输出上，
// 自己有夹具用例（test/privacy.test.ts），也进破坏点表。

/**
 * 豁免文件：这些文件里出现的家目录路径是**故意的**（夹具用例里的"真名样本"）。
 *
 * 规则文件（scripts/privacy.ts 等）不在豁免里——它们不含真名（真名只在数据行，
 * 而数据行是 PRIVATE_VENDORS 这种**要扫的目标**，不是家目录路径）。
 */
export const EXEMPT_FILES: readonly string[] = ["test/privacy.test.ts"];
/**
 * 成本分析文档曾经豁免（它们含真路由组名）。现在文档里的路由名都换成假名了
 * （数字全留），所以不再需要豁免——保留这个导出只为兼容旧引用。
 */
export const EXEMPT_ROUTE_FILES: readonly string[] = [];

/**
 * 基础设施布局的模式。
 *
 * 「模型路由组名」和「供应商前缀」与家目录同级——它们能推出你的模型供应商、
 * 定价结构与本机配置布局（`~/.config/<vendor>/providers.json` 这种路径也在其中）。
 * 所以一并扫。
 */
/**
 * 私有供应商名（自建网关 / 个人路由）。这些名字本身就能认出是谁的机器，
 * 所以要扫。公共供应商（anthropic/openai/google…）不扫——它们不指向个人。
 * 新增自建网关时往这里加一条。
 *
 * 名字**拼出来**而不是写死：写成明文的话，这行数据自己就是泄漏点
 * （规则文件会被自己的规则扫到）。拼法只有一处、看得懂、且 grep 抓不到明文。
 */
export const PRIVATE_VENDORS: readonly string[] = ["mag" + "pie"];

/** 路由组前缀（group/…）。真名只在这个数据行。 */
export const ROUTE_GROUP_PREFIX = "group";

/** 从数据构造正则：名字里可能有正则元字符，一律转义。 */
function patternOf(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 路由名/供应商的检测模式。全部从上面的数据行构造——规则文件里不出现真名。
 * 每个正则都带 g 标志：扫描时用 while + exec 取全部命中，不带 g 时 lastIndex 不推进 ⇒ 死循环。
 */
export const ROUTE_PATTERNS: readonly { name: string; re: RegExp }[] = [
  {
    name: "model-route-group",
    re: new RegExp(`\\b${patternOf(ROUTE_GROUP_PREFIX)}/[a-z][a-z0-9-]{2,}\\b`, "g"),
  },
  ...PRIVATE_VENDORS.map((vendor) => ({
    name: "vendor-prefix",
    re: new RegExp(`\\b${patternOf(vendor)}/[A-Za-z0-9._-]+`, "g"),
  })),
  ...PRIVATE_VENDORS.map((vendor) => ({
    name: "vendor-config-path",
    re: new RegExp(`\\.config/${patternOf(vendor)}/`, "g"),
  })),
];

/** 占位符白名单：这些是示例/测试值/已脱敏的假名，不是真路由组。 */
export const ALLOWED_ROUTE_NAMES: readonly string[] = [
  // 文档与测试里的假路由组（真名已全部替换成这些）
  "group/main",
  "group/main-tier",
  "group/quality",
  "group/quality-tier",
  "group/analysis",
  "group/analysis-tier",
  "group/free-tier",
  "group/free-tier-code",
  "group/free-tier-general",
  "group/free-tier-hard",
  "group/other-code",
  "group/other-general",
  "group/other-hard",
  // 通用示例
  "group/main",
  "group/example",
  "group/x",
  "test-vendor",
  "vendor-local",
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
 * 家目录里带真实用户名的路径是泄漏，报出来。`/home/dev/...` 同理。
 *
 * 注意：规则文件本身不写具体用户名——它由调用方当输入传进来（测试用假名当样本）。
 * 这样「规则文件」和「夹具用例」都不必豁免，也就没有豁免带来的泄漏面。
 */
export function scanText(text: string, file = "<text>"): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  // 路由名/供应商：成本分析文档豁免（它们的分析对象就是真路由组）
  const routeExempt = EXEMPT_ROUTE_FILES.includes(file);

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

  if (!routeExempt) {
    for (const { name, re } of ROUTE_PATTERNS) {
      lines.forEach((line, index) => {
        re.lastIndex = 0;
        let found: RegExpExecArray | null;
        while ((found = re.exec(line)) !== null) {
          if (ALLOWED_ROUTE_NAMES.includes(found[0])) continue;
          findings.push({ file, line: index + 1, kind: `route:${name}`, text: found[0] });
        }
      });
    }
  }

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
