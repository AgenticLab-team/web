import "server-only";

/**
 * OpenAI 兼容的 LLM 客户端。
 *
 * ─────────────────────────────────────────
 * 为什么是「兼容」而不是绑定某一家
 * ─────────────────────────────────────────
 *
 * 对话和嵌入**很可能不是同一家**。实测过：DeepSeek 的
 * `/embeddings` 是空的，`/models` 只列了两个对话模型。
 * 所以两条路各有各的 base URL 和 key，不共用一套配置 ——
 * 共用的话，配好对话就以为嵌入也能用了。
 *
 * ─────────────────────────────────────────
 * 没配置要如实说
 * ─────────────────────────────────────────
 *
 * 这个项目反复出现的一条：**故障不能伪装成业务结果**。
 * 没配 key 的时候不返回空摘要、不返回零向量 —— 那两样都会被
 * 上层当成「这条没什么可说的」而写进库里，之后没有人查得出
 * 那一批数据是在没有模型的情况下生成的。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class LlmNotConfigured extends Error {
  constructor(readonly missing: string[]) {
    super(`LLM 没有配置：缺 ${missing.join("、")}`);
    this.name = "LlmNotConfigured";
  }
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

function readConfig(prefix: "LLM" | "EMBEDDING"): LlmConfig | { missing: string[] } {
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  const model = process.env[`${prefix}_MODEL`];

  const missing = [
    !baseUrl && `${prefix}_BASE_URL`,
    !apiKey && `${prefix}_API_KEY`,
    !model && `${prefix}_MODEL`,
  ].filter((x): x is string => Boolean(x));

  if (missing.length > 0) return { missing };
  return { baseUrl: baseUrl!.replace(/\/+$/, ""), apiKey: apiKey!, model: model! };
}

export function chatConfig(): LlmConfig | { missing: string[] } {
  return readConfig("LLM");
}

/**
 * 嵌入的配置。
 *
 * 单独一套是因为它经常来自另一家 —— 缺的时候要能说清楚
 * 「对话是好的，嵌入没配」，而不是笼统一句「LLM 没配」。
 */
export function embeddingConfig(): LlmConfig | { missing: string[] } {
  const own = readConfig("EMBEDDING");
  if (!("missing" in own)) return own;

  /*
   * 退回到对话那套只在**明确写了 EMBEDDING_MODEL** 时发生 ——
   * 也就是「同一家既能聊也能嵌」的情况。
   * 没写 model 就老老实实说没配，不要拿对话模型去调嵌入接口：
   * 那会得到一串 404，而 404 在批量任务里很容易被当成「这条跳过」。
   */
  const chat = readConfig("LLM");
  const model = process.env.EMBEDDING_MODEL;
  if (!("missing" in chat) && model) return { ...chat, model };

  return own;
}

export function isConfigured(config: LlmConfig | { missing: string[] }): config is LlmConfig {
  return !("missing" in config);
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function post<T>(
  config: LlmConfig,
  path: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      /*
       * 把上游的原文带出来。
       *
       * 这类接口的错误信息通常很具体（额度用完、模型名写错、
       * 输入太长），而包装成一句「请求失败」之后，
       * 排查就只能靠猜。截断是因为有些网关会回一整页 HTML。
       */
      throw new LlmError(`${response.status}：${text.slice(0, 300)}`, response.status);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LlmError(`返回的不是 JSON：${text.slice(0, 200)}`);
    }
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new LlmError(`超过 ${Math.round(timeoutMs / 1000)} 秒没返回`);
    }
    throw new LlmError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

interface ChatResponse {
  choices: { message: { content: string | null; reasoning_content?: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ChatResult {
  text: string;
  totalTokens: number;
}

/**
 * 一次对话补全。
 *
 * **推理模型要读 `content` 而不是 `reasoning_content`。**
 * deepseek-v4-flash 这类模型会把思考过程放在后者里 ——
 * 拿错字段会得到一段自言自语，而它读起来像模像样，
 * 很容易被当成正常输出写进库。
 */
export async function chat(
  messages: { role: "system" | "user"; content: string }[],
  options: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const config = chatConfig();
  if (!isConfigured(config)) throw new LlmNotConfigured(config.missing);

  const data = await post<ChatResponse>(
    config,
    "/chat/completions",
    {
      model: config.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 800,
    },
    options.timeoutMs,
  );

  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") {
    throw new LlmError("模型返回了空内容");
  }

  return { text: text.trim(), totalTokens: data.usage?.total_tokens ?? 0 };
}

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { total_tokens: number };
}

export interface EmbedResult {
  vectors: Float32Array[];
  totalTokens: number;
  model: string;
}

/**
 * 批量嵌入。
 *
 * 返回的顺序**按 index 重排**，不信接口返回的数组顺序 ——
 * 顺序错位的后果是每个向量都配到了别人的文本上，
 * 而检索结果看起来只是「不太准」，不会有任何报错。
 */
export async function embed(
  inputs: string[],
  options: { dimensions?: number; timeoutMs?: number } = {},
): Promise<EmbedResult> {
  const config = embeddingConfig();
  if (!isConfigured(config)) throw new LlmNotConfigured(config.missing);
  if (inputs.length === 0) return { vectors: [], totalTokens: 0, model: config.model };

  const body: Record<string, unknown> = { model: config.model, input: inputs };
  if (options.dimensions) body.dimensions = options.dimensions;

  const data = await post<EmbeddingResponse>(config, "/embeddings", body, options.timeoutMs);

  if (!Array.isArray(data.data) || data.data.length !== inputs.length) {
    throw new LlmError(`要了 ${inputs.length} 个向量，回来 ${data.data?.length ?? 0} 个`);
  }

  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return {
    vectors: sorted.map((d) => Float32Array.from(d.embedding)),
    totalTokens: data.usage?.total_tokens ?? 0,
    model: config.model,
  };
}

/** 给健康检查和后台用的一句话 */
export function describeLlm(): { chat: string; embedding: string } {
  const c = chatConfig();
  const e = embeddingConfig();
  return {
    chat: isConfigured(c) ? `已配置：${c.model}` : `没配置（缺 ${c.missing.join("、")}）`,
    embedding: isConfigured(e) ? `已配置：${e.model}` : `没配置（缺 ${e.missing.join("、")}）`,
  };
}
