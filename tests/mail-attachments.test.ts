import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIN_LEVEL,
  ATTACHMENT_QUOTA_BYTES,
  explainSkip,
  shouldStore,
} from "@/lib/mail/attachment-rules";

import { readCode } from "./_source";

/**
 * 附件存不存 —— **默认不存，这是设计不是省事**。
 *
 * 九成的临时邮件里那个附件没人会点开，而附件是这套东西里唯一
 * 真正吃盘的部分。所以门开得很小：够等级、够小、有配额。
 */

const ok = { level: 9, size: 1024, hasContent: true, usedBytes: 0 };

describe("**三道门，各防各的**", () => {
  it("样样都够就存", () => {
    assert.equal(shouldStore(ok).store, true);
  });

  it("**等级不够就不存** —— 磁盘不卖钱，只按等级给", () => {
    /*
     * MAIL.md 四节那条：最贵的资源是磁盘，所以「能不能落盘」放在等级上
     * 而不是积分上 —— 用积分买磁盘意味着有人可以一次性买爆磁盘。
     */
    const v = shouldStore({ ...ok, level: ATTACHMENT_MIN_LEVEL - 1 });
    assert.equal(v.store, false);
    assert.equal(v.reason, "level");
  });

  it("太大的不存", () => {
    const v = shouldStore({ ...ok, size: ATTACHMENT_MAX_BYTES + 1 });
    assert.equal(v.reason, "too_big");
  });

  it("**配额满了不存**", () => {
    const v = shouldStore({ ...ok, size: 1024, usedBytes: ATTACHMENT_QUOTA_BYTES });
    assert.equal(v.reason, "quota");
  });

  it("**先说他改变不了的** —— 等级排在大小和配额前面", () => {
    /*
     * 三样都不满足时先说等级：那是他今天无论如何都改变不了的。
     * 先说配额的话，他删了一堆旧信腾出空间，然后才发现等级也不够。
     */
    const v = shouldStore({
      level: 1,
      size: ATTACHMENT_MAX_BYTES + 1,
      hasContent: true,
      usedBytes: ATTACHMENT_QUOTA_BYTES,
    });
    assert.equal(v.reason, "level");
  });

  it("**配额排在最后** —— 它是唯一一个他清一清就能腾出来的", () => {
    const v = shouldStore({ ...ok, size: 1024, usedBytes: ATTACHMENT_QUOTA_BYTES });
    assert.equal(v.reason, "quota");
  });

  it("老网关没传内容时也不报错，只是不存", () => {
    /*
     * 协议里加字段不用 +1（`protocol.ts` 那条），老网关不发 `content`。
     * 那一段时间里信照收，只是附件只留元信息。
     */
    const v = shouldStore({ ...ok, hasContent: false });
    assert.equal(v.store, false);
    assert.equal(v.reason, "no_content");
  });

  it("**每一种「没存」都说得出为什么**，而且都带数字或等级", () => {
    for (const r of ["level", "too_big", "quota", "no_content"] as const) {
      const text = explainSkip(r);
      assert.ok(text.length > 6, `${r} 的说法太短`);
    }
    // 三种「能改变」的都要给出具体的量
    for (const r of ["level", "too_big", "quota"] as const) {
      assert.match(explainSkip(r), /\d/, `${r} 没给数字`);
    }
  });
});

describe("**存进库里，不落盘 —— 而这是刻意偏离原设计**", () => {
  const schema = readCode("lib/db/schema/mail.ts");

  it("附件内容是 blob 列", () => {
    /*
     * 原设计是落盘 + 记 path。改成 BLOB 的两个理由：
     *
     *  ① 备份只覆盖数据库文件 —— 落盘的话，一次机器故障之后
     *     数据库回来了、附件没了，而「恢复成功但少了东西」最难发现
     *  ② 删除路径有四条（正文到期、宽限期满、账号注销、后台收回），
     *     落盘意味着每条都要配一次 unlink。漏一条 = 别人的私人附件
     *     永远留在盘上，而磁盘上多几个文件没有任何症状
     */
    assert.match(schema, /content: blob\("content"\)/);
  });

  it("**`path` 那一列还在但恒为 null** —— 删列要重建表，不值得", () => {
    // 这个仓库为「重建表的迁移」交过学费，见 drizzle 里那次 0059
    assert.match(schema, /path: text\("path"\)/);
  });
});

describe("**附件和信在同一个事务里**", () => {
  it("插附件那几行在 db.transaction 里面", () => {
    /*
     * 分开写的话，中间失败一次就会出现「信在、附件不在」——
     * 而界面上那封信会显示成「有附件」然后什么都点不开，
     * 一个没有任何地方能解释的状态。
     */
    const code = readCode("lib/mail/ingest.ts");
    const txStart = code.indexOf("db.transaction((tx)");
    const insertAt = code.indexOf("tx.insert(mailAttachments)");
    assert.notEqual(txStart, -1, "找不到那个事务了");
    assert.ok(insertAt > txStart, "插附件跑到事务外面去了");
  });

  it("**配额边写边加** —— 否则五个 1.9M 的附件会一起通过", () => {
    const code = readCode("lib/mail/ingest.ts");
    assert.match(code, /if \(verdict\.store\) used \+= a\.size/);
  });

  it("**用量按人算，不按箱子算**", () => {
    /*
     * 一个人开十个箱子不该有十份配额 —— 磁盘是全站共用的那一份。
     */
    const code = readCode("lib/mail/ingest.ts");
    const fn = code.slice(code.indexOf("function attachmentUsage"));
    assert.match(fn.slice(0, 700), /mailBoxes\.userId/);
  });
});

describe("**网关只传够小的**", () => {
  const gw = readCode("../ops/mail-gateway/gateway.mjs");

  it("有上限，而且判的是原始字节不是 base64 之后的", () => {
    /*
     * base64 会把体积撑大三分之一。判 base64 之后的长度的话，
     * 一个 1.6M 的附件会被算成 2.1M 而被丢掉。
     */
    assert.match(gw, /ATTACHMENT_MAX_BYTES/);
    assert.match(gw, /size <= ATTACHMENT_MAX_BYTES/);
  });
});

describe("**下载：存了就要取得出来，而且不能在我们的域名下执行**", () => {
  const v1 = readCode("app/api/v1/mail/attachments/[id]/route.ts");
  const web = readCode("app/api/mail/attachments/[id]/route.ts");

  it("两条路都走同一个 readAttachment —— 归属校验只有一份", () => {
    /*
     * 各写一遍的话，漏判的方向永远是「把别人的附件给出去」，
     * 而附件比正文更糟：正文里的验证码几分钟就失效了，
     * 而一个附件可能是一份合同、一张身份证照片。
     */
    for (const [name, code] of [["v1", v1], ["网页", web]] as const) {
      assert.match(code, /readAttachment\(/, `${name} 那条没走 readAttachment`);
      assert.equal(
        /from\(mailAttachments\)/.test(code),
        false,
        `${name} 那条自己查了库 —— 校验就有了第二份`,
      );
    }
  });

  it("**一律强制下载，永远不内联**", () => {
    /*
     * 这是一份陌生人发来的文件。让浏览器内联渲染它意味着一个
     * `text/html` 的附件会**在我们的域名下执行** ——
     * 那是一个现成的 XSS，而且带着用户的会话 cookie。
     */
    for (const [name, code] of [["v1", v1], ["网页", web]] as const) {
      assert.match(code, /attachment; filename=/, `${name} 没强制下载`);
      assert.equal(/inline/.test(code), false, `${name} 里出现了 inline`);
    }
  });

  it("**不照抄发件人写的 mime**", () => {
    /*
     * 信任发件人声明的类型，等于让他决定浏览器怎么处理这个文件。
     */
    for (const [name, code] of [["v1", v1], ["网页", web]] as const) {
      assert.match(code, /application\/octet-stream/, `${name} 没用 octet-stream`);
      assert.equal(
        /"Content-Type": file\.mime/.test(code),
        false,
        `${name} 照抄了发件人的 mime`,
      );
    }
  });

  it("文件名做了转义 —— 一个带引号的名字能把这个头拆成两半", () => {
    for (const [name, code] of [["v1", v1], ["网页", web]] as const) {
      assert.match(code, /file\.filename\.replace\(/, `${name} 没转义文件名`);
    }
  });

  it("**不许被缓存** —— 附件是私人内容", () => {
    for (const [name, code] of [["v1", v1], ["网页", web]] as const) {
      assert.match(code, /private, no-store/, `${name} 没禁缓存`);
    }
  });

  it("`nosniff` 是双保险 —— 即便哪天有人把 disposition 改回 inline", () => {
    for (const code of [v1, web]) {
      assert.match(code, /X-Content-Type-Options/);
    }
  });

  it("**界面上「已保存」要给得出文件**", () => {
    /*
     * 只显示「已保存」而没有入口的话，那句话等于在描述我们自己的
     * 内部状态 —— 而用户要的是那个文件。
     */
    const ui = readCode("components/mail/BurnerScreen.tsx");
    assert.match(ui, /\/api\/mail\/attachments\//, "界面上没有下载入口");
  });
});
