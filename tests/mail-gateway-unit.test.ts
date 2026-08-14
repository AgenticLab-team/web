import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const unit = readFileSync(join(root, "ops/mail-gateway/agenticlab-mail.service"), "utf8");
const install = readFileSync(join(root, "ops/mail-gateway/install.sh"), "utf8");

/**
 * 收信网关的 systemd 单元 —— **两条都是实际装的时候炸出来的**。
 *
 * ═════════════════════════════════════════
 * 它们的共同点：报错完全指向别处
 * ═════════════════════════════════════════
 *
 * 装网关那一次连撞两个，各花了一轮才看出来：
 *
 *   ① `ExecStart=/usr/bin/node` —— 源站上 node 在 `/usr/local/bin`。
 *      systemd 报 `status=203/EXEC`，**一个字都不提 node**。
 *
 *   ② `WorkingDirectory=/home/mailgw/...` 配 `ProtectHome=true` ——
 *      硬化把 /home 整个藏了，而工作目录在里面。
 *      报的是 `status=200/CHDIR`「Permission denied」，
 *      而 `sudo -u mailgw cd` 进得去 —— 也就是说
 *      **照着报错去查目录权限，查不出任何问题**。
 *
 * 这类错不会在任何测试里自然出现（没人在 CI 里跑 systemd），
 * 所以只能靠读这两个文件本身。
 */

describe("**node 的路径不许写死**", () => {
  it("单元里是占位符，不是某台机器上的绝对路径", () => {
    /*
     * systemd 不读 PATH，ExecStart 必须绝对路径；而 node 的位置
     * 因装法而异（apt → /usr/bin，官方 tarball → /usr/local/bin）。
     * 所以由 install.sh 在装的时候按 `command -v node` 填。
     */
    const exec = unit.match(/^ExecStart=.*$/m)?.[0] ?? "";
    assert.match(exec, /__NODE__/, `ExecStart 又写死了路径：${exec}`);
  });

  it("install.sh 真的会把它填掉", () => {
    // 只有占位符没人替换的话，服务连启动都不会启动
    assert.match(install, /command -v node/);
    assert.match(install, /__NODE__/);
  });
});

describe("**ProtectHome 和工作目录不能打架**", () => {
  const hardened = /^ProtectHome=(true|yes)$/m.test(unit);

  it("开着 ProtectHome 时，工作目录不在 /home 底下", () => {
    /*
     * 这两条单独看都对，凑在一起就是 `200/CHDIR`。
     * 而那个报错说的是「权限不够」——指向一个权限完全正常的目录。
     */
    if (!hardened) return;
    const wd = unit.match(/^WorkingDirectory=(.*)$/m)?.[1] ?? "";
    assert.equal(
      wd.startsWith("/home"),
      false,
      `ProtectHome=true 会让 /home 整个不可见，而 WorkingDirectory=${wd} 在里面`,
    );
  });

  it("能读写的那个目录也不能在 /home 底下", () => {
    if (!hardened) return;
    for (const p of [...unit.matchAll(/^ReadWritePaths=(.*)$/gm)].map((m) => m[1])) {
      assert.equal(p.startsWith("/home"), false, `ReadWritePaths=${p} 会被 ProtectHome 挡住`);
    }
  });

  it("EnvironmentFile 同理 —— 读不到它就是「密钥没配」，而密钥明明配了", () => {
    if (!hardened) return;
    const env = unit.match(/^EnvironmentFile=(.*)$/m)?.[1] ?? "";
    assert.equal(env.startsWith("/home"), false, `EnvironmentFile=${env} 会被 ProtectHome 挡住`);
  });

  it("**装的地方和单元里写的是同一个** —— 分叉的话装完就起不来", () => {
    const wd = unit.match(/^WorkingDirectory=(.*)$/m)?.[1] ?? "";
    assert.ok(wd.length > 1, "单元里没有 WorkingDirectory");
    assert.match(
      install,
      new RegExp(`HOME_DIR=${wd.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`),
      `install.sh 装到别处去了，而单元里写的是 ${wd}`,
    );
  });
});

describe("**同机部署不许把站点地址写成 127.0.0.1:3000**", () => {
  it("默认值是公网地址", () => {
    /*
     * ═════════════════════════════════════════
     * 因为站点是蓝绿的
     * ═════════════════════════════════════════
     *
     * 两份构建轮流在 3000 和 3001 上跑，每次 `npm run deploy` 换一边。
     * 网关写死一个端口的话，**下一次部署之后它就开始往一个已经停掉的
     * 端口投递** —— 而症状是「隔一次部署收不到信」，
     * 没有人会往部署上想。
     *
     * 走公网多一跳，换来的是它永远指向活着的那一边。
     */
    const def = install.match(/^SITE_URL="\$\{SITE_URL:-([^}]*)\}"/m)?.[1] ?? "";
    assert.equal(
      /127\.0\.0\.1:\d+|localhost:\d+/.test(def),
      false,
      `默认站点地址写死了端口（${def}）—— 蓝绿一换边就投不进去了`,
    );
    assert.match(def, /^https:\/\//, `默认站点地址应该是 https 的公网地址，实际是 ${def}`);
  });
});
