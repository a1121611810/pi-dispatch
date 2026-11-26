# 变更记录

本文件记录 pi-dispatch 的重要变更。

格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按
[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- **交付判词与任务状态分成两条轴。** `status` 只由子代理的退出码决定，它不是质量结论；
  交付另有一列 `deliverable`，取 `verified` / `unclaimed` / `partial` / `unverified` /
  `absent` 五档，在终态时由 registry 算一次。空跑退出 0 记作 `succeeded` + `absent`，
  账上不再把「进程退 0」当成「干成了」。

## [0.1.0] - 2026-11-26

首个版本。

### 新增

- **派子代理** —— `dispatch_task` 递一段任务，立刻拿编号（长驻宿主 rpc/tui）或等它跑完拿交付物
  （一次性宿主 print/json）。
- **排队** —— 座位从内存池切份额，满了 FIFO 排队，永远不拒绝。
- **管住** —— 盯卡住（静默 5 分钟且无在飞工具）、超时收掉、能停（排队中的抽掉，在跑的
  SIGTERM→SIGKILL）。
- **转向** —— 孩子还在跑时用 `dispatch_steer` 插一句话，它在下一个回合边界看到后调整方向继续干；
  不打断在飞工具。收据分 `sent` / `queued` / `delivered` / `seen` / `undelivered`，终态通知汇总
  「转向 N 条：送达 D / 生效 S（未送达 U）」。
- **留痕** —— 每次派发一条记录，落 `~/.pi/dispatch/<项目桶>/`，原子写、压缩归档、重启恢复。
- **核对** —— 收据从子代理的动作里抽，不依赖它自述。报告三种通道（tool / prompt-json / none）。
  自述的文件和收据一个都对不上时标 `deliveryUnverified`（后缀匹配，相对与绝对路径都认），
  只对上一部分时带 `deliveryPartial`（`{claimed, matched}`）；谎报自检（`verified` 声称跑过的命令，
  收据 commands 里一条都没观测到）标 `verifyUnverified`，同一部分命中走 `verifyPartial`。
  意思是「没有实测支撑」，不是「一定在撒谎」。
