import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ALL_ADMIN_ITEMS } from "@/lib/admin/nav";
import {
  MODULES,
  STATUS_LABELS,
  dependentsOf,
  findDependencyCycles,
  moduleByKey,
  resolveStates,
  statusTone,
} from "@/lib/modules/registry";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

/**
 * 模块开关。
 *
 * ─────────────────────────────────────────
 * 这个文件存在的唯一理由
 * ─────────────────────────────────────────
 *
 * 这个项目里已经出现过两次「开关不接线」：
 * `notification_prefs` 建好了表没人读，「立即同步」排了队没人消费。
 * 两次的表现都一样 —— 界面上一切正常，用户以为自己做了什么，
 * 而系统的行为一点没变。
 *
 * 所以下面第一组测试**读源码**，核对每个模块声明的判定点
 * 真的引用了 `isModuleEnabled`。声明得再好看，代码里没读就是没关。
 */

function readSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("**开关必须真的关得掉某样东西**", () => {
  it("每个可关闭的模块都声明了判定点", () => {
    for (const spec of MODULES) {
      if (spec.lockedOn) continue;
      assert.ok(
        spec.enforcedIn.length > 0,
        `${spec.key} 没有声明 enforcedIn —— 这个开关关不掉任何东西`,
      );
    }
  });

  it("**声明的那些文件真的读了这个开关**", () => {
    for (const spec of MODULES) {
      for (const path of spec.enforcedIn) {
        const source = readSource(path);
        assert.ok(
          source.includes("isModuleEnabled"),
          `${path} 声明为 ${spec.key} 的判定点，但里面根本没有 isModuleEnabled`,
        );
        assert.ok(
          source.includes(`"${spec.key}"`),
          `${path} 里没有 isModuleEnabled("${spec.key}") —— 判定的是别的模块？`,
        );
      }
    }
  });

  it("不可关闭的模块不该有判定点 —— 那是一段永远走不到的分支", () => {
    for (const spec of MODULES) {
      if (!spec.lockedOn) continue;
      assert.deepEqual(spec.enforcedIn, [], `${spec.key} 锁死了却还声明了判定点`);
      assert.ok(spec.lockReason, `${spec.key} 锁死了但没说为什么`);
    }
  });

  it("每个模块都有对应的 settings 项", () => {
    const keys = new Set(DEFAULT_SETTINGS.map((s) => s.key));
    for (const spec of MODULES) {
      if (spec.lockedOn) continue;
      assert.ok(keys.has(spec.settingKey), `${spec.key} 的 ${spec.settingKey} 不在默认配置里`);
    }
  });

  it("settings 里的模块项都在登记表里 —— 不能有孤儿开关", () => {
    const registered = new Set(MODULES.map((m) => m.settingKey));
    for (const setting of DEFAULT_SETTINGS) {
      if (!setting.key.startsWith("module.")) continue;
      assert.ok(
        registered.has(setting.key),
        `${setting.key} 是个没人认领的开关 —— 界面上改得动，代码里没人读`,
      );
    }
  });

  it("模块的默认值都是开着的 —— 默认关掉的功能等于没做", () => {
    const byKey = new Map(DEFAULT_SETTINGS.map((s) => [s.key, s]));
    for (const spec of MODULES) {
      if (spec.lockedOn) continue;
      /*
       * 默认关是允许的，但**必须写下理由**（`defaultOff`）。
       *
       * 不要求理由的话，下一个人只要把 value 改成 "false" 就绕过了
       * 这条规矩，而没有任何地方会问他为什么。
       * 现在的唯一一条例外是「每天晚上的推送」—— 它是全站唯一
       * 没有人复核就往所有群发消息的东西。
       */
      if (spec.defaultOff) {
        assert.equal(
          byKey.get(spec.settingKey)?.value,
          "false",
          `${spec.key} 写了 defaultOff 却默认开着 —— 两边对不上`,
        );
        assert.ok(spec.defaultOff.length > 15, `${spec.key} 的 defaultOff 理由太空泛`);
        continue;
      }
      assert.equal(byKey.get(spec.settingKey)?.value, "true", `${spec.key} 默认是关的`);
    }
  });
});

describe("登记表本身", () => {
  it("key 唯一", () => {
    const keys = MODULES.map((m) => m.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("**每个模块都说清楚关掉之后会发生什么** —— 不写清楚没人敢关", () => {
    for (const spec of MODULES) {
      if (spec.lockedOn) continue;
      assert.ok(spec.whenOff.length > 8, `${spec.key} 的 whenOff 太短，说不清后果`);
      assert.ok(spec.summary.length > 4, `${spec.key} 没有说明`);
      assert.notEqual(spec.name, spec.key, `${spec.key} 直接把 key 显示给了人`);
    }
  });

  it("依赖指向真实存在的模块", () => {
    for (const spec of MODULES) {
      for (const dep of spec.dependsOn ?? []) {
        assert.ok(moduleByKey(dep), `${spec.key} 依赖了不存在的 ${dep}`);
      }
    }
  });

  it("**依赖不能成环** —— 成环时状态自洽但没有意义，界面上看不出异常", () => {
    assert.deepEqual(findDependencyCycles(), []);
  });

  it("能查出关掉一个模块会连累谁", () => {
    const affected = dependentsOf("sync").map((m) => m.key).sort();
    assert.deepEqual(affected, ["links", "radar"]);
    assert.deepEqual(dependentsOf("shop"), []);
  });
});

describe("状态判定 —— 「开着但不工作」是最容易骗人的状态", () => {
  const allOn = Object.fromEntries(MODULES.map((m) => [m.key, true]));

  it("全开时都是运行中", () => {
    const states = resolveStates(allOn);
    assert.ok(states.every((s) => s.status === "on" || s.status === "locked"));
  });

  it("关掉的显示为已关闭，并带上后果说明", () => {
    const states = resolveStates({ ...allOn, links: false });
    const links = states.find((s) => s.key === "links")!;
    assert.equal(links.status, "off");
    assert.match(links.reason, /不再抽链接/);
  });

  it("**依赖被关掉时不是「开启」而是「开着但没在工作」**", () => {
    const states = resolveStates({ ...allOn, sync: false });

    for (const key of ["links", "radar"]) {
      const state = states.find((s) => s.key === key)!;
      assert.equal(state.enabled, true, `${key} 自己的开关还开着`);
      assert.equal(state.status, "blocked", `${key} 被显示成了正常运行`);
      assert.deepEqual(state.blockedBy, ["sync"]);
      assert.match(state.reason, /实际上没有在工作/);
    }
  });

  it("自己关掉时不显示成 blocked —— 那会把责任推给依赖", () => {
    const states = resolveStates({ ...allOn, sync: false, radar: false });
    assert.equal(states.find((s) => s.key === "radar")!.status, "off");
  });

  it("没有依赖的模块不受别人影响", () => {
    const states = resolveStates({ ...allOn, sync: false });
    assert.equal(states.find((s) => s.key === "shop")!.status, "on");
  });

  it("**锁死的模块无论存了什么都是开着的**", () => {
    const states = resolveStates({ ...allOn, audit: false });
    const auditState = states.find((s) => s.key === "audit")!;
    assert.equal(auditState.enabled, true);
    assert.equal(auditState.status, "locked");
    assert.match(auditState.reason, /无迹可查/);
  });

  it("缺记录时按开着算 —— 新加的模块不该默认是死的", () => {
    const states = resolveStates({});
    assert.ok(states.every((s) => s.enabled));
  });

  it("每个状态都有中文名，而且只有运行中是绿的", () => {
    for (const key of ["on", "off", "blocked", "locked"] as const) {
      assert.ok(STATUS_LABELS[key].length > 0);
      assert.notEqual(STATUS_LABELS[key], key);
    }
    assert.equal(statusTone("on"), "success");
    assert.notEqual(statusTone("blocked"), "success", "「开着但没在工作」被显示成了正常");
    assert.notEqual(statusTone("off"), "success");
  });
});

describe("后台入口", () => {
  it("模块页已经实现了，导航上不该还标着未完成", () => {
    const item = ALL_ADMIN_ITEMS.find((i) => i.key === "modules")!;
    assert.ok(item, "后台导航里没有模块入口");
    assert.equal(item.ready, true);
  });
});
