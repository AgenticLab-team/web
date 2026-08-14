import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PERMISSIONS } from "@/lib/rbac/permissions";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

import { readCode } from "./_source";

/**
 * 后台那两处「名字」的长度 —— 因为放不下的样子**看起来像排版**。
 *
 * ═════════════════════════════════════════
 * 一个被截断的标题不像信息丢失
 * ═════════════════════════════════════════
 *
 * 390px 上截图看见的：系统设置页那条
 * 「短窗口内同一 IP 可生成验证码…」——**丢掉的恰好是「次数」**，
 * 也就是这条设置到底在设什么。而且丢掉的那一半没有任何补救：
 * 值那栏只有一个数字，下面那行是英文 key，描述里写的是「防爆刷」，
 * 三处都不说它是个次数。
 *
 * 屏幕上它就是一行带省略号的标题，看起来完全正常。
 *
 * ─────────────────────────────────────────
 * 两处的处置**不一样**，因为约束不一样
 * ─────────────────────────────────────────
 *
 *   · 设置项 → **去掉截断，让它换行**。那一行下面本来就还有描述和 key，
 *     多一行不破坏任何东西。
 *   · 权限矩阵 → **保留截断，改为限制标签长度**。它在一个
 *     `sticky left-0 max-w-[13rem]` 的首列里，换行会把整张矩阵的
 *     行高顶乱，而那一列同时还是横滚时唯一的锚点。
 *
 * 所以这个文件的两组断言方向也不一样：一组管「别再截断」，
 * 一组管「别写放不下的标签」。
 */

/** 按码点数。`.length` 会把 emoji 数成两个 */
const chars = (s: string) => [...s].length;

describe("**设置项的标题不许截断**", () => {
  it("SettingRow 里那个标签没有 truncate", () => {
    /*
     * 用 readCode（去注释）：那一行上面的注释里正写着 `truncate`
     * 这个词在解释为什么去掉它。
     */
    const code = readCode("components/admin/SettingRow.tsx");
    const start = code.indexOf("row.label ?? row.key");
    assert.notEqual(start, -1, "找不到标签那一行了");
    // 往前找到包着它的那个标签开头
    const open = code.lastIndexOf("<span", start);
    const tag = code.slice(open, start);
    assert.equal(
      tag.includes("truncate"),
      false,
      "设置项标题又被截断了 —— 那一行就是这条设置的全部意思",
    );
  });

  it("**换行的前提是标题本来就短** —— 长到离谱就该改名，不是靠换行兜", () => {
    /*
     * 去掉截断之后，长标题的后果从「看不见」变成「占好几行」。
     * 后者不算坏，但也有个限度。库里 78 条设置最长 21 字、中位数 10 字，
     * 也就是最多两行 —— 这条断言把那个前提钉住。
     *
     * 30 字是「两行还能收住」的位置，不是精确排版计算：
     * 需要精调的阈值说明这件事本来就不该靠阈值管。
     */
    const long = DEFAULT_SETTINGS.filter((s) => s.label && chars(s.label) > 30).map(
      (s) => `${s.key}（${chars(s.label!)} 字）`,
    );
    assert.deepEqual(long, [], `这些设置项的名字太长了：${long.join("、")}`);
  });
});

describe("**权限点的名字要放得进那一列**", () => {
  /*
   * 首列是 `max-w-[13rem]`（208px），减去 `px-3` 的两侧内边距还剩 184px。
   * `t-subhead` 是 15px，汉字大致等宽，也就是**放得下 12 个字左右**。
   *
   * 这不是精确排版计算 —— 字体是设备自己的（见 tests/client-ip 那边
   * 同一条教训）。它是一条**留余量的上界**：12 字以内在任何中文字体下
   * 都进得去，超了就该换个说法，而不是让它悄悄少半句。
   */
  const LIMIT = 12;

  it(`没有超过 ${LIMIT} 个字的权限点名字`, () => {
    const long = PERMISSIONS.filter((p) => chars(p.label) > LIMIT).map(
      (p) => `${p.key}（${chars(p.label)} 字：${p.label}）`,
    );
    assert.deepEqual(
      long,
      [],
      `这些名字在手机上会被截掉尾巴：\n  ${long.join("\n  ")}\n` +
        `细节写进 description 那一栏 —— 它在下面一行，是会换行的`,
    );
  });

  it("**首列仍然是粘住的** —— 横滚时它是唯一的锚点", () => {
    /*
     * 这一条和上面那条是一对：限制长度的前提是「这一列窄」，
     * 而这一列窄的前提是「它粘着」。粘性没了的话，
     * 滚到右边看『封禁』那列时，行首的名字整个滚出屏幕 ——
     * 于是你在给一个不知道是什么的权限打勾。
     */
    const code = readCode("components/admin/MatrixEditor.tsx");
    assert.match(code, /sticky left-0[^"]*max-w-\[13rem\]|max-w-\[13rem\][^"]*sticky left-0/);
  });

  it("描述那一栏没有长度限制 —— 细节该去那儿", () => {
    // 上面那条的出口。没有出口的限制会逼人把话说得含糊
    const longest = Math.max(
      ...PERMISSIONS.map((p) => chars((p as { description?: string }).description ?? "")),
    );
    assert.ok(longest > LIMIT * 2, `描述最长才 ${longest} 字，八成没人往那儿写`);
  });
});
