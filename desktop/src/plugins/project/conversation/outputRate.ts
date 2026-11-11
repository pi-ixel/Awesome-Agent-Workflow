const windowMs = 200;

type Channel = "thought" | "message";
type CountTokens = (text: string) => number;

let countTokens: CountTokens | undefined;
let loading: Promise<void> | undefined;

/** Estimate from concatenated fragments, since ACP can split a token across chunks. */
export function createOutputRate(publish: (rate: number | null) => void) {
  let samples: { channel: Channel; text: string; receivedAt: number }[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  const reset = () => {
    clearInterval(timer);
    timer = undefined;
    samples = [];
    publish(null);
  };

  const refresh = () => {
    const now = performance.now();
    samples = samples.filter((sample) => now - sample.receivedAt <= windowMs);
    if (samples.length === 0) {
      reset();
      return;
    }
    if (!countTokens) return;
    const text = { thought: "", message: "" };
    for (const sample of samples) text[sample.channel] += sample.text;
    const tokens = countTokens(text.thought) + countTokens(text.message);
    publish(tokens > 0 ? (tokens * 1_000) / windowMs : null);
  };

  return {
    append(channel: Channel, text: string, receivedAt: number) {
      if (!text) return;
      loading ??= import("gpt-tokenizer/encoding/cl100k_base")
        .then((tokenizer) => {
          countTokens = (input) =>
            tokenizer.countTokens(input, { disallowedSpecial: new Set() });
        })
        .catch(() => {
          loading = undefined;
        });
      if (timer === undefined) {
        timer = setInterval(refresh, windowMs);
      }
      samples.push({ channel, text, receivedAt });
    },
    reset,
  };
}
