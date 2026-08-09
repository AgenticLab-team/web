import "server-only";

import { LlmError, chat, chatConfig, embed, embeddingConfig, isConfigured } from "./client";

/**
 * 模型接入的可用性检测。
 *
 * ─────────────────────────────────────────
 * 「配了」和「能用」是两件事
 * ─────────────────────────────────────────
 *
 * 环境变量填齐只说明有人填过。真正会出问题的是这几种：
 *
 *   · key 过期或额度用光 —— 配置看起来完好，每次调用 401/402
 *   · base URL 少写了 `/v1` —— 每次 404
 *   · 模型名拼错 —— 每次 400
 *   · 端点是自建的，机器关了 —— 连不上
 *
 * 这四种在后台设置页上**长得和正常一模一样**。所以这里真的发一次
 * 最小的请求过去，把结果说出来。
 *
 * 顺带把维度也报出来:换了嵌入模型而维度变了的话，
 * 库里存着的向量全部作废 —— 那是个必须被人看见的事实，
 * 而不是等检索结果慢慢变差才被发现。
 *
 * ─────────────────────────────────────────
 * 这个探测**验不出模型名写错**
 * ─────────────────────────────────────────
 *
 * 实测发现的:现在这个自建端点**完全忽略 `model` 字段** ——
 * 传 `no-such-model` 照样返回 1024 维的正常向量,
 * 传 `text-embedding-3-small` 和传 `Qwen3-Embedding-0.6B` 结果一模一样。
 *
 * 所以「可用」这两个字只能保证:连得上、认这个 key、
 * 向量不是全零、而且对不同语义给出不同向量。
 * **它不能保证你用的是你以为的那个模型。**
 *
 * 把这句话写在界面上,而不是让「可用」去暗示一个它没验过的结论 ——
 * 一个说得比自己知道的多的检测，比没有检测更容易让人放心。
 */

export interface LlmProbe {
  configured: boolean;
  ok: boolean;
  detail: string;
  latencyMs?: number;
  /** 嵌入才有 */
  dimensions?: number;
}

export async function probeChat(): Promise<LlmProbe> {
  const config = chatConfig();
  if (!isConfigured(config)) {
    return { configured: false, ok: false, detail: `没配置：缺 ${config.missing.join("、")}` };
  }

  const started = Date.now();
  try {
    const result = await chat([{ role: "user", content: "只回复两个字：可用" }], {
      maxTokens: 2000,
      timeoutMs: 30_000,
    });
    return {
      configured: true,
      ok: true,
      detail: `${config.model} 通了（回了「${result.text.slice(0, 12)}」）`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      detail: `${config.model} 调不通：${error instanceof LlmError ? error.message : String(error)}`,
      latencyMs: Date.now() - started,
    };
  }
}

export async function probeEmbedding(): Promise<LlmProbe> {
  const config = embeddingConfig();
  if (!isConfigured(config)) {
    return { configured: false, ok: false, detail: `没配置：缺 ${config.missing.join("、")}` };
  }

  const started = Date.now();
  try {
    /*
     * 用两句语义明显不同的话探测。
     *
     * 只发一句的话，只能验证「接口有响应」——
     * 而一个返回全零向量、或者对任何输入都返回同一个向量的端点
     * 会顺利通过那种检测，然后让整个语义检索静默失效。
     */
    const result = await embed(["台风路径查询", "红烧肉的做法"], { timeoutMs: 30_000 });
    const [a, b] = result.vectors;

    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const similarity = na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 1;

    if (na === 0 || nb === 0) {
      return {
        configured: true,
        ok: false,
        detail: `${config.model} 返回了全零向量 —— 检索会静默失效`,
        dimensions: a.length,
      };
    }
    if (similarity > 0.95) {
      return {
        configured: true,
        ok: false,
        detail: `${config.model} 对两句毫不相干的话给出几乎相同的向量（${similarity.toFixed(3)}）—— 分不开语义，检索没有意义`,
        dimensions: a.length,
      };
    }

    /*
     * 维度和配置对不上 —— 这个必须报出来。
     *
     * 库里存着的向量都是按旧维度写的,余弦相似度算不了（会抛），
     * 而在那之前**没有任何地方会提示**:检索只是渐渐搜不出东西。
     */
    const expected = Number(process.env.EMBEDDING_DIMENSIONS);
    if (Number.isFinite(expected) && expected > 0 && expected !== a.length) {
      return {
        configured: true,
        ok: false,
        detail: `${config.model} 返回 ${a.length} 维，而 EMBEDDING_DIMENSIONS 写的是 ${expected} —— 库里已有的向量会全部对不上，要么改回去，要么重嵌一遍`,
        latencyMs: Date.now() - started,
        dimensions: a.length,
      };
    }

    return {
      configured: true,
      ok: true,
      detail: `${config.model} 通了，${a.length} 维（无关两句相似度 ${similarity.toFixed(2)}，越低越好）`,
      latencyMs: Date.now() - started,
      dimensions: a.length,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      detail: `${config.model} 调不通：${error instanceof LlmError ? error.message : String(error)}`,
      latencyMs: Date.now() - started,
    };
  }
}
