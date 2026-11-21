// 门禁的环境卫生：跑测试/破坏点之前，把「跑的人身上带着的上下文」擦掉。
//
// 两个来源能把门禁变成假绿，且都不报错：
//   NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID —— 从 node 的测试进程里再起 `node --test`，
//     node 只打一行 warn（"skipping running files"）就退出 0：一条用例没跑，门禁照样绿。
//     派发子代理在测试进程里起，bash 一路继承，`pnpm test` / `pnpm check:breakpoints` 全瘫。
//   PI_DISPATCH_DEPTH —— 派发子代理的深度标记，适配层据此只装 child_report，
//     宿主侧用例全红（红错地方：不是被测行为坏，是环境被当成被测行为）。
//
// 擦的是「跑门禁」这件事的输入，不是被测行为本身——被测行为由用例自己 set/delete。
export const INHERITED_TEST_CONTEXT = ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"] as const;

/** 派发深度：父方是子代理时，这个变量会一路继承进门禁。 */
export const INHERITED_DISPATCH_DEPTH = "PI_DISPATCH_DEPTH";

/** 干净环境：复制一份，删掉继承来的测试上下文与派发深度；其余原样。 */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of INHERITED_TEST_CONTEXT) delete env[key];
  delete env[INHERITED_DISPATCH_DEPTH];
  // locale 固定：字符串排序/比较（板上文件名序、git/ps 输出）不随跑测试的人的机器变化，
  // 否则同一份用例在别的 locale 下可能假绿或红错地方。C.UTF-8 仍按字节序、且支持 UTF-8。
  env.LC_ALL = "C.UTF-8";
  env.LANG = "C.UTF-8";
  return env;
}
