# 雾隐镇协议 v1

## 设计目标

- 服务端是规则、时间和事件序列的唯一事实源。
- 客户端提交意图，不提交结算结果。
- 所有写操作支持幂等；Game 行动使用查看者版本进行乐观并发，Room 写操作由房间命令队列串行重验。
- 权威状态与客户端投影分离，私密字段默认不可见。
- 协议使用显式版本，未知事件和未知版本必须拒绝处理。
- 本文件中的 HTTP/SSE 已接入服务端和客户端；当前扩展接口另见房间服务与声证文档。

## 房间与牌局的边界

- `Room` 管理逐人加入、昵称、准备、连接状态和当前房主；允许 1–9 人。
- `/start` 在同一房间命令队列内校验当前房主、9 人全准备与尚未开局，然后创建固定 9 席、全员 ready 的 `Game`，注入安全随机角色并立即执行 `GAME_START`。不能在等待房主点击期间预先创建 Game。
- 引擎的 `LOBBY`、`ROOM_READY_SET` 和 `GAME_START` 只用于固定席位的领域启动适配与测试，不作为联机大厅的第二份准备状态，不承接逐人加入或房主迁移。
- `Game.hostSeatId` 记录开局发起人，游戏过程中不随房间房主变化；当前房主由 `Room` 管理。
- 房间房主不能代替其他玩家提交技能，也不能直接修改权威状态。

## 客户端命令

```json
{
  "schemaVersion": 1,
  "actionId": "client-generated-uuid",
  "gameId": "game-id",
  "expectedVersion": "当前本人快照中的 version",
  "type": "VOTE_CAST",
  "payload": {
    "targetSeatId": "seat-7"
  }
}
```

规则：

- `actorSeatId` 由服务端从座位令牌注入，客户端不得自报。
- 幂等键的作用域为 `(gameId, actorSeatId, actionId)`；不同玩家使用相同 `actionId` 互不影响。
- 同一玩家相同 `actionId` 和相同内容复用首次结算结果，不重新执行规则。
- 同一玩家相同 `actionId` 但内容不同返回 `ACTION_ID_CONFLICT`。
- `expectedVersion` 必须等于本人当前可见快照的 `version`，否则返回 `VIEW_CONFLICT` 和本人的 `latestVersion`。
- `version` 是仅根据可见 DTO 计算的 SHA-256 内容摘要，不包含全局事件序号；其他玩家的私密行动不得改变它。
- `version` 只用于并发检查，不是登录凭证，不能替代座位令牌。
- 对外不接收 `expectedSeq`；内部 `decide` 的 `expectedSeq` 由服务端在完成上述校验后注入。

## 命令处理顺序

```text
认证座位并绑定 actorSeatId
  -> findAction(gameId, 已认证的客户端意图)
  -> 命中：复用首次结果；未命中：校验本人 expectedVersion
  -> 注入当前内部 seq，调用 decide
  -> replay 校验整批事件与下一状态
  -> append 原子写入事件和幂等记录
  -> 更新内存状态
  -> 生成每名查看者的白名单快照
  -> 仅向可见内容发生变化的查看者推送
```

不能先调用 `decide` 再查询幂等，否则已成功请求的重试会被较新的内部序号拒绝。

同一牌局的写入必须串行执行。`createMemoryEventStore` 只接受同步追加；当前房间服务的命令队列保证从读取到追加之间不插入另一条同局命令。

存储保存已认证的客户端意图（含 `expectedVersion`），内部序号作为 `append` 的独立参数。对外响应只包含确认状态和本人最新投影，不直接返回存储缓存中的权威事件。

## 权威事件

```json
{
  "schemaVersion": 1,
  "eventId": "event-id",
  "gameId": "game-id",
  "seq": 13,
  "type": "VOTE_RECORDED",
  "at": "2026-10-23T10:00:00.000Z",
  "causationId": "client-generated-uuid",
  "payload": {}
}
```

- `at` 由应用层注入并写入事件，重放不读取当前时间。
- 一条命令可以原子地产生多条事件。
- 权威事件不得直接发送给客户端，必须先经过玩家投影。
- `seq`、`eventId`、`causationId` 仅供服务端存储、并发校验与重放；它们不得成为 SSE ID、公开版本或错误响应字段。
- `evolve` 会验证阶段、角色、目标、轮次和结算条件；完整可信历史必须来自 `decide` 生成并通过重放验证的原子批次，禁止直接接受客户端事件。

## v1 命令类型

| 类型 | 允许阶段 | 说明 |
| --- | --- | --- |
| `ROOM_READY_SET` | `LOBBY` | 更新本人准备状态 |
| `GAME_START` | `LOBBY` | 仅房主且全员准备时开局 |
| `WOLF_TARGET_SET` | `NIGHT_WOLF` | 狼人选择或修改目标 |
| `WITCH_ACTION_SET` | `NIGHT_WITCH` | 女巫救、毒或跳过 |
| `SEER_TARGET_SET` | `NIGHT_SEER` | 预言家选择查验目标 |
| `SPEECH_FINISH` | `DAY_SPEECH` | 当前发言玩家结束发言 |
| `VOTE_CAST` | `DAY_VOTE` | 投票、改票或弃票 |
| `LAST_WORD_FINISH` | `LAST_WORD` | 被放逐玩家结束遗言；允许该死亡玩家操作 |
| `HUNTER_SHOT_SET` | `HUNTER_SHOT` | 猎人选择目标或放弃 |
| `PHASE_TIMEOUT` | 任一计时阶段 | 仅内部可信调度器；HTTP 客户端禁止提交 |

调度器必须同时匹配 `gameId`、阶段实例、轮次和截止时间，在时钟已达到截止时间后进入同局命令队列。阶段实例可由最近一条 `PHASE_CHANGED` 的内部序号标识；同一阶段内的私密行动不会改变它。执行超时命令时再注入最新内部 `expectedSeq`，不能因为期间有人行动就永久丢弃原定时器。过期定时任务不得推进新阶段。断线不取消合法的既有截止时间，服务端重连快照下发绝对时间，客户端按绝对时间计算剩余秒数。

## v1 事件类型

| 类型 | 可见范围 | 说明 |
| --- | --- | --- |
| `GAME_STARTED` | 公共 | 固化规则版本与座位 |
| `ROLE_ASSIGNED` | 对应本人 | 分配角色 |
| `PHASE_CHANGED` | 公共 | 阶段、轮次和截止时间变化 |
| `PRIVATE_ACTION_RECORDED` | 对应行动者 | 私密行动已接收 |
| `SEER_RESULT_RECORDED` | 预言家本人 | 查验结果 |
| `PLAYER_DIED` | 公共 | 席位与公开死亡原因 |
| `VOTE_RECORDED` | 对应投票者 | 投票已接收 |
| `VOTE_RESULT_REVEALED` | 公共 | 阶段结束后公开票型 |
| `GAME_FINISHED` | 公共 | 胜方与结束原因 |
| `ROLES_REVEALED` | 对局结束公共 | 全部身份 |

本表描述业务字段的允许接收者，不表示可直接广播完整权威事件。启动边界内的准备状态虽然通过 `PRIVATE_ACTION_RECORDED` 记录，准备标记仍属于所有人可见的席位字段。真正大厅的准备和房主变化由 Room 的公共状态承接。

## 玩家快照

所有查看者都可以获得：

- 房间 ID、游戏 ID、规则版本、阶段、轮次、可见内容版本和截止时间。
- 公开席位状态、当前发言者、公开死亡、已公开票型和胜负结果。
- `LAST_WORD` 时当前发言者是被放逐玩家，不能因其已死亡而移除结束遗言的操作。

本人额外获得：

- 自己的角色、阵营、技能余量、查验结果和待执行操作。
- `self.currentAction` 明确区分未提交、主动弃权和已选择，支持刷新后恢复确认态；只投影本人在当前阶段的最终选择。
- 活着的女巫在自己的阶段可获得规则允许的当夜狼刀目标；这属于授权例外，其他人仍不可见。

存活狼人额外获得：

- 规则允许的狼人队友身份。

观战者和普通出局玩家：

- 默认只获得公共字段，不自动看到全部身份。

对局结束：

- 根据规则公开全部角色和可公开复盘事件。

任何客户端 DTO 都不得包含：

- 对局结束前的全量角色映射；结束后的 `revealedRoles` 是明确授权的例外。
- 其他玩家未结算的夜间目标、行动和私密结果。
- 内部随机材料、座位令牌或权威私密事件。
- 全局 `seq`、内部 `eventId` 或由它们派生的版本标识。

白名单必须覆盖嵌套结构；死亡记录、票型、查验和技能库存不能整块复制权威对象，避免以后新增内部字段时泄露。

## HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/session` | 建立匿名访客会话，仅用于尚未入座时的请求作用域 |
| `POST /api/rooms` | 创建房间并获得房主座位令牌 |
| `POST /api/rooms/:roomId/join` | 使用昵称加入房间 |
| `POST /api/rooms/:roomId/ready` | 更新准备状态 |
| `POST /api/rooms/:roomId/start` | 房主开始游戏 |
| `GET /api/rooms/:roomId/snapshot` | 获取当前查看者可见快照 |
| `GET /api/rooms/:roomId/events?cursor=` | 建立本人 SSE 消息流；cursor 不是权威 seq |
| `POST /api/games/:gameId/actions` | 提交规则命令 |
| `POST /api/rooms/:roomId/reconnect` | 使用重连令牌恢复座位 |

座位令牌通过 `Authorization: Bearer <seat-token>` 发送。

### SSE 鉴权与恢复

- 浏览器使用 `fetch` 流式读取 `text/event-stream`，携带 Authorization；不使用无法设置该请求头的原生 `EventSource`。
- 令牌不得放在查询参数、URL 或客户端日志中。
- 每名查看者维护独立、有限长度的投影消息流，使用不透明 cursor；不得复用权威事件 ID。
- 只有该查看者可见快照的 `version` 变化时才发送快照；不得因其他人的私密操作发送空事件或“状态无变化”提示。
- 心跳按固定节拍发送，不包含内部序号或私密操作时间。
- cursor 只能恢复对应房间、游戏和查看者的消息。过期或不能恢复时返回完整本人快照，不向客户端开放 `store.eventsAfter`。
- 新牌局重新建立消息流，不复用上一局的私密快照或 cursor。

### 房间写操作与迁移

- 首次进入大厅先调用 `/api/session`，服务端通过 HttpOnly、SameSite=Strict 的匿名 cookie 建立访客作用域，生产 HTTPS 使用 Secure；该 cookie 不是座位权限，不能访问私密牌局数据。接口与其他写操作都校验同源 Origin，不在 URL 中传会话标识。
- 建房、加入、准备、开局和重连 POST 都使用 `Idempotency-Key`；建房/首次加入在匿名访客作用域内隔离，入座后绑定认证座位。同一个 key 在不同访客间不能共享结果。
- Room 写入使用命令队列串行执行并重新验证容量、房主和状态；Game 行动另外校验 `expectedVersion`。不能把 Room 尚未定义的并发版本写成已实现能力。
- 房主主动退出或超过断线宽限后，按在线且未退出席位的编号升序选择继任者，发布 `HOST_CHANGED` 公共状态更新。
- 房主迁移不改变当前牌局的技能、投票和发言权限。
- 房间为空时销毁；成员凭原座位令牌重连不能抢占其他席位。
- 单独使用内存房间服务无法在进程重启后恢复；默认运行时已装配 SQLite 持久化适配，写入失败会回滚，重启后先将席位标记为离线。详见运行手册。

## 标准错误

```json
{
  "error": {
    "code": "VIEW_CONFLICT",
    "message": "The room state changed before this action was applied",
    "requestId": "request-id",
    "latestVersion": "仅属于当前查看者的快照版本"
  }
}
```

| HTTP 状态 | 代码 | 使用场景 |
| ---: | --- | --- |
| 400 | `INVALID_REQUEST` | 结构或字段不合法 |
| 401 | `INVALID_SEAT_TOKEN` | 缺少或无效令牌 |
| 403 | `ACTION_NOT_ALLOWED` | 身份、阶段或存活状态不允许 |
| 404 | `ROOM_NOT_FOUND` | 房间不存在 |
| 409 | `ROOM_FULL` | 房间已满 |
| 409 | `VIEW_CONFLICT` | 本人可见版本冲突；内部 SEQUENCE_CONFLICT 不原样外泄 |
| 409 | `ACTION_ID_CONFLICT` | 幂等键被不同内容复用 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求或音频超过限制 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 不支持的媒体类型 |
| 429 | `RATE_LIMITED` | 超出房间或语音限流 |
| 502 | `LINGXI_UPSTREAM_ERROR` | 灵汐返回不可用响应 |
| 504 | `LINGXI_TIMEOUT` | 灵汐请求超时 |
