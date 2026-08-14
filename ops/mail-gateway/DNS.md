# DNS 怎么配

> ✅ **2026-08-14：100 个域名已全部配好并核对通过。**
> 下面留作以后加域名时的参考。核对方法见最后一节。

---

## 动手之前：三件先定下来的事

### ① MX 主机名：实际用的是 `publicmx.agenticlab.sh`

它写进了**每一个**域名的 MX 记录，所以
**「这 100 个域名是一家的」这件事现在是公开的** —— 谁都查得出来。
换掉它等于重配一百条 MX，所以定了就别动。

⚠️ 后台「系统设置 → `mail.mx_host`」**必须和它一模一样** ——
DNS 体检拿这个值去比对，填错的话一百行全判成红灯，
而真正的问题是那个设置本身。

### ② 同机部署 = 源站 IP 会公开

`publicmx.agenticlab.sh` 的 A 记录指向哪台机器，那台机器的 IP 就是公开的。
现在网关和站点同机，**这件事已经发生了**：
`publicmx.agenticlab.sh` 解析到源站那台机器。

（这里不写具体 IP —— `DEPLOY.md` 那条「源站地址不写进仓库」照旧，
而且这个仓库要开源。想知道是哪台，`dig` 一下这个名字就有，
不必让它同时躺在 git 历史里。）

这是站长已经拍板接受的代价（见 `README.md` 的「两种拓扑」）。
想收回来就把网关搬到独立机器，只改 `SITE_URL` 和这一条 A 记录。

### ③ DMARC 报告先不要配

下面的 DMARC 记录里**不写 `rua`**。理由见最后一节 ——
简单说：写了也收不到，而一个收不到的报告地址比不写更坏。

---

## 第一步：Cloudflare 上加一条（就一条）

在 `agenticlab.sh` 这个 zone 里：

| 类型 | 名称 | 值 | 代理状态 | TTL |
|---|---|---|---|---|
| `A` | `publicmx` | 服务器 IP | **🔘 灰云 DNS only** | 自动 |

⚠️ **必须是灰云。** 橙云会让 Cloudflare 代理这个名字，
而 **Cloudflare 不代理 SMTP** —— 邮件会直接收不到，
而且 `dig` 查出来一切正常（返回的是 CF 的 IP），非常难查。

验证：

```bash
curl -s -H 'accept: application/dns-json' \
  'https://dns.google/resolve?name=publicmx.agenticlab.sh&type=A'
# 要返回你服务器的真实 IP，不是 104.x / 172.6x 这种 Cloudflare 段
```

---

## 第二步：先拿一个域名跑通

**不要一上来就批量。** 挑 `rickroll.icu`（一次性池，坏了没人受影响），
在 DNSPod 里给它加三条：

| 主机记录 | 类型 | 线路 | 值 | MX 优先级 | TTL |
|---|---|---|---|---|---|
| `@` | `MX` | 默认 | `publicmx.agenticlab.sh` | `5` | `600` |
| `@` | `TXT` | 默认 | `v=spf1 -all` | — | `600` |
| `_dmarc` | `TXT` | 默认 | `v=DMARC1; p=reject;` | — | `600` |

**TTL 先设 600（10 分钟）。** 全部跑通之后再调回 3600 ——
配错的时候 TTL 是你和「等一小时才能重试」之间唯一的东西。

然后验证：

```bash
npm run mail-dns -- rickroll.icu

# 端到端：在站点上开一个一次性箱，然后从外面发一封
swaks --to <刚开的地址> --server publicmx.agenticlab.sh
```

收到了再往下走。**这一步能挡掉九成的返工。**

---

## 第三步：批量剩下的 99 个

每个域名三条记录，值和上面**完全一样**（`@` 那两条 + `_dmarc`）。
**100 个一个不漏**，包括那 11 个商标近似的 —— 理由见下一节。

先是普通的 89 个：

```
aetherstudio agenthing ai-talkshow cjlworks codetics corvusamuse gptagent
ificanfly iseeyouin jiubeixin jokerai kizunerwe layopc lopleec lts4ai md5523
meinianda neurolancer shipowner tech10 techcheng tianzzi tripfz-jmr vistago
yigeren yintins-01 zennon niuniu869 muran jiangmuran ashipowner tripfzjmr
yintins carleight carleightwu borancui ryanzhu sunyuchen daiyu1 lay621 cjl2726
z091127 tatumisin cacinie techerng msadream qific awmcap m78ai 10kjs
unknownuserfrommars cliproxyapi tsuki seeus icubed spotme bluecat opencode
watchdog filedrop fastnote typeless canusee kandian quickview snapview visionai
deepvision quantwhale dailyplan takemyhand takemehand aicam aiclip rickroll
dontgoto icudoctor orange-public trinity3 northwind agibar
pneumonoultramicroscopicsilicovolcanoconiosis
```

外加 5 个中文域名（`余承东.icu` 也在内，它是 `admin` 那一类）：

| 在 DNSPod 里显示成 | punycode（用来核对） |
|---|---|
| `我真的特别特别特别特别特别想你.icu` | `xn--6qqw1eaaaa206xh6b9z6dbabbb595logc.icu` |
| `云上耀斑.icu` | `xn--fhqrmz20dmfy.icu` |
| `马嘉祺.icu` | `xn--w4rs83f4sw.icu` |
| `华立.icu` | `xn--xkrw23g.icu` |
| `余承东.icu` | `xn--xhqy3ag43b.icu` |

> 中文域名的**记录值仍然是 ASCII**（`mx.agenticlab.sh`），
> 只有域名本身是中文。站点那边存的是 punycode，
> 因为信封上永远是 A 标签 —— 这一条已经在代码里对齐了，你不用管。

---

## 那 11 个商标近似的：**照配，但它们进不了池子**

```
githubusercontent  huggingface  airtable  opencart  openreview  moonshot48
claudex  bilibill  dgxspark  adventurex  余承东
```

DNS 记录和别的**完全一样**（MX + SPF + DMARC）。
它们在系统里是 `kind = admin`：

| | `admin`（这 11 个） | `blocked`（现在一个都没有） |
|---|---|---|
| 配 MX | **配** | 不配 |
| 收得到信 | **收得到** | 收不到，DNS 那层就没了 |
| 普通成员能开地址 | **不能**，一个都不能 | 不能 |
| 管理员能开地址 | **能**（每次进 audit） | 不能 |

### 配 MX 换来的是什么

**看得见有人在试探。** 发到 `security@githubusercontent.icu` 的每一次投递
都会进 `mail_ingress_log`，在后台「被拒的投递」那张表上看得到 ——
而没有 MX 的话，那些尝试连痕迹都不留。

风险并没有变大：**危险的从来不是收信，是身份**
（拿这种地址去发信、去做域名所有权验证）。而发信全站默认关死，
在这些域名上开地址又只有管理员做得到、每一次都留痕。

普通成员在这些域名上开地址会被直接拒 —— 一条测试盯着这一点。

---

## 配完之后

1. 后台 `/admin/mail` 那张表上，MX / SPF / DMARC 三个灯会亮起来
   —— ⚠️ **DNS 体检任务还没做（P1）**，现在三个灯全是「还没体检过」的灰色。
   在那之前用 `npm run mail-dns` 核。
2. 把 TTL 从 600 调回 3600。
3. 抽查几个，特别是**中文域名**那 5 个和 `pneumonoultra…`（49 字符那个）。

批量核对：

```bash
npm run mail-dns          # 全部 100 个
npm run mail-dns -- tsuki.icu 华立.icu   # 只核几个
```

⚠️ **不要用 `dig`。** 很多网络（包括开发机所在的这个）对 53 端口做透明劫持：
不存在的域名会返回一个 `198.18.x.x` 的假地址，
**连 `dig @1.1.1.1` 也一样** —— 因为查询根本没出去。
所以这个脚本走 DoH（HTTPS 上的 DNS），而且**同时问 Google 和 Cloudflare**：
记录刚加、TTL 又短的时候，两家的缓存经常不同步，
只问一家会报出一堆并不存在的「缺记录」。

---

## 为什么 SPF 写 `-all` 而不是 `~all`

这批域名**一封信都不发**。`-all` 是「凡是声称从这个域名发出的，全是伪造的」，
`~all` 是「可能是伪造的，你看着办」。

不写 SPF 的后果不是「不安全」那么抽象：任何人都能用
`noreply@你的域名` 发垃圾邮件，而**收信方会把账算在这个域名头上** ——
一百个域名共用一批 IP 声誉，一个被拉黑会连累其余的。

将来某个域名真要发信了，再单独把它那条改掉。

---

## 为什么现在不配 DMARC 的 `rua`

`rua=mailto:dmarc@agenticlab.sh` 要同时满足两个条件才收得到报告，
而现在**两个都不满足**：

1. **跨域授权**。报告地址的域名（`agenticlab.sh`）和被报告的域名
   （`rickroll.icu`）不同，所以按 RFC 7489 §7.1，
   `agenticlab.sh` 必须发布一条授权记录：

   ```
   rickroll.icu._report._dmarc.agenticlab.sh   TXT   "v=DMARC1"
   ```

   一百个域名就是一百条 —— 或者一条通配：

   ```
   *._report._dmarc.agenticlab.sh   TXT   "v=DMARC1"
   ```

2. **那个信箱得真的能收信**。`agenticlab.sh` 现在**没有 MX**，
   所以 `dmarc@agenticlab.sh` 是个死地址。

两条缺一，报告就**静默地不来**，而 DNS 上明明写着它 ——
于是很容易以为「我在看着」，其实没有。

而且对这批域名来说，报告的价值本来就接近零：它们不发信，
唯一能告诉你的是「有人在伪造你的域名」。

**想开的话**，最干净的办法是把 `agenticlab.sh` 自己也放进域名池
（`kind = owned`、主人是站长），给它配 MX，然后在站内开一个 `dmarc` 别名——
等于用这套系统自己收自己的报告。那时候再：

- 后台设置 `mail.dmarc_rua` 填 `dmarc@agenticlab.sh`
- Cloudflare 加那条 `*._report._dmarc` 通配
- 一百条 DMARC 记录后面补上 ` rua=mailto:dmarc@agenticlab.sh`
