/**
 * Passkey 流程的用户可见反馈 —— 纯逻辑，从 usePasskey 里拆出来。
 *
 * 拆出来有两个原因：
 * 1. 这些文案是用户判断「刚才到底成没成功」的唯一依据，必须可测；
 *    而带 "use client" 的 hook 文件在 react-server 条件下没法被测试导入。
 * 2. 添加与移除两条流程要给出一致的反馈口径，逻辑只能有这一份。
 */

/**
 * 把浏览器抛出的 WebAuthn 异常翻译成人话。
 *
 * 原始错误是 `NotAllowedError: The operation either timed out or was not allowed`
 * 这种，用户看了完全不知道发生了什么、更不知道该怎么办。
 */
export function humanize(err: unknown): string {
  if (!(err instanceof Error)) return "操作失败，请重试";
  const name = err.name;

  if (name === "NotAllowedError") return "已取消，或者等待超时了";
  if (name === "InvalidStateError") return "这台设备已经注册过 Passkey 了";
  if (name === "NotSupportedError") return "这个浏览器不支持 Passkey";
  if (name === "SecurityError") {
    // rpID 与访问域名不一致时报这个，是配置问题不是用户问题
    return "安全校验失败，请确认访问的是正式域名（不能用 IP 直接访问）";
  }
  if (name === "AbortError") return "操作被中断";
  // fetch 网络失败抛 TypeError，原文是 "Failed to fetch" 之类的英文
  if (name === "TypeError") return "网络异常，请检查连接后重试";
  return err.message || "操作失败，请重试";
}

export interface PasskeyFeedback {
  kind: "success" | "error";
  message: string;
}

/** 添加成功的提示。设备名带上，多设备用户才知道加的是哪把 */
export function registerSuccessFeedback(deviceName?: string): PasskeyFeedback {
  return {
    kind: "success",
    message: deviceName ? `已添加「${deviceName}」` : "Passkey 已添加",
  };
}

/**
 * 移除的结果反馈。失败必须说明原因 ——
 * 静默失败会让用户以为钥匙已删掉，实际上它还能登录。
 */
export function revokeFeedback(
  name: string,
  result: { ok: boolean; serverError?: string | null },
): PasskeyFeedback {
  if (result.ok) return { kind: "success", message: `已移除「${name}」` };
  return { kind: "error", message: result.serverError || "移除失败，请重试" };
}
