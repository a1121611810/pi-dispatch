// 打包契约：README 教用户装的东西，必须就是这个包；tarball 里必须有运行入口。
//
// 为什么这些是「假绿测试」：CI 全绿、dist 也构建成功，但 users 照着 README 装到的
// 是别人的同名包（npm 上 pi-dispatch 归别人），或者 files 漏了入口发出去是空包——
// 这两种都只有发布之后才疼。锁在这里，第一个红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as Record<
  string,
  unknown
>;
const readme = readFileSync(new URL("README.md", root), "utf8");

const pkgName = pkg.name as string;
const pkgFiles = pkg.files as string[];
const scripts = pkg.scripts as Record<string, string>;
const repository = pkg.repository as { url: string };
const pi = (pkg.pi ?? {}) as { extensions?: string[] };
const slug = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repository.url);

test("打包：README 不用 npm 上的同名包（那个名字是别人的项目）", () => {
  assert.doesNotMatch(readme, /pi install npm:pi-dispatch/, "npm:pi-dispatch 装不到本仓代码");
});

test("打包：README 的 git 安装指令指向本仓", () => {
  assert.ok(slug, "package.json 的 repository 要能解析出 owner/repo");
  assert.match(
    readme,
    new RegExp(`pi install git:github\\.com/${slug[1]}/${slug[2]}`),
    "README 的安装指令要指向 package.json 的 repository",
  );
});

test("打包：只发运行件——dist 在，src/test/scripts 不在", () => {
  assert.ok(pkgFiles.includes("dist/**/*.js"), "运行入口得跟着包走");
  assert.ok(pkgFiles.includes("README.md"));
  assert.ok(pkgFiles.includes("LICENSE"));
  const leaked = pkgFiles.filter((f) => /^(src|test|scripts)\//.test(f));
  assert.deepEqual(
    leaked,
    [],
    "源码/测试/破坏点脚本不进包：它们要 src 与 devDeps，装上也只是死脚本",
  );
});

test("打包：pi 入口被 files 覆盖（否则装出来是空包）", () => {
  assert.deepEqual(pi.extensions, ["./dist/index.js"]);
  assert.ok(
    pkgFiles.some((f) => f.startsWith("dist/")),
    "pi 入口必须落在 files 里",
  );
  assert.match(pkg.main as string, /^\.\/dist\//);
});

test("打包：能发布——不 private、版本不是占位 0.0.0、git 装能先构建", () => {
  assert.notEqual(pkg.private, true, "private:true 会让 npm publish 直接拒绝");
  assert.notEqual(pkg.version, "0.0.0", "0.0.0 是没发过版的占位");
  assert.ok(scripts.prepare, "dist 不入库，git 装必须靠 prepare 先构建");
  assert.notEqual(pkgName, "pi-dispatch", "裸名在 npm 上属于别人的项目，必须换自己的 scope");
});
