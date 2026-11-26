# 发版

这条 loop 从「决定发版」到「npm 上能装」，全部步骤都是实测过的（v0.1.1 走过一遍完整链路，含 CI 发布）。

## 触发

人决定发版。没有自动发版——版本号选错一个字符就发出去撤不回来。

## 步骤

### 1. 写 CHANGELOG 条目

在 `CHANGELOG.md` 顶部加一段 `## [x.y.z] - YYYY-MM-DD`，把 `[未发布]` 里该归到这一版的条目移进去。

条目写完**必须过一遍 `humanizer-zh` skill**：

- 保留全部事实：数字、文件名、行号、行为差异、完成状态
- 不新增原文没有的事实（不补性能数据、不补「用户反馈」）
- 保留否定与限定：「不再」「仅」「可能」不能被改成「一定」
- 代码块、行内代码、路径、命令保持原样
- 技术文体：准确交代行为差异，不写宣传语

判断依据是 diff，不是记忆：先看这次到底改了什么，再写。

### 2. 改版本号

```bash
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='x.y.z';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
```

### 3. 重建 dist 并跑门禁

dist 入库（`pi install git:` 靠它），所以版本号改完也要重建一次：

```bash
export TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)   # 本机必须，否则 worktree 用例假红
pnpm build
pnpm fmt:check && pnpm lint && pnpm check && pnpm test && pnpm check:privacy
pnpm build:check                                # 提交后才有意义：产物与源码一致
```

### 4. 提交并推

`main` 受保护，但管理员可绕过——作者的常规路径是直接推：

```bash
git add -A
git commit -m "chore(release): x.y.z"
git push origin main
```

（非管理员只能走 PR，且必须 `gate` 绿。）

### 5. 打 tag

tag 是这次发布的身份：它指着 tarball 构建自的那个 commit。

```bash
git tag vX.Y.Z          # 注意：tag 是 v 前缀 + package.json 的 version，必须逐字相同
git push origin vX.Y.Z
```

## CI 会做什么

`.github/workflows/ci.yml` 有两个 job：

```
gate    每次 push / PR 都跑：install → build → fmt/lint/check/test/privacy/breakpoints
publish 只在 push tag v* 时跑（needs: gate）：
        1. 校验 tag 与 package.json 的 version 一致，不一致就红
        2. pnpm install --frozen-lockfile（devDeps 要有，构建要它）
        3. pnpm build → npm run prepack（prepack 会再 build 一次）
        4. npm publish --access public
           认证走 npm trusted publishing（OIDC），没有 NPM_TOKEN
           attestation 由 npm 自动生成，不需要 --provenance
```

**publish 自己先跑一遍 gate**：tag 是人打的，不能只信上一次 run 的结论。代价是同一个 commit 的 gate 会跑两遍（push main 一次、tag 一次），一次多约 7 分钟。这个冗余是故意的。

## 失败怎么处理

| 症状                                           | 原因                                             | 处理                                |
| ---------------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| `tag vX.Y.Z 与 package.json 版本 x.y.z 不一致` | tag 和 version 没对上                            | 改 version 或重打 tag               |
| `ENEEDAUTH` / PUT 404                          | trusted publisher 的 workflow 文件名或 repo 填错 | 去 npmjs 设置页改，删 tag 重打      |
| prepublishOnly 挂了                            | CI 环境暴露了本地没跑到的门禁问题                | 本地复现（注意 `TMPDIR`），修完重发 |
| 版本已存在（`E403 cannot publish over`）       | 重复发同一个版本号                               | bump 到新版本                       |

重发前先删 tag，否则 push 会被拒：

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
```

## 外部前置（一次性，已完成）

- 仓库公开（attestation 需要）
- npm 上 `@goodali` scope 归作者，包名 `@goodali/pi-dispatch` 未被占用
- npm 上配好 trusted publisher：publisher = GitHub Actions，org = `a1121611810`，repo = `pi-dispatch`，workflow filename = **`ci.yml`**（不是 `publish.yml`——发布 job 写在 ci.yml 里）
- Publishing access 收到最严一档（disallow bypass-2fa tokens）：OIDC 不受影响，本地手动发布要 OTP

## 不做的事

- **不在本地手动 `npm publish`**：CI 出来的 tarball 带 provenance，能追到 commit 和 workflow；本地发的追不到。
- **不跳过 gate**：`--no-verify`、临时删测试都不行。门禁红就是有问题。
- **不为了「让 CI 过去」改断言**。
