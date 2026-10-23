# 房间服务与同源传输

H1 实现 `src/room` 与 `src/http`。`npm start` 启动本机服务，默认监听 127.0.0.1:4173，Node.js 24。`server.js` 仅导出应用工厂，导入不会绑定端口。

## 房间生命周期

- 访客先 POST /api/session，获得 HttpOnly/SameSite=Strict 会话 cookie。
- 建房和加入使用该会话及 Idempotency-Key，得到独立 seatToken；后续请求用 Bearer。
- 满九席且全员在线准备时，当前房主才能开局。随机发牌使用 crypto Fisher-Yates。
- 房主断线默认宽限 30 秒，再由可信 tick 迁移至最小在线席位；主动退出立即迁移。
- 结束后当前房主可 restart，回大厅清空准备，旧身份不进入新局。

## 一致性与权限

同一 Node 事件循环内同步执行认证、幂等、可见版本校验、规则决定、重放、原子追加与状态更新。已经结束游戏的最后一次命令仍能按原请求重试。HTTP 客户端不能提交内部 timeout 或自报 actor/seq。

SSE 使用带 Bearer 的 fetch 流。每个座位有独立有限消息队列和不透明 cursor；消息只含该玩家投影。其他玩家私密行动不会触发该查看者的额外消息，固定心跳不含规则序号。过旧 cursor 退回完整本人快照；慢消费者会断开并可重连。

可信服务端每 500ms 检查绝对截止时间。阶段实例绑定 phase event，其他私密行动不会使定时器失效。真实最终阶段决定下一 deadline，猎人不是固定按白天发言计时。

## 接口

所有 Room 写请求需要 JSON 与 Idempotency-Key。Game action 使用自身 actionId / expectedVersion。

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| /api/health | GET | 本机存活检查 |
| /api/session | POST | 匿名会话 |
| /api/rooms | POST | 建房 |
| /api/rooms/:id/join | POST | 入座 |
| /api/rooms/:id/ready | POST | 准备 |
| /api/rooms/:id/start | POST | 开局 |
| /api/rooms/:id/snapshot | GET | 本人快照 |
| /api/rooms/:id/events?cursor= | GET | 本人 SSE |
| /api/rooms/:id/actions | POST | 角色/投票/遗言命令 |
| /api/rooms/:id/reconnect | POST | 恢复连接 |
| /api/rooms/:id/leave | POST | 退出并注销令牌 |
| /api/rooms/:id/restart | POST | 结束后重开 |

当前阶段数据为内存状态；持久化、媒体、复盘由后续功能 PR 接入，不能把 H1 单独验收为完整产品。浏览器联机界面由 H2 提供。
