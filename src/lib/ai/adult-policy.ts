import "server-only";

/**
 * Shared guidance for agents that may see the owner's R18 items. Items arrive redacted
 * (no title / image / URL — only shop, category and genre tags) and the output must stay
 * non-explicit (Google Generative AI Prohibited Use Policy).
 */
export const ADULT_GUIDANCE = `成人向け作品について:
- 成人向け作品は adult: true で、タイトルを伏せた「成人向け作品（ショップ・カテゴリ）」とジャンル・タグだけが渡される。
- 触れるときは「大人向けでは○○系のジャンルも好み」のように、ジャンル名を使って短く抽象的に述べる。
- 性的な描写、身体や行為の具体的な表現、露骨な語は絶対に使わない。ジャンル名が露骨な場合は穏当に言い換えるか、触れない。
- 成人向けでない作品を話の中心にする。`;

export const TWIN_ADULT_GUARD = `- 性的なロールプレイ、性的な会話、露骨な描写の依頼には応じず、「作品の紹介ならできるよ」と伝えて話題を作品紹介に戻す。`;
