import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { chatConfig, describeLlm, embeddingConfig, isConfigured } from "@/lib/llm/client";

/**
 * LLM 客户端的配置解析与降级。
 *
 * ─────────────────────────────────────────
 * 对话和嵌入不是同一家
 * ─────────────────────────────────────────
 *
 * 实测过：DeepSeek 的 `/embeddings` 是空的，`/models` 只列了两个对话模型。
 * 嵌入端点是另外一台自建的机器。所以两套配置必须分开 ——
 * 共用的话，配好对话就会以为嵌入也能用了。
 */

const KEYS = [
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("配置解析", () => {
  it("三样齐了才算配好", () => {
    process.env.LLM_BASE_URL = "https://api.example.com";
    process.env.LLM_API_KEY = "sk-x";
    assert.equal(isConfigured(chatConfig()), false, "少了 model 却算配好了");

    process.env.LLM_MODEL = "m";
    assert.equal(isConfigured(chatConfig()), true);
  });

  it("**缺哪个要说出来** —— 只说「没配置」的话人得自己一个个试", () => {
    const c = chatConfig();
    assert.equal(isConfigured(c), false);
    if (isConfigured(c)) return;
    assert.deepEqual(c.missing.sort(), ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]);
  });

  it("base URL 末尾的斜杠要去掉 —— 否则拼出来是 //chat/completions", () => {
    process.env.LLM_BASE_URL = "https://api.example.com/v1///";
    process.env.LLM_API_KEY = "sk-x";
    process.env.LLM_MODEL = "m";
    const c = chatConfig();
    assert.equal(isConfigured(c) && c.baseUrl, "https://api.example.com/v1");
  });
});

describe("**嵌入是单独一套**", () => {
  it("对话配好了，嵌入没配 —— 嵌入仍然算没配", () => {
    /*
     * 这条是这一组里最要紧的:实测 DeepSeek 没有嵌入接口,
     * 拿对话那套去调 /embeddings 会得到一串 404,
     * 而 404 在批量任务里很容易被当成「这条跳过」。
     */
    process.env.LLM_BASE_URL = "https://api.deepseek.com";
    process.env.LLM_API_KEY = "sk-x";
    process.env.LLM_MODEL = "deepseek-v4-flash";
    assert.equal(isConfigured(embeddingConfig()), false, "嵌入偷偷用了对话那套配置");
  });

  it("嵌入有自己的一套时用自己的", () => {
    process.env.LLM_BASE_URL = "https://api.deepseek.com";
    process.env.LLM_API_KEY = "sk-chat";
    process.env.LLM_MODEL = "deepseek-v4-flash";
    process.env.EMBEDDING_BASE_URL = "https://embed.example.com/v1";
    process.env.EMBEDDING_API_KEY = "sk-embed";
    process.env.EMBEDDING_MODEL = "Qwen3-Embedding-0.6B";

    const e = embeddingConfig();
    assert.ok(isConfigured(e));
    if (!isConfigured(e)) return;
    assert.equal(e.baseUrl, "https://embed.example.com/v1");
    assert.equal(e.apiKey, "sk-embed");
  });

  it("**同一家既能聊也能嵌时，只要写了 EMBEDDING_MODEL 就退回用对话那套**", () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_API_KEY = "sk-x";
    process.env.LLM_MODEL = "gpt-4";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";

    const e = embeddingConfig();
    assert.ok(isConfigured(e));
    if (!isConfigured(e)) return;
    assert.equal(e.baseUrl, "https://api.openai.com/v1");
    assert.equal(e.model, "text-embedding-3-small");
  });

  it("没写 EMBEDDING_MODEL 就不退回 —— 不要拿对话模型去调嵌入接口", () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_API_KEY = "sk-x";
    process.env.LLM_MODEL = "gpt-4";
    assert.equal(isConfigured(embeddingConfig()), false);
  });
});

describe("说给人听的一句话", () => {
  it("两条分别说，不要笼统一句「LLM 没配」", () => {
    process.env.LLM_BASE_URL = "https://api.deepseek.com";
    process.env.LLM_API_KEY = "sk-x";
    process.env.LLM_MODEL = "deepseek-v4-flash";

    const d = describeLlm();
    assert.match(d.chat, /已配置/);
    assert.match(d.embedding, /没配置/);
    assert.match(d.embedding, /EMBEDDING_/, "没说缺哪个变量");
  });
});

describe("**没配置时抛异常，不返回空结果**", () => {
  it("源码里没有「返回空摘要 / 零向量」这类兜底", () => {
    /*
     * 那两样都会被上层当成「这条没什么可说的」写进库,
     * 之后没有人查得出那批数据是在没有模型的情况下生成的 ——
     * 又是一次「故障伪装成业务结果」。
     */
    const src = readFileSync(new URL("../src/lib/llm/client.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

    const chatFn = code.slice(code.indexOf("export async function chat"), code.indexOf("interface EmbeddingResponse"));
    assert.match(chatFn, /throw new LlmNotConfigured/);
    assert.doesNotMatch(chatFn, /return \{ text: "" ?\}/);

    const embedFn = code.slice(code.indexOf("export async function embed"));
    assert.match(embedFn, /throw new LlmNotConfigured/);
  });

  it("**推理模型要读 content 不读 reasoning_content**", () => {
    /*
     * v4-flash 会把思考过程放在 reasoning_content 里。
     * 拿错字段会得到一段自言自语,而它读起来像模像样,
     * 很容易被当成正常输出写进库。
     */
    const src = readFileSync(new URL("../src/lib/llm/client.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    assert.match(code, /message\?\.content/);
    assert.doesNotMatch(code, /=\s*data\.choices\?\.\[0\]\?\.message\?\.reasoning_content/);
  });

  it("**嵌入结果按 index 重排** —— 顺序错位不会报错，只会让结果「不太准」", () => {
    const src = readFileSync(new URL("../src/lib/llm/client.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    assert.match(code, /sort\(\(a, b\) => a\.index - b\.index\)/);
  });

  it("要了几个就得回来几个，对不上要抛", () => {
    const src = readFileSync(new URL("../src/lib/llm/client.ts", import.meta.url), "utf8");
    assert.match(src, /data\.data\.length !== inputs\.length/);
  });

  it("**空回复只重试一次** —— 重多了会把一次配置错误变成对上游的压测", () => {
    const src = readFileSync(new URL("../src/lib/llm/client.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    assert.match(code, /attempt < 2/);
  });

  it("**被 max_tokens 截断要单独说** —— 那不是抖动，重试没用", () => {
    const src = readFileSync(new URL("../src/lib/llm/client.ts", import.meta.url), "utf8");
    assert.match(src, /finish === "length"/);
    assert.match(src, /截断/);
  });
});

describe("可用性检测", () => {
  it("**嵌入探测要发两句不相干的话** —— 只发一句验不出「对任何输入都返回同一个向量」", () => {
    /*
     * 那种端点会顺利通过「有响应」的检测,
     * 然后让整个语义检索静默失效。
     */
    const src = readFileSync(new URL("../src/lib/llm/health.ts", import.meta.url), "utf8");
    assert.match(src, /embed\(\["[^"]+", "[^"]+"\]/);
    assert.match(src, /similarity > 0\.95/);
  });

  it("全零向量要报不可用", () => {
    const src = readFileSync(new URL("../src/lib/llm/health.ts", import.meta.url), "utf8");
    assert.match(src, /全零向量/);
  });

  it("**维度要报出来** —— 换了模型维度变了的话，库里的向量全部作废", () => {
    const src = readFileSync(new URL("../src/lib/llm/health.ts", import.meta.url), "utf8");
    assert.match(src, /dimensions/);
  });

  it("后台那一页真的调了探测，不是只显示配置", () => {
    const page = readFileSync(
      new URL("../src/app/(app)/admin/llm/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /probeChat\(\)/);
    assert.match(page, /probeEmbedding\(\)/);
  });

  it("整理按钮在对话模型不可用时是禁用的 —— 点了也只会一片失败", () => {
    const page = readFileSync(
      new URL("../src/app/(app)/admin/llm/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /disabled=\{!chat\.ok\}/);
  });
});

describe("界面要标出哪条是机器写的", () => {
  it("资源库列表里带「AI 整理」标记", () => {
    /*
     * 一段语气笃定、格式工整的简介,人默认它是可靠的 ——
     * 而它是根据群里的只言片语整理出来的。
     * 不标的话,读的人没有机会自己判断要不要信。
     */
    const page = readFileSync(new URL("../src/app/(app)/links/page.tsx", import.meta.url), "utf8");
    assert.match(page, /AI 整理/);
    assert.match(page, /aiSummary/);
  });

  it("**原标题不丢** —— 要能对得上这条到底指向哪", () => {
    const page = readFileSync(new URL("../src/app/(app)/links/page.tsx", import.meta.url), "utf8");
    assert.match(page, /item\.title !== item\.aiTitle/);
  });

  it("整理出来的标题和简介也能被搜到", () => {
    const q = readFileSync(new URL("../src/lib/links/queries.ts", import.meta.url), "utf8");
    assert.match(q, /aiTitle \?\? ""\)\.toLowerCase\(\)\.includes\(needle\)/);
  });
});

describe("**探测不该说得比自己知道的多**", () => {
  it("维度和 EMBEDDING_DIMENSIONS 对不上要报不可用", () => {
    /*
     * 库里存着的向量都是按旧维度写的,余弦相似度算不了,
     * 而在那之前没有任何地方会提示 —— 检索只是渐渐搜不出东西。
     */
    const src = readFileSync(new URL("../src/lib/llm/health.ts", import.meta.url), "utf8");
    assert.match(src, /EMBEDDING_DIMENSIONS/);
    assert.match(src, /expected !== a\.length/);
  });

  it("**界面上写明「验不出模型名写错」** —— 说得比自己知道的多，比没有检测更危险", () => {
    /*
     * 实测:现在这个自建端点完全忽略 model 字段,
     * 传 no-such-model 照样返回 1024 维的正常向量。
     */
    const page = readFileSync(
      new URL("../src/app/(app)/admin/llm/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /不保证你用的是你以为的那个模型/);
  });

  it("源码注释里记下了这个限制，不是只写在界面上", () => {
    const src = readFileSync(new URL("../src/lib/llm/health.ts", import.meta.url), "utf8");
    assert.match(src, /忽略 `model` 字段|忽略 model 字段/);
  });
});
