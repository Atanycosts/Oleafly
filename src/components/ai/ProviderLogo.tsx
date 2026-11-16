import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono";
import Gemini from "@lobehub/icons/es/Gemini/components/Color";
import Groq from "@lobehub/icons/es/Groq/components/Mono";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Color";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Color";
import Mistral from "@lobehub/icons/es/Mistral/components/Color";
import Grok from "@lobehub/icons/es/Grok/components/Mono";
import Ollama from "@lobehub/icons/es/Ollama/components/Mono";
import Perplexity from "@lobehub/icons/es/Perplexity/components/Color";
import ZAI from "@lobehub/icons/es/ZAI/components/Mono";
import Qwen from "@lobehub/icons/es/Qwen/components/Color";
import Kimi from "@lobehub/icons/es/Kimi/components/Mono";
import Zhipu from "@lobehub/icons/es/Zhipu/components/Color";
import SiliconCloud from "@lobehub/icons/es/SiliconCloud/components/Color";
import Volcengine from "@lobehub/icons/es/Volcengine/components/Color";
import type { IconType } from "@lobehub/icons";

// Import only the marks we render: the package barrel loads every brand and
// its Avatar/Text variants into the build graph. Kimi uses its single-color
// mark because its Color variant draws a white K on light themes.
const ICONS: Record<string, IconType> = {
  openai: OpenAI,
  anthropic: Anthropic,
  google: Gemini,
  groq: Groq,
  openrouter: OpenRouter,
  deepseek: DeepSeek,
  mistral: Mistral,
  xai: Grok,
  ollama: Ollama,
  perplexity: Perplexity,
  zai: ZAI,
  qwen: Qwen,
  kimi: Kimi,
  zhipu: Zhipu,
  siliconflow: SiliconCloud,
  "volcengine-ark": Volcengine,
};

const MONO_COLORS = ["#e11d48", "#0ea5e9", "#16a34a", "#a855f7", "#f59e0b", "#64748b"];

function monoColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return MONO_COLORS[h % MONO_COLORS.length];
}

export function ProviderLogo({ providerId, size = 18 }: Readonly<{ providerId: string; size?: number }>) {
  const Icon = ICONS[providerId];
  if (Icon) return <Icon size={size} />;
  const letter = (providerId.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        background: monoColor(providerId),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        color: "#fff",
        fontSize: size * 0.6,
        fontWeight: 600,
      }}
    >
      {letter}
    </span>
  );
}
