import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * `.env.example` 要和代码里真正读的环境变量对得上。
 *
 * ─────────────────────────────────────────
 * 漏一个的代价是「功能静默地不工作」
 * ─────────────────────────────────────────
 *
 * 这个项目里几乎所有外部依赖都是**没配就优雅降级**的：
 * 没配 GitHub 就整个功能不出现，没配图床就走访客通道，
 * 没配嵌入就只有关键词检索。这个设计是对的 ——
 * 半套配置比没配置更糟。
 *
 * 但它有个副作用：**漏配一个变量不会报错**。部署完之后
 * 一切看起来正常，只是某个功能悄悄地不在了，
 * 而没有人会想到去查环境变量。
 *
 * 唯一挡得住的就是这份清单本身要全 —— 所以在这里钉住。
 * 这条测试写的当天就查出 `UPLOAD_API_KEY`、`LLM_MODEL`、
 * `EMBEDDING_*` 一共 5 个变量从来没进过示例文件。
 */

const root = new URL("..", import.meta.url).pathname;

/** 由运行时自己提供，不该出现在示例文件里 */
const RUNTIME_PROVIDED = new Set(["NODE_ENV", "CI", "NEXT_RUNTIME", "TMPDIR"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function usedInCode(): Set<string> {
  const names = new Set<string>();
  for (const dir of ["src", "scripts"]) {
    for (const file of walk(join(root, dir))) {
      const body = readFileSync(file, "utf8");
      for (const m of body.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
        if (!RUNTIME_PROVIDED.has(m[1])) names.add(m[1]);
      }
    }
  }
  return names;
}

function declaredInExample(): Set<string> {
  const body = readFileSync(join(root, ".env.example"), "utf8");
  return new Set([...body.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

describe("**代码读的每一个环境变量都要在 .env.example 里**", () => {
  it("一个都不许漏", () => {
    const used = usedInCode();
    const declared = declaredInExample();
    const missing = [...used].filter((n) => !declared.has(n)).sort();

    assert.deepEqual(
      missing,
      [],
      `这些变量代码在读，但示例文件里没有 —— 部署时漏配不会报错，` +
        `只会让某个功能悄悄不在：${missing.join(", ")}`,
    );
  });

  it("示例文件里也不该有代码根本不读的 —— 那会让人配一堆没用的东西", () => {
    const used = usedInCode();
    const declared = declaredInExample();
    /*
     * 异地备份那六个是脚本里按前缀拼出来的（`OFFSITE_S3_*`），
     * 不是逐个 `process.env.X` 写死的，所以这里认不出来。
     * 白名单它们，而不是把这条断言放宽。
     */
    const byPrefix = (n: string) => n.startsWith("OFFSITE_S3_") || n.startsWith("LLM_") || n.startsWith("EMBEDDING_");
    const stale = [...declared].filter((n) => !used.has(n) && !byPrefix(n)).sort();

    assert.deepEqual(stale, [], `示例文件里这些没人读了：${stale.join(", ")}`);
  });
});

describe("示例文件里不许出现真值", () => {
  const body = readFileSync(join(root, ".env.example"), "utf8");

  it("**没有任何看起来像密钥的东西**", () => {
    /*
     * `.env.example` 是要进仓库、要被开源的。一个手滑把真 key
     * 填进去的提交，删掉也没用 —— 历史里还在。
     */
    const suspicious = [...body.matchAll(/^[A-Z_]+=(.+)$/gm)]
      .map((m) => m[1].trim())
      .filter((v) => /^(sk-|ghp_|gho_|github_pat_)/.test(v) || /^[A-Fa-f0-9]{32,}$/.test(v));
    assert.deepEqual(suspicious, []);
  });

  it("没有真实主机地址 —— 源站躲在 Cloudflare 后面，地址泄露就白躲了", () => {
    assert.equal(/\b\d{1,3}(\.\d{1,3}){3}\b/.test(body.replace(/127\.0\.0\.1|0\.0\.0\.0/g, "")), false);
  });
});
