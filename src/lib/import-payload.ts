import { z } from "zod";
import { isProductUrl } from "./shops";

const url = z.string().max(2000).refine(isProductUrl);
const card = z.object({
  href: z.union([z.literal(""), url]), text: z.string().max(500), context: z.string().max(1000),
  section: z.string().max(200), imgs: z.array(z.object({ src: url, alt: z.string().max(300) })).max(6),
  page: z.number().int().min(1).max(20),
});
/** Drop oversized tracking links, preserving the server's existing import behavior. */
function dropOversizedUrls(cards: unknown): unknown {
  if (!Array.isArray(cards)) return cards;
  const fits = (value: unknown) => typeof value !== "string" || value.length <= 2000;
  return cards.filter((c) => fits(c?.href)).map((c) => Array.isArray(c?.imgs)
    ? { ...c, imgs: c.imgs.filter((i: { src?: unknown } | null) => fits(i?.src)) } : c);
}

export const bulkSchema = z.object({
  page: url, title: z.string().max(300).optional(),
  cards: z.preprocess(dropOversizedUrls, z.array(card).max(2000)).optional(),
  links: z.array(z.object({ href: url, text: z.string().max(500), img: url.nullish() })).max(3000).optional(),
  text: z.string().max(60000).optional(),
});
const payloadSchema = bulkSchema.extend({
  type: z.enum(["oshishelf:cards", "oshishelf:links"]),
  version: z.number().int().optional(), mode: z.enum(["remote", "embedded"]).optional(),
});
export type ImportPayload = z.infer<typeof payloadSchema> & { origin: string };

/** Validate before display; the browser's origin is authoritative, not the sender's page label. */
export function parseImportMessage(data: unknown, origin: string): ImportPayload | null {
  const result = payloadSchema.safeParse(data);
  if (!result.success) return null;
  try {
    if (new URL(origin).origin !== origin || new URL(result.data.page).origin !== origin) return null;
    return { ...result.data, origin };
  } catch {
    return null;
  }
}
