import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { attempt } from "./action-result";
import { UserError } from "./user-error";

describe("Server Action errors", () => {
  it("returns explicitly safe messages including quota errors", async () => {
    expect(await attempt(async () => { throw new UserError("本日のAI利用上限に達しました"); })).toEqual({ ok: false, error: "本日のAI利用上限に達しました" });
  });
  it.each([new Error("Firestore index https://console.example/projects/private-project"), new Error("Vertex AI internal endpoint"), { message: "private schema" }])("hides infrastructure messages", async (error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await attempt(async () => { throw error; });
    expect(result).toEqual({ ok: false, error: "処理に失敗しました。時間をおいてもう一度お試しください。" });
    expect(log).toHaveBeenCalledWith(error);
  });
  it("does not disclose Zod schemas", async () => {
    expect(await attempt(async () => z.object({ secretField: z.string() }).parse({}))).toEqual({ ok: false, error: "入力内容を確認してください" });
  });
  it("propagates Next.js redirects", async () => {
    const redirect = Object.assign(new Error("redirect"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    await expect(attempt(async () => { throw redirect; })).rejects.toBe(redirect);
  });
});
