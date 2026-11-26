import { defineConfig } from "rolldown";

// 三个入口：
//   dist/index.js          pi 扩展（宿主提供 @earendil-works/*，不能打进产物）
//   dist/audit.js          会话审计的库面
//   dist/session-audit.js  CLI（带 shebang，package.json 的 bin 指向它）
// 扩展入口不 import 审计模块——它的产物必须逐字节不变。
export default defineConfig([
  {
    input: "src/index.ts",
    platform: "node",
    external: [/^@earendil-works\//],
    output: { file: "dist/index.js", format: "esm" },
  },
  {
    input: "src/audit/index.ts",
    platform: "node",
    output: { file: "dist/audit.js", format: "esm" },
  },
  {
    input: "src/bin/session-audit.ts",
    platform: "node",
    output: {
      file: "dist/session-audit.js",
      format: "esm",
      banner: "#!/usr/bin/env node",
    },
  },
]);
