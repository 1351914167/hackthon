# 雾隐镇协议 v1

## 设计目标

- 服务端是规则、时间和事件序列的唯一事实源。
- 客户端提交意图，不提交结算结果。
- 所有写操作支持幂等和乐观并发。
- 权威状态与客户端投影分离，私密字段默认不可见。
- 协议使用显式版本，未知事件和未知版本必须拒绝处理。

## 客户端命令

```json
{
  "schemaVersion": 1,
  "actionId": "client-generated-uuid",
  "gameId": "game-id",
  "expectedSeq": 12,
  "type": "VOTE_CAST",
  "payload": {
    "targetSeatId": "seat-7"
  }
}
```

规则：

- `actorSeatId` 由服务端从座位令牌注入，客户端不得自报。
- 相同 `actionId` 和相同内容返回第一次处理结果。
- 相同 `actionId` 但内容不同返回 `ACTION_ID_CONFLICT`。
- `expectedSeq` 落后时返回 `SEQUENCE_CONFLICT` 和最新公开序号。

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
| `HUNTER_SHOT_SET` | `HUNTER_SHOT` | 猎人选择目标或放弃 |
| `PHASE_TIMEOUT` | 任一计时阶段 | 由可信服务端调度器提交 |

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

## 玩家快照

所有查看者都可以获得：

- 房间 ID、游戏 ID、规则版本、阶段、轮次、事件序号和截止时间。
- 公开席位状态、当前发言者、公开死亡、已公开票型和胜负结果。

本人额外获得：

- 自己的角色、阵营、技能余量、查验结果和待执行操作。

存活狼人额外获得：

- 规则允许的狼人队友身份。

观战者和普通出局玩家：

- 默认只获得公共字段，不自动看到全部身份。

对局结束：

- 根据规则公开全部角色和可公开复盘事件。

任何客户端 DTO 都不得包含：

- 全量角色映射。
- 未结算夜间目标。
- 其他玩家的私密结果。
- 内部随机材料、座位令牌或权威私密事件。

## HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/rooms` | 创建房间并获得房主座位令牌 |
| `POST /api/rooms/:roomId/join` | 使用昵称加入房间 |
| `POST /api/rooms/:roomId/ready` | 更新准备状态 |
| `POST /api/rooms/:roomId/start` | 房主开始游戏 |
| `GET /api/rooms/:roomId/snapshot` | 获取当前查看者可见快照 |
| `GET /api/rooms/:roomId/events?afterSeq=` | 建立 SSE 事件流并补发事件 |
| `POST /api/games/:gameId/actions` | 提交规则命令 |
| `POST /api/rooms/:roomId/reconnect` | 使用重连令牌恢复座位 |

座位令牌通过 `Authorization: Bearer <seat-token>` 发送。

## 标准错误

```json
{
  "error": {
    "code": "SEQUENCE_CONFLICT",
    "message": "The room state changed before this action was applied",
    "requestId": "request-id",
    "latestSeq": 14
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
| 409 | `SEQUENCE_CONFLICT` | 乐观并发冲突 |
| 409 | `ACTION_ID_CONFLICT` | 幂等键被不同内容复用 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求或音频超过限制 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 不支持的媒体类型 |
| 429 | `RATE_LIMITED` | 超出房间或语音限流 |
| 502 | `LINGXI_UPSTREAM_ERROR` | 灵汐返回不可用响应 |
| 504 | `LINGXI_TIMEOUT` | 灵汐请求超时 |
