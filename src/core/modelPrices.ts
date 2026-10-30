// What a Claude model's tokens cost relative to another's, from Anthropic's list
// prices (platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-29).
// Plans do not publish how much of a usage limit each model takes; Paneherd
// assumes it follows these prices.

export interface ModelPrice {
  /** Input tokens, $/MTok. */
  input: number;
  /** A cache read, relative to input: 0.05 on Opus and Sonnet 5.5, 0.025 on Fable 5.1, else 0.1. */
  read: number;
}

/** Cache writes by lifetime, and output, relative to input: the same for every model. */
export const WRITE_5M = 1.25;
export const WRITE_1H = 2;
export const OUTPUT = 5;

/** Haiku 5.5 costs five times as much for a prompt over this many tokens (cache reads included). */
const HAIKU_LONG_PROMPT = 100_000;

const SONNET_5_5: ModelPrice = { input: 2, read: 0.05 };

/** The price of a model id such as claude-opus-5-5 or claude-haiku-4-5-20251001. Unknown models price as Sonnet 5.5. */
export function modelPrice(model: string | null, promptTokens = 0): ModelPrice {
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/.exec(model?.toLowerCase() ?? '');
  if (!m) return SONNET_5_5;
  const v = Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  switch (m[1]) {
    case 'fable':
    case 'mythos':
      return { input: 10, read: v >= 5.1 ? 0.025 : 0.1 };
    case 'opus':
      return v >= 5.5 ? { input: 4, read: 0.05 } : { input: v >= 4.5 ? 5 : 15, read: 0.1 };
    case 'sonnet':
      return v >= 5.5 ? SONNET_5_5 : { input: v >= 5 ? 2 : 3, read: 0.1 };
    default:
      if (v >= 5.5) return { input: promptTokens > HAIKU_LONG_PROMPT ? 0.5 : 0.1, read: 0.1 };
      return { input: v >= 4.5 ? 1 : 0.8, read: 0.1 };
  }
}
