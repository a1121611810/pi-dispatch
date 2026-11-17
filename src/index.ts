import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi 扩展入口：目前只声明能加载，派发门与任务面随后实现。
// 注册必须发生在 session_start——factory 阶段 getActiveTools() 是 throw 的桩。
export default function piDispatchEntry(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    // 派发门与任务面在此注册（尚未实现）
  });
}
