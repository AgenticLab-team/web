# 部署与运维

站点已上线：**https://agenticlab.sh**

---

## 现状

| 项目 | 值 |
|---|---|
| 服务器 | `ubuntu@agenticlab.sh` (203.0.113.10) |
| 代码 | `/home/ubuntu/agenticlab` |
| 数据库 | `/home/ubuntu/agenticlab/data/agenticlab.db`（SQLite + FTS5） |
| 运行时 | Node 22.23.2（`/usr/local/bin/node`） |
| 应用 | systemd `agenticlab.service` → 127.0.0.1:3000 |
| 同步 | systemd `agenticlab-sync.timer`，每 2 分钟 |
| 反代 | nginx，80 → 443 强制跳转 |
| 证书 | Let's Encrypt，`agenticlab.sh` + `www`，2026-11-06 到期，自动续期 |
| 上游 | frp 隧道 → `127.0.0.1:8090`（NekoBot） |

## 常用命令

```bash
# 本地开发（先开隧道，上游只在服务器内网可达）
ssh -N -L 8090:127.0.0.1:8090 ubuntu@agenticlab.sh &
npm run dev

npm run bootstrap          # 迁移 + 种子 + 拉群列表（幂等）
npm run groups             # 列出群与同步开关
npm run groups -- enable <关键词>
npm run sync               # 手动同步一轮
npm run resync -- <关键词|all>   # 清空重建某群镜像（判定规则改动后必跑）
npm run verify             # 与上游对账
npm run calibrate          # 反推高质量消息判定规则
npm run db:generate        # 改 schema 后生成迁移
```

## 部署流程

```bash
npm run deploy
```

它按顺序做：本地类型检查 → **lint** → 本地测试 → 同步 → 服务器依赖与迁移 →
服务器测试 → 服务器构建 → 重启 → 探活。任何一步失败都会停下，
**构建失败绝不会重启服务**。

### 为什么要写成脚本

早先是手敲一串命令用 `&&` 串起来，中间接了 `grep` 过滤输出。
结果 `npm run build | grep error` 在构建失败时 **grep 反而返回成功**
（管道的退出码是最后一个命令的），于是失败的构建照样触发了重启，
线上直接 502 —— 而且当时以为「构建成功了」。

写成脚本后又踩了两个坑，都记在脚本注释里：

1. **过滤按路径不按错误文本**。原本过滤 `not assignable` 是为了滤掉
   `.next` 里的生成类型噪音，结果把真实的类型错误一起滤掉了。
2. **`if` 条件里不要用管道**。开了 `pipefail` 之后，`tsc` 发现错误
   会返回非零，整条管道跟着非零，于是 `if ... | grep -q` 判定为假，
   反而跳过了报错分支。改成先落文件再判断。

3. **lint 一开始根本不在这条流水线里**，于是它悄悄烂了很久 ——
   攒到 6 个 error 才被发现，其中「渲染期读 ref」「effect 里同步 setState」
   都是真会出问题的写法，不只是风格。加进来时又差点踩第三次坑：
   判定写成 `grep '[0-9]+ error'` 会匹配到「0 errors」，每次都误判失败。
   现在是 `[1-9][0-9]* error`，且只挡 error 不挡 warning ——
   把 warning 也做成硬失败的话，加一个临时 console.log 都要先改配置，
   最后大家会去掉整个检查。

这几个坑的共同点是：**检查看起来在跑，其实什么都没拦住**。

> 服务器 npm 用腾讯云镜像，但 lockfile 里是 npmjs 的地址。
> 靠 `npm config set replace-registry-host always` 在安装时改写主机名，两边共用一份 lockfile。

## 查日志

```bash
sudo journalctl -u agenticlab -f            # 应用
sudo journalctl -u agenticlab-sync -n 50    # 同步任务
systemctl list-timers agenticlab-sync
```

同步结果也全部落在 `sync_jobs` 表里（拉了多少、写了多少、失败原因、耗时），
数据不对时先看这张表，不要靠猜。

---

## 实测数据（2026-08-08）

**存储比预估更省。** 22,684 条消息 → 数据库 **10.4 MB**（含 FTS 索引），
约 460 字节/条。按 890 条/天外推，一年约 **150 MB** —— 原先估的是 450 MB。
52 GB 可用空间下，文本完全不是问题。真正要防的仍然是媒体文件。

**同步性能**：本地经 SSH 隧道 12 秒拉完 5 个群 22k 条；服务器经 frp 隧道 95 秒。
增量同步每次只拉新消息，通常几百毫秒。

---

## 高质量消息判定（重要）

上游只给结果不给算法。`scripts/calibrate.ts` 用穷举反推出来：

```
{text, quote} 且 length >= quality_min(15)
```

与上游榜单 **10/10 完全吻合**（差额恰好等于每人的 quote 条数）。

最初我按「只算 text」实现，结果每个人都少算 3–35 条。
**改这个规则之前必须重跑 calibrate.ts** —— 机器人在群里报的排名和网站上的积分
不能是两套数字。

---

## 已知待办

- [ ] frp 隧道健康监测与告警（隧道断 = 数据源断，目前只有重试没有告警）
- [ ] 成员同步任务（`group_members` 还是空的，绑定时靠回源上游判定成员身份）
- [ ] 存储分层裁剪任务（tier 字段已就位，逻辑未实现）
- [ ] Passkey 注册与登录
- [ ] 备份（SQLite 只需定期复制文件 + WAL checkpoint）
