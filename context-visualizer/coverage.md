# Coverage Audit — 回归门禁(ledger 对账)

> 独立校验:把 `events.json` 的 per-turn ledger 与**原始日志**对账。审计自带「可跳过」定义,不信任 build 的标签。
> 判据:每条 enqueue turn 必须有 ledger 条目;**genuine turn 不得 skipped**;skip 理由须正当且 ∈ 枚举。

## ses_0a54afc4effe8EBJDE9pqEJEp8
turns **0** · ✅抽取 0 · 🔁并入 0 · ⏭️跳过 0 · ❌问题 **0** · 留账率 **0%** · genuine 留存 **—%**(上界)

| line | ts | 状态 | event / 理由 | 内容 |
|---|---|---|---|---|

## 汇总

| 会话 | turns | ✅ | 🔁 | ⏭️ | ❌ | genuine留存(上界) |
|---|---|---|---|---|---|---|
| ses_0a54afc4effe8EBJDE9pqEJEp8 | 0 | 0 | 0 | 0 | 0 | —% |
| **合计** | **0** | 0 | 0 | 0 | **0** | **NaN%** |

留账率 = (抽取+并入+跳过)/turns = **NaN%**(目标 100%,即每条 turn 都有交代)。
genuine 留存 = (抽取+并入)/turns(**上界**:跨度内 ≥1 事件即算覆盖)。

## ❌ 违规(23)

- ses_0a54afc4effe8EBJDE9pqEJEp8 L1 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L2 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L9 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L16 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L23 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L3 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L4 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L5 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L6 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L7 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L8 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L10 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L11 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L12 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L13 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L14 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L15 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L17 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L18 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L19 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L20 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L21 ledger entry has no raw turn (stale)
- ses_0a54afc4effe8EBJDE9pqEJEp8 L22 ledger entry has no raw turn (stale)
