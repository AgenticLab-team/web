import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { srcRoot, walkSource } from "./_source";

/**
 * 仓库里不许出现真实的群号和微信号。
 *
 * ═════════════════════════════════════════
 * 这条守卫是被三轮漏网催生的
 * ═════════════════════════════════════════
 *
 * 开源前扫历史，第一轮清掉 5 个值；第二轮又发现 3 个真实群号
 * （其中「Deepthink x 厦门大学社区」是别人办的实名社区）；
 * 第三轮再发现 3 个（「老陈的密友群」同样是别人的）。
 *
 * 三轮都是**靠人眼看出来的** —— 而人眼的问题是它每次只看见
 * 自己正在找的那一类。所以这里改成：**把所有长得像群号的值全部列出来，
 * 逐个对照一份「一眼看得出是编的」白名单**。
 *
 * 群号属于隐私（站长定的口径：「群列表属于隐私」），
 * 而且它们连着的群有一半不是我们的。一旦推上公开仓库，
 * 删掉也没用 —— 历史里还在。
 *
 * ─────────────────────────────────────────
 * 白名单是「形状」，不是一张名单
 * ─────────────────────────────────────────
 *
 * 列一张具体值的名单，每加一个占位就要来改一次，
 * 而改它的人多半会顺手把真值也加进去。
 * 认形状就没有这个问题：`1000000000x` / `2000000000x` 这种
 * 一眼看得出是编的，真微信群号不会长这样。
 */

/** 一眼看得出是编的：以 1000000000 / 2000000000 开头 */
const FAKE_CONV = /^[12]000000000\d@chatroom$/;

/** 编的微信号：带 example / test / abc123 这类词 */
const FAKE_WXID = /^wxid_(?:example|test|abc123|applicant|comeback|nameless|poisoned)/;

describe("**不许有真实标识符**", () => {
  const files = [
    ...walkSource(srcRoot()),
    ...["README.md", "CONTRIBUTING.md", "ARCHITECTURE.md", "PERMISSIONS.md", "MODULES.md",
        "SCHEMA.md", "FORUM.md", "ECONOMY.md", "DEPLOY.md", "ROADMAP.md", "DONE.md",
        "LESSONS.md", "IDEAS.md", "STATUS.md"]
      .map((f) => new URL(`../${f}`, import.meta.url).pathname),
  ];

  function scan(pattern: RegExp): { value: string; file: string }[] {
    const out: { value: string; file: string }[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue; // 那份文档可能还不存在
      }
      for (const m of text.matchAll(pattern)) out.push({ value: m[0], file: f });
    }
    return out;
  }

  it("**没有真实群号**", () => {
    const bad = scan(/[0-9]{9,}@chatroom/g).filter((h) => !FAKE_CONV.test(h.value));
    assert.deepEqual(
      [...new Set(bad.map((h) => `${h.value} (${h.file.split("/").slice(-2).join("/")})`))],
      [],
      "群号属于隐私，而且有一半不是我们的群。用 1000000001@chatroom 这种编的",
    );
  });

  it("**没有真实微信号**", () => {
    const bad = scan(/wxid_[a-z0-9]{8,}/g).filter((h) => !FAKE_WXID.test(h.value));
    assert.deepEqual(
      [...new Set(bad.map((h) => `${h.value} (${h.file.split("/").slice(-2).join("/")})`))],
      [],
      "用 wxid_examplemember01 这种编的",
    );
  });

  it("**没有源站地址** —— 这套防护唯一的前提就是没人知道它", () => {
    /*
     * 站点在 Cloudflare 后面、源站只对 CF 网段开放。
     * 地址一旦公开，绕过 CF 直击源站的成本从「不可能」变成「读一遍 git log」。
     */
    const bad = scan(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g).filter(
      (h) =>
        !/^(?:127\.|0\.0\.0\.0|255\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|1\.1\.1\.1|8\.8\.8\.8)/.test(
          h.value,
        ) && !/^\d+\.\d+\.\d+\.\d+$/.test(h.value.replace(/\d+/g, (n) => (Number(n) > 255 ? "x" : n))),
    );
    assert.deepEqual([...new Set(bad.map((h) => h.value))], []);
  });
});
