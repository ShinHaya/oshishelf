import { ZodError } from "zod";
import { UserError } from "./user-error";

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export async function attempt<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    // Next.js redirects must propagate instead of becoming a form error.
    if (e && typeof e === "object" && "digest" in e && String(e.digest).startsWith("NEXT_REDIRECT")) throw e;
    if (e instanceof UserError) return { ok: false, error: e.message };
    if (e instanceof ZodError) return { ok: false, error: "入力内容を確認してください" };
    console.error(e);
    return { ok: false, error: "処理に失敗しました。時間をおいてもう一度お試しください。" };
  }
}
