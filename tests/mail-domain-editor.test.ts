import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAIL_DOMAIN_KIND_LABEL, MAIL_DOMAIN_KINDS } from "@/lib/mail/kinds";

import { readCode } from "./_source";

/**
 * 域名编辑器 —— **它预告的连带效果必须是真的**。
 *
 * ═════════════════════════════════════════
 * 这里有两份同样的逻辑，而它们必须一致
 * ═════════════════════════════════════════
 *
 * `updateDomain` 里有一串刻意的连带：改成靓号池就强制关掉一次性箱、
 * 改成封禁就把收信相关的全关、离开靓号池就清掉档位。
 *
 * 那些连带是对的 —— 靠人记得手动关迟早会忘一次，而忘掉的后果是
 * 「你花 400 分买的地址，因为别人在同一个域名上注册了一百个账号
 * 而被某个网站拒收」。
 *
 * 但**不告诉他就发生**是另一回事，所以编辑器在按钮上方预告了一遍。
 * 于是同一套规则有了第二份实现 —— 而第二份迟早和第一份分叉。
 *
 * 分叉的方向特别坏：预告说「会关掉一次性箱」，实际没关（或者反过来）。
 * 前者让人以为自己关了，后者让人以为自己没关 ——
 * **两种都比没有预告糟**，因为他现在是照着一句假话在做决定。
 *
 * 所以这一组把两边的规则各抠出来对一遍。
 */

const action = readCode("lib/mail/admin-actions.ts");
const editor = readCode("components/admin/DomainEditor.tsx");

/** `updateDomain` 里那段连带逻辑 */
const cascadeBlock = (() => {
  const start = action.indexOf("export async function updateDomain");
  assert.notEqual(start, -1, "找不到 updateDomain 了");
  return action.slice(start, action.indexOf("\nexport ", start + 1));
})();

describe("**改成靓号池会强制关掉一次性箱，而界面要先说**", () => {
  it("动作层确实这么做", () => {
    assert.match(cascadeBlock, /kind === "reserved"[\s\S]{0,80}allowBurner = false/);
  });

  it("界面预告里提到了它", () => {
    assert.match(editor, /kind === "reserved"[\s\S]{0,120}一次性箱/);
  });
});

describe("**改成封禁会把收信相关的全关掉**", () => {
  /*
   * 封禁那一档连 MX 都不配，所以「能开一次性箱」「能被申领」
   * 「收所有前缀」「进随机轮换」全部没有意义 —— 留着它们开着，
   * 后台上会显示一个「能被申领的封禁域名」，一句自相矛盾的话。
   */
  for (const field of ["allowBurner", "allowClaim", "catchAll", "inRandomRotation"]) {
    it(`动作层关掉了 ${field}`, () => {
      const blocked = cascadeBlock.slice(cascadeBlock.indexOf('kind === "blocked"'));
      assert.match(blocked.slice(0, 400), new RegExp(`${field} = false`));
    });
  }

  it("界面把这四条都预告了", () => {
    const blocked = editor.slice(editor.indexOf('kind === "blocked"'));
    for (const word of ["一次性箱", "申领", "所有前缀", "随机轮换"]) {
      assert.match(blocked.slice(0, 600), new RegExp(word), `预告里没提「${word}」`);
    }
  });
});

describe("**离开靓号池要清掉档位**", () => {
  it("动作层清了", () => {
    assert.match(cascadeBlock, /kind !== "reserved"[\s\S]{0,60}tier = null/);
  });

  it("界面预告了", () => {
    assert.match(editor, /kind !== "reserved"[\s\S]{0,120}档/);
  });
});

describe("**五个类型每一个都要有一句人话**", () => {
  /*
   * `admin` 和 `blocked` 长得最像而差别最大：两者都不进公共池，
   * 但前者**收信**（所以看得见有人在试探），后者连 MX 都不配。
   *
   * 只写类型名的话没有人分得清，于是这两个会被随手选错 ——
   * 而选错 `blocked` 的后果是我们对那个商标域名上的钓鱼尝试一无所知。
   */
  it("中文名和说明都覆盖了全部五个", () => {
    for (const kind of MAIL_DOMAIN_KINDS) {
      assert.ok(
        MAIL_DOMAIN_KIND_LABEL[kind],
        `${kind} 没有中文名 —— 下拉框里会出现一个光秃秃的英文单词`,
      );
      assert.match(
        editor,
        new RegExp(`\\b${kind}:\\s*"`),
        `${kind} 在 KIND_HINT 里没有说明`,
      );
    }
  });

  it("**中文名只有一份** —— 后台列表和编辑器不许各写各的", () => {
    /*
     * 原来两处各一份，措辞还不一样（「有主」对「有主域名」、
     * 「一次性池」对「一次性箱池」）—— 同一页上同一个东西两个叫法，
     * 读的人会以为那是两种不同的类型。
     */
    const page = readCode("app/(app)/admin/mail/page.tsx");
    assert.match(page, /MAIL_DOMAIN_KIND_LABEL/, "后台列表又自己写了一份中文名");
    assert.equal(
      /owned:\s*"/.test(page),
      false,
      "后台列表里还留着写死的类型名",
    );
  });

  it("**admin 和 blocked 的说明要说出「收不收信」这个差别**", () => {
    const hints = editor.slice(editor.indexOf("const KIND_HINT"), editor.indexOf("export interface"));
    assert.match(hints, /admin:[^\n]*收/, "admin 那条没说它收信");
    assert.match(hints, /blocked:[^\n]*MX/, "blocked 那条没说它连 MX 都不配");
  });
});

describe("**编辑器要能拿到全部初值**", () => {
  it("listDomains 带上了四个开关", () => {
    /*
     * 少了初值的编辑器最坏的形态不是报错，是**它把没显示的字段
     * 按默认值写回去** —— 一次保存顺手关掉了 catchAll，
     * 而屏幕上从头到尾没出现过这个词。
     */
    const q = readCode("lib/mail/admin-queries.ts");
    for (const f of ["allowBurner", "allowClaim", "allowCustomLocal", "inRandomRotation", "catchAll"]) {
      assert.match(q, new RegExp(`${f}:\\s*d\\.${f}`), `listDomains 没返回 ${f}`);
    }
  });

  it("候选人只列绑了微信的 —— 域名归属要认得到人", () => {
    const q = readCode("lib/mail/admin-queries.ts");
    const fn = q.slice(q.indexOf("export function domainOwnerCandidates"));
    assert.match(fn, /isNotNull\(users\.wxId\)/);
  });

  it("**名字绝不退化成 wx_id**", () => {
    // 全站都不许破的那条线
    const q = readCode("lib/mail/admin-queries.ts");
    const fn = q.slice(q.indexOf("export function domainOwnerCandidates"));
    assert.equal(/wxId/.test(fn.replace(/isNotNull\(users\.wxId\)/g, "")), false);
  });
});
