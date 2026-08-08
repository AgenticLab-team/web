"use client";

import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";

/**
 * 把浏览器抛出的 WebAuthn 异常翻译成人话。
 *
 * 原始错误是 `NotAllowedError: The operation either timed out or was not allowed`
 * 这种，用户看了完全不知道发生了什么、更不知道该怎么办。
 */
function humanize(err: unknown): string {
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
  return err.message || "操作失败，请重试";
}

export type PasskeySupport = "unknown" | "unsupported" | "supported" | "platform";

export function usePasskeySupport(): PasskeySupport {
  const [support, setSupport] = useState<PasskeySupport>("unknown");

  useEffect(() => {
    if (!browserSupportsWebAuthn()) {
      setSupport("unsupported");
      return;
    }
    // 有平台认证器（指纹/面容）才值得把 Passkey 作为主推项
    platformAuthenticatorIsAvailable()
      .then((available) => setSupport(available ? "platform" : "supported"))
      .catch(() => setSupport("supported"));
  }, []);

  return support;
}

interface RunState {
  busy: boolean;
  error: string | null;
}

export function usePasskeyRegister(onDone?: () => void) {
  const [state, setState] = useState<RunState>({ busy: false, error: null });

  const register = useCallback(
    async (name?: string) => {
      setState({ busy: true, error: null });
      try {
        const optionsRes = await fetch("/api/auth/passkey/register/options", { method: "POST" });
        if (!optionsRes.ok) {
          const body = await optionsRes.json().catch(() => ({}));
          throw new Error(body.error ?? "无法开始注册");
        }
        const options = await optionsRes.json();

        const response = await startRegistration({ optionsJSON: options });

        const verifyRes = await fetch("/api/auth/passkey/register/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response, name: name || defaultDeviceName() }),
        });
        if (!verifyRes.ok) {
          const body = await verifyRes.json().catch(() => ({}));
          throw new Error(body.error ?? "验证失败");
        }

        setState({ busy: false, error: null });
        onDone?.();
        return true;
      } catch (err) {
        setState({ busy: false, error: humanize(err) });
        return false;
      }
    },
    [onDone],
  );

  return { ...state, register };
}

export function usePasskeyLogin() {
  const [state, setState] = useState<RunState>({ busy: false, error: null });

  const login = useCallback(async () => {
    setState({ busy: true, error: null });
    try {
      const optionsRes = await fetch("/api/auth/passkey/login/options", { method: "POST" });
      if (!optionsRes.ok) {
        const body = await optionsRes.json().catch(() => ({}));
        throw new Error(body.error ?? "无法开始登录");
      }
      const options = await optionsRes.json();

      const response = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        throw new Error(body.error ?? "登录失败");
      }

      const body = await verifyRes.json();
      setState({ busy: false, error: null });
      return body.next ?? "/";
    } catch (err) {
      setState({ busy: false, error: humanize(err) });
      return null;
    }
  }, []);

  return { ...state, login };
}

/** 从 UA 猜一个默认设备名，省得用户自己想 */
function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android 设备";
  if (/Windows/.test(ua)) return "Windows 电脑";
  return "这台设备";
}
