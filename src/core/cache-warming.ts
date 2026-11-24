// cache 预热：孩子侧关掉。
//
// 机制事实：pi 的 cacheWarming 只读 agent 目录级 settings（项目级 `.pi/settings.json` 不生效），
// 所以关它只能走扩展钩子 `cache_warming_decision`。
// 预热的续接概率在**运行中**是 1（闲置期才是 0.15）⇒ 孩子在跑的时候 pi 几乎总是判定
// 「预热划算」⇒ 会真的发一次 prompt 全量重放。短命子代理跑完就没了，这份热缓存谁也用不上。
//
// 父会话（depth 0）不表态：父会话长命，预热对它有用。

/** 预热决策：depth > 0 ⇒ 停；depth === 0 ⇒ 不表态（undefined）。 */
export function cacheWarmingDecision(depth: number): { action: "stop" } | undefined {
  return depth > 0 ? { action: "stop" } : undefined;
}
