# 雾隐镇运行手册

本文说明单实例 Hackathon 版本的本地运行、配置、备份、恢复和故障处理。当前架构是 Node.js 24 模块化单体，房间快照、事件历史和复盘索引保存在 Node 内置 SQLite 中；原声文件位于同一数据目录下的 `media/`。

SQLite 是当前已实现并验证恢复路径的存储方案。它适用于单进程、单写实例。横向扩展时可以评估 PostgreSQL、共享媒体存储和跨实例房间调度，但这些不属于当前交付承诺。

## 运行要求

- 本地 Node：Node.js `24.x`，推荐与容器一致的 `24.15.0`。
- 容器：支持 Compose Specification 的 Docker Compose。
- 浏览器：当前版 Chrome；远程访问麦克风必须使用 HTTPS。
- 数据目录必须由运行进程独占并可写。

应用不自动读取 `.env`。`.env.example` 是配置参考；本地执行 `npm start` 前需要由 shell、进程管理器或容器注入环境变量。Docker Compose 会使用项目目录中的 `.env` 做变量替换。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 本地监听地址。容器内固定为 `0.0.0.0`，宿主机仍只发布到 `127.0.0.1`。 |
| `PORT` | `4173` | HTTP 端口。 |
| `DATA_FILE` | `data/wuyin.sqlite` | SQLite 文件。媒体目录自动使用同目录下的 `media/`。 |
| `LINGXI_API_KEY` | 空 | 仅服务端读取。为空时原声片段仍可用，但灵汐字幕与主持音不可用。 |
| `ICE_SERVERS` | `[]` | STUN/TURN 配置的 JSON 数组。TURN 凭证属于秘密。 |
| `PUBLIC_ORIGIN` | 未设置 | 允许写请求的精确 Origin，例如 `https://game.example.com`。容器示例默认本地 Origin。 |
| `COOKIE_SECURE` | `false` | HTTPS 部署必须设为 `true`；纯 HTTP 本地运行保持 `false`。 |

`ICE_SERVERS` 示例：

```json
[
  {"urls":"stun:stun.example.net:3478"},
  {
    "urls":["turn:turn.example.net:3478?transport=udp","turns:turn.example.net:5349?transport=tcp"],
    "username":"replace-at-runtime",
    "credential":"replace-at-runtime"
  }
]
```

不要把真实灵汐密钥、TURN 凭证、座位令牌或生产 Origin 写入 Git。Compose `.env` 中包含 `$` 的凭证需要按 Compose 的变量转义规则处理。

## 本地运行

最小启动：

```bash
export HOST=127.0.0.1
export PORT=4173
export DATA_FILE=data/wuyin.sqlite
npm start
```

打开 `http://127.0.0.1:4173`。健康检查：

```bash
curl --fail http://127.0.0.1:4173/api/health
```

预期响应包含 `"status":"ok"`。健康检查只说明 HTTP 进程可响应，不代表灵汐、TURN 或真实跨网络媒体链路已经验证。

## Docker Compose

1. 以 `.env.example` 为参考创建未跟踪的 `.env`，填入需要的运行值。
2. 先检查最终配置，避免 JSON 或 Origin 被错误展开。
3. 构建并启动。

```bash
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 wuyin
```

Compose 仅把 `4173` 发布到宿主机 `127.0.0.1`。容器以 UID/GID `1000:1000`、只读根文件系统、无 Linux capabilities 运行；命名卷 `wuyin-data` 挂载到 `/app/data`。首次创建的数据目录为 `0700`，SQLite 与媒体文件为 `0600`。

停止：

```bash
docker compose stop wuyin
```

删除容器但保留数据：

```bash
docker compose down
```

不要使用 `docker compose down -v`，除非明确要删除全部房间、复盘索引和保留原声。

## 数据与留存

```text
data/
├── wuyin.sqlite       # 房间快照、事件历史、复盘和声证引用
├── wuyin.sqlite.lock  # 单实例进程锁
└── media/             # 选择赛后保留的原声文件
```

- 原声片段先进入有界临时存储。
- 玩家必须显式开启赛后保留，片段才进入 SQLite 引用和 `media/`。
- 当前默认媒体 TTL 为 2 小时。选择保留不表示永久存档。
- SQLite 包含未结束房间的座位凭证、转写、标记和复盘数据，备份应按敏感数据保护。
- SHA-256 用于检测文件与引用是否一致，不提供内容真实性或说话人身份的密码学证明。

## 备份

运维约定是停服备份。虽然 repository 提供 SQLite backup API，但执行前仍需停止应用以释放 `.lock`，并让 SQLite 与 `media/` 处于同一个业务时间点。

### 本地 Node

```bash
mkdir -p backups data/backups
node -e "const {createSqliteRepository}=require('./src/persistence');(async()=>{const r=createSqliteRepository({filename:process.env.DATA_FILE||'data/wuyin.sqlite'});try{console.log(await r.backup('data/backups/wuyin-backup.sqlite'))}finally{r.close()}})().catch(e=>{console.error(e.code||e.message);process.exit(1)})"
tar -C data -czf backups/wuyin-media.tgz media
cp data/backups/wuyin-backup.sqlite backups/
```

先在运行 `npm start` 的终端按 `Ctrl+C`，或使用实际进程管理器停止服务并确认进程退出。项目没有 `npm stop` 或热备份 CLI。不要在应用仍持有锁时直接复制活动 SQLite 文件。

### Docker Compose

```bash
mkdir -p backups
docker compose stop wuyin
docker compose run --rm --no-deps wuyin sh -c 'mkdir -p /app/data/backups && node -e "const {createSqliteRepository}=require(\"./src/persistence\");(async()=>{const r=createSqliteRepository({filename:process.env.DATA_FILE});try{await r.backup(\"/app/data/backups/wuyin-backup.sqlite\")}finally{r.close()}})().catch(e=>{console.error(e.code||e.message);process.exit(1)})"'
docker compose run --rm --no-deps -v "$PWD/backups:/backup" wuyin sh -c 'cp /app/data/backups/wuyin-backup.sqlite /backup/ && tar -C /app/data -czf /backup/wuyin-media.tgz media'
```

备份必须成对保存：

- `wuyin-backup.sqlite`
- 同一停服窗口生成的 `wuyin-media.tgz`

SQLite 备份不包含 `media/` 的文件内容。

## 恢复

恢复会替换当前 SQLite 快照和 archive 记录。先保留现有数据的备份，并保持服务停止。

### Repository API

```bash
node -e "const {createSqliteRepository}=require('./src/persistence');const r=createSqliteRepository({filename:process.env.DATA_FILE||'data/wuyin.sqlite'});try{const current=r.load();console.log(r.restore('backups/wuyin-backup.sqlite',{expectedRevision:current?.revision||0}))}finally{r.close()}"
```

随后恢复与该 SQLite 备份配套的媒体目录：

```bash
mv data/media backups/media-before-restore
tar -C data -xzf backups/wuyin-media.tgz
chmod 700 data data/media
find data/media -type f -exec chmod 600 {} \;
```

执行前确认 `backups/media-before-restore` 尚不存在；若已存在，选择新的备份目录。只恢复由自己生成并核对内容的归档。容器环境可以把备份挂载到一次性 `docker compose run` 容器中，以相同 repository API 恢复 `/app/data/wuyin.sqlite`，再把配套媒体归档解压到 `/app/data/media`。完成后启动服务并检查健康状态、房间重连和保留声证回放。

恢复后的所有席位会先标记为断线；玩家必须使用原座位令牌重连。备份没有内置加密，请用受控存储和传输保护备份文件。

## Schema 与升级

- 当前 SQLite `user_version` 和持久化数据 schema 均为 `1`。
- 空数据库会自动初始化 v1 schema。
- 当前没有跨 schema 自动迁移。检测到不支持的版本、校验和错误或不完整表结构时，进程会拒绝启动，而不是猜测修复。
- 发布前先停服并生成 SQLite 与媒体配套备份。
- 代码回滚必须与数据库 schema 兼容。若新代码已经写入旧版本不认识的 schema，应同时使用 repository restore API 恢复升级前备份。
- 不要只回滚容器镜像而继续使用不兼容的数据文件。

## 锁与异常退出

SQLite 旁的 `.lock` 用于阻止两个进程同时写同一数据文件。锁记录进程 PID 和随机所有者 ID。

- 正常关闭会释放锁。
- 启动时仅在确认锁 PID 不存在后自动回收陈旧锁。
- 容器 PID 可能复用。若启动报告 `PERSISTENCE_LOCKED`，先确认没有任何本地进程或容器仍挂载并使用该数据卷，再手动删除对应 `.lock`。
- 绝不能在服务仍运行时删除锁或启动第二个写实例。

## HTTPS、麦克风与 TURN

- Chrome 在 `localhost` 和 `127.0.0.1` 允许安全上下文例外；远程主机必须通过 HTTPS 提供页面，浏览器才会开放麦克风。
- HTTPS 部署应由同源反向代理终止 TLS，设置精确的 `PUBLIC_ORIGIN=https://...` 和 `COOKIE_SECURE=true`。
- 实时原声是浏览器间 WebRTC P2P。服务器只转发同源信令，不接触 RTP 音频。
- 未配置 TURN 时，复杂 NAT、企业网络或对称 NAT 下连接可能失败。录音片段仍是可用的降级路径。
- TURN 必须自管或由明确选择的基础设施提供。上线前需从两个真实外部网络验证 UDP、TCP/TLS relay；本机双标签成功不能证明公网可用。
- 当前 speaker 最多向八名接收者发送上行音轨，低带宽设备需要单独验收。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 启动时报 SQLite lock | 确认没有其他实例；核对 `.lock` PID 后再决定是否清理。 |
| `PERSISTENCE_SCHEMA_UNSUPPORTED` | 数据 schema 与代码不兼容；使用配套版本或停服恢复备份。 |
| 数据目录权限错误 | 确认容器卷对 UID/GID 1000 可写，目录 `0700`、文件 `0600`。 |
| 写请求返回 Origin 错误 | `PUBLIC_ORIGIN` 必须与浏览器地址的 scheme、host、port 完全一致。 |
| 会话 cookie 未建立 | 本地 HTTP 不要设置 `COOKIE_SECURE=true`；远程 HTTPS 必须设置。 |
| 原声可录但无字幕 | 检查 `LINGXI_API_KEY` 和 `/api/lingxi/status` 的 checked/healthy 字段。 |
| WebRTC 无声音 | 检查麦克风权限、当前 speaker、ICE 配置和 TURN relay；使用声证片段确认降级路径。 |
| 保留声证无法回放 | 检查 SQLite VOICE_REF 与同批次 `media/` 是否同时恢复，以及文件 SHA-256。 |

## 日志与调试

生产调试仅记录请求 ID、错误代码、HTTP 状态、耗时和匿名化资源标识。不要记录或输出：

- `Authorization`、座位令牌、匿名 session cookie。
- `LINGXI_API_KEY`、TURN username/credential 或完整环境变量。
- 原始 multipart 音频、转写全文、私人标记和完整房间快照。

不要用 `env`、`printenv` 或调试中间件把运行环境整体写入日志。需要排查灵汐时查看能力状态布尔值和标准错误码，不打印上游 Authorization。

## 外部视觉素材

界面 CSS 在运行时引用以下 Unsplash 图片 URL：

```text
https://images.unsplash.com/photo-1697434903747-0e80f87577cb?auto=format&fit=crop&w=2200&q=82
```

仓库和容器不下载、不重新分发该图片，也不会把本地内容上传到 Unsplash 或其他第三方站点。离线或被内容策略拦截时，界面退化为本地 CSS 背景。
