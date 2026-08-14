#!/usr/bin/env node
/**
 * SMTP 收信网关。**一个独立的进程，不是站点的一部分。**
 *
 * ═════════════════════════════════════════
 * 它和站点之间只有一条线：HTTPS + HMAC
 * ═════════════════════════════════════════
 *
 * 它不连数据库、不 import 站点的任何代码、不共享进程。
 * 两者之间只有三个 HTTP 调用（拉路由表、查地址、投递），
 * 全部签名，全部带协议版本号。
 *
 * 这样拆开的代价是多写了一个服务，买到的是**部署拓扑可以随时改**：
 *
 *   ① 同机（现在）—— 都跑在源站上，`SITE_URL=http://127.0.0.1:3000`。
 *      不走 nginx、不走 Cloudflare，投递就是一次本地回环。
 *      ⚠ 但 MX 记录会公开源站 IP，见 README 里那一段。
 *
 *   ② 分机（以后）—— 网关搬到独立机器，`SITE_URL=https://agenticlab.sh`，
 *      经 Cloudflare 回来。源站 IP 重新藏起来。
 *
 *   ③ 多机（更以后）—— 好几台网关，MX 多条记录分优先级。
 *      网关本身**不存任何状态**（路由表是缓存，地址查询是缓存），
 *      所以加一台就是再跑一个进程，不用改站点。
 *
 * 从①到③不用改一行代码，只改环境变量和 DNS —— 这是拆开的全部意义。
 *
 * ═════════════════════════════════════════
 * 一条不能破的规矩：不认识的地址在 RCPT 阶段就拒
 * ═════════════════════════════════════════
 *
 * 收下来再退信会让我们变成**退信轰炸的帮凶** ——
 * 垃圾邮件的发件人几乎都是伪造的，我们退回去的每一封
 * 都砸在一个无辜的邮箱上。这也是被列进黑名单最快的一条路。
 *
 * 用法：
 *   MAIL_INGRESS_SECRET=... SITE_URL=http://127.0.0.1:3000 node gateway.mjs
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

/**
 * 线上协议版本，必须和站点的 `src/lib/mail/protocol.ts` 对得上。
 *
 * 网关和站点是两个独立部署的东西 —— 今天在同一台机器上，
 * 明天网关可能搬到别的机房、甚至变成好几台。那时候
 * **两边的版本必然会有一段不一致的时间**（站点先升，网关还是上周那份）。
 *
 * 没有这个数字的话，字段改名的表现是「有些信收不到、有些能收到」，
 * 而两边日志都显示一切正常。
 */
const PROTOCOL = 1;

const SECRET = required("MAIL_INGRESS_SECRET");
const SITE = (process.env.SITE_URL ?? "https://agenticlab.sh").replace(/\/$/, "");

/**
 * 单个附件最大多少字节才带内容过去。
 *
 * ⚠️ 要和站点的 `lib/mail/attachment-rules.ts` 里那个数对得上。
 * 两处各写一份是因为网关**不 import 站点的任何代码**（见 README）——
 * 而这个数写错的方向是不对称的：这边传了那边不收，浪费的只是带宽；
 * 这边不传那边想收，那是功能缺失。所以宁可这边略宽。
 */
const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
const PORT = Number(process.env.SMTP_PORT ?? 25);
const MAX_BYTES = Number(process.env.MAX_MESSAGE_BYTES ?? 2 * 1024 * 1024);
const SNAPSHOT_MS = Number(process.env.SNAPSHOT_REFRESH_MS ?? 60_000);

/** STARTTLS 用的证书。不配就明文收 —— 见下面那段 */
const TLS_KEY = process.env.TLS_KEY_PATH;
const TLS_CERT = process.env.TLS_CERT_PATH;

function required(name) {
  const value = process.env[name];
  if (!value) {
    // 缺密钥时**不启动**：启动了也只会把每一封信推给一个会拒绝它的接口
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return value;
}

/* ── 路由表 ────────────────────────────────────────────────
 *
 * 每分钟拉一次「哪些域名收信」。绝大多数垃圾投递在这一层就被拒了：
 * 域名不在名单上，连一次 HTTPS 都不用打。
 */
let snapshot = { domains: new Map(), at: 0 };

async function refreshSnapshot() {
  try {
    const res = await fetch(`${SITE}/api/mail/routes`, {
      headers: { authorization: `Bearer ${SECRET}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    snapshot = {
      domains: new Map(data.domains.map((d) => [d.punycode, d.catchAll])),
      at: Date.now(),
    };
    console.log(`[routes] ${snapshot.domains.size} 个域名`);
  } catch (error) {
    /*
     * 拉不到就**继续用手上那份旧的**，不清空。
     *
     * 清空的话，站点一次几分钟的重启会让网关在这期间
     * 拒收所有的信 —— 而那些信不会重投第二次的居多。
     * 一份旧名单最坏的后果是收下一封本该拒的信，
     * 那比拒掉一批本该收的信轻得多。
     */
    console.error(`[routes] 刷新失败，继续用 ${Math.round((Date.now() - snapshot.at) / 1000)}s 前那份：${error.message}`);
  }
}

/* ── 单地址查询 ────────────────────────────────────────────
 *
 * 快照只到域名这一层。具体地址要现问 —— 主要是**刚开出来的
 * 一次性箱**：用户开完就去点「发送验证码」，等不了下一次刷新。
 *
 * 结果缓存 30 秒，正负都缓存：一次字典扫描会对同一个域名
 * 试几千个地址，每个都打一次 HTTPS 的话，先倒下的是我们自己。
 */
const addressCache = new Map();
const ADDRESS_TTL_MS = 30_000;

async function deliverable(address) {
  const hit = addressCache.get(address);
  if (hit && Date.now() - hit.at < ADDRESS_TTL_MS) return hit.ok;

  try {
    const res = await fetch(`${SITE}/api/mail/routes?address=${encodeURIComponent(address)}`, {
      headers: { authorization: `Bearer ${SECRET}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    addressCache.set(address, { ok: Boolean(data.deliverable), at: Date.now() });
    return Boolean(data.deliverable);
  } catch (error) {
    /*
     * 问不到时**收下**（返回 true），不拒。
     *
     * 站点短暂不可用不是发信人的错，而拒信是不可撤销的：
     * 发件人收到一封「此地址不存在」之后不会再试。
     * 收下来的话最坏是落地时被 /api/mail/inbound 判成 rejected，
     * 那一层有完整的留痕，事后查得到。
     */
    console.error(`[rcpt] ${address} 查不到，先收下：${error.message}`);
    return true;
  }
}

/* ── 每 IP 限流 ────────────────────────────────────────────
 *
 * 只挡住明显的洪水。真正的反垃圾交给 rspamd（见 README），
 * 这里不做内容判定 —— 在 SMTP 会话里做重活会拖垮整个监听。
 */
const connections = new Map();
const CONN_WINDOW_MS = 60_000;
const CONN_LIMIT = Number(process.env.CONN_PER_MINUTE ?? 60);

function overConnectionLimit(ip) {
  const now = Date.now();
  const list = (connections.get(ip) ?? []).filter((t) => now - t < CONN_WINDOW_MS);
  list.push(now);
  connections.set(ip, list);
  return list.length > CONN_LIMIT;
}

// 别让这张表无限长下去
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of connections) {
    if (list.every((t) => now - t > CONN_WINDOW_MS)) connections.delete(ip);
  }
  for (const [addr, entry] of addressCache) {
    if (now - entry.at > ADDRESS_TTL_MS) addressCache.delete(addr);
  }
}, 60_000).unref();

/* ── 投递给站点 ───────────────────────────────────────────── */

async function push(payload, sourceIp) {
  // 版本号放最前面 —— 站点解析失败时，截断的日志里也能看到它
  const body = JSON.stringify({ protocol: PROTOCOL, ...payload });
  const signature = createHmac("sha256", SECRET).update(body).digest("hex");

  const res = await fetch(`${SITE}/api/mail/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mail-signature": signature,
      "x-mail-source-ip": sourceIp ?? "",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });

  /*
   * 4xx 和 5xx 要分开对待。
   *
   * 5xx = 站点自己出问题了，**值得重投**（我们回 451，发信方几分钟后再来）。
   * 4xx = 站点认为这个请求本身有毛病 —— 协议版本对不上、签名错、
   *       请求体不成形。**重投一百次结果一样**，所以不能让它变成
   *       一封在队列里来回撞几天的信；直接抛一个带标记的错，
   *       上层会回 550 并把原因打进日志。
   */
  if (res.status >= 400 && res.status < 500) {
    const detail = await res.text().catch(() => "");
    const error = new Error(`站点拒绝了这次投递（${res.status}）：${detail.slice(0, 200)}`);
    error.permanent = true;
    throw error;
  }
  if (!res.ok) throw new Error(`站点返回 ${res.status}`);
  return res.json();
}

/* ── SMTP ─────────────────────────────────────────────────── */

const tls =
  TLS_KEY && TLS_CERT
    ? { key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) }
    : {};

if (!TLS_KEY || !TLS_CERT) {
  /*
   * 没有证书也照常跑，但要吵一句。
   *
   * 大多数发信方在没有 STARTTLS 时会降级成明文继续投递，
   * 所以缺证书不会「收不到信」—— 它只会让每一封信在路上是明文的，
   * 而**没有任何地方会显示这件事**。
   */
  console.warn("[tls] 没配证书，STARTTLS 不可用 —— 邮件在路上是明文的");
}

const server = new SMTPServer({
  ...tls,
  // 只收信，不做中继：任何人都能连，但只能投给我们自己的域名
  authOptional: true,
  disabledCommands: ["AUTH"],
  size: MAX_BYTES,
  banner: "agenticlab mail gateway",

  onConnect(session, callback) {
    if (overConnectionLimit(session.remoteAddress)) {
      return callback(new Error("421 连接过于频繁，稍后再试"));
    }
    callback();
  },

  async onRcptTo(address, session, callback) {
    const to = address.address.toLowerCase();
    const at = to.lastIndexOf("@");
    const domain = at > 0 ? to.slice(at + 1) : "";

    if (!snapshot.domains.has(domain)) {
      /*
       * 域名不认识 —— **550，永久拒绝**。
       *
       * 用 5xx 而不是 4xx：4xx 是「等会儿再来」，
       * 发信方会重试好几天，而答案永远一样。
       */
      return callback(new Error("550 5.1.2 这个域名不在这里收信"));
    }

    if (await deliverable(to)) return callback();

    callback(new Error("550 5.1.1 这个地址不存在"));
  },

  onData(stream, session, callback) {
    const chunks = [];
    let size = 0;
    let tooBig = false;

    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) tooBig = true;
      // 超了还要把流读完 —— 提前断开会让对方一直重投同一封
      if (!tooBig) chunks.push(chunk);
    });

    stream.on("end", async () => {
      if (tooBig) return callback(new Error("552 5.3.4 邮件太大"));

      try {
        const raw = Buffer.concat(chunks);
        const parsed = await simpleParser(raw);

        /*
         * 一封信可能有多个收件人（RCPT 可以来好几次），
         * 而它们可能属于不同的人 —— 逐个投，各自落各自的箱子。
         */
        for (const rcpt of session.envelope.rcptTo) {
          await push(
            {
              envelopeFrom: session.envelope.mailFrom?.address ?? "",
              envelopeTo: rcpt.address.toLowerCase(),
              rfcMessageId: parsed.messageId ?? null,
              inReplyTo: parsed.inReplyTo ?? null,
              from: parsed.from?.value?.[0]?.address ?? null,
              fromName: parsed.from?.value?.[0]?.name ?? null,
              subject: parsed.subject ?? null,
              text: parsed.text ?? null,
              html: typeof parsed.html === "string" ? parsed.html : null,
              size: raw.length,
              /*
               * 附件：**够小的才带内容**。
               *
               * 站点那边的上限是单个 2M（`attachment-rules.ts`），
               * 超了它也只会记元信息 —— 那就别在网络上白传一趟。
               * 这里的数要和站点那个对得上；对不上的方向如果是
               * 「这边传了、那边不收」，代价只是浪费带宽；
               * 反过来「这边不传、那边想收」才是功能缺失，
               * 所以宁可这边略宽一点。
               *
               * base64 会把体积撑大三分之一，所以判的是原始字节数。
               */
              attachments: (parsed.attachments ?? []).map((a) => {
                const size = a.size ?? a.content?.length ?? 0;
                return {
                  filename: a.filename ?? "(未命名)",
                  mime: a.contentType ?? null,
                  size,
                  content:
                    a.content && size > 0 && size <= ATTACHMENT_MAX_BYTES
                      ? a.content.toString("base64")
                      : null,
                };
              }),
            },
            session.remoteAddress,
          );
        }

        callback();
      } catch (error) {
        /*
         * 推不上去 —— 回 **451（临时失败）**，让对方重投。
         *
         * 回 5xx 的话这封信就永远没了，而问题多半在我们这边
         * （站点重启、网络抖动）。站点那一侧对同一个
         * Message-ID 有去重，重投不会存两份。
         */
        if (error.permanent) {
          /*
           * 站点明确说这次请求有毛病（多半是协议版本对不上）。
           * 重投解决不了，所以给一个永久失败 —— 但**日志要吵**，
           * 因为这通常意味着网关该升级了，而没有别的地方会说这件事。
           */
          console.error(`[data] ★ 永久失败，多半是网关该升级了：${error.message}`);
          return callback(new Error("550 5.5.0 网关与站点协议不匹配"));
        }
        console.error(`[data] 投递失败：${error.message}`);
        callback(new Error("451 4.3.0 暂时收不了，请稍后重投"));
      }
    });

    stream.on("error", (error) => callback(error));
  },
});

server.on("error", (error) => console.error(`[smtp] ${error.message}`));

await refreshSnapshot();
setInterval(refreshSnapshot, SNAPSHOT_MS).unref();

server.listen(PORT, () => console.log(`[smtp] 监听 ${PORT}，站点 ${SITE}`));
