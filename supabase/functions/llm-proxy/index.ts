/**
 * Edge Function: llm-proxy
 * Proxy para OpenAI, Anthropic (Claude), Google (Gemini)
 *
 * Endpoints:
 * - POST ?provider=openai|claude|gemini&user_id=...&model=...
 *   body: { messages, system? }  → { content, tokens_used, cost_factor, deducted_tokens }
 *
 * - POST ?action=whisper&user_id=...
 *   body: { audio_base64, filename?, language? }  → { text }
 *
 * - POST ?action=tts&user_id=...
 *   body: { text, voice?, model? }  → { audio_base64 }
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";

// Fatores de custo multiplicadores (vs gpt-4o-mini = 1.0)
const COST_FACTORS: Record<string, number> = {
  // OpenAI
  "gpt-3.5-turbo": 0.2,
  "gpt-4.1-nano": 0.3,
  "gpt-4.1-mini": 0.8,
  "gpt-4o-mini": 1.0,
  "o4-mini": 2.0,
  "o3-mini": 3.0,
  "gpt-4.1": 5.5,
  "gpt-4-turbo": 6.0,
  "gpt-4o": 8.0,
  "o3": 12,
  // Claude
  "claude-3-opus-20240229": 40,
  "claude-opus-4-6": 50,
  "claude-3.5-sonnet": 25,
  "claude-sonnet-4-6": 35,
  "claude-3-haiku": 10,
  "claude-haiku-4-5": 12,
  "claude-haiku-4-5-20251001": 12,
  // Gemini
  "gemini-2.0-flash": 2.5,
  "gemini-1.5-flash": 2.0,
  "gemini-1.5-pro": 5.0,
  // Audio (custo fixo por chamada em tokens equivalentes)
  "whisper-1": 0.5,
  "tts-1": 0.3,
  "tts-1-hd": 1.0,
};

interface TokenBalance {
  saldo_tokens: number;
  tokens_usados_mes: number;
}

async function getTokenBalance(userId: string): Promise<TokenBalance> {
  const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await client
    .rpc("get_token_balance", { p_user_id: userId });

  if (error || !data || data.length === 0) {
    return { saldo_tokens: 0, tokens_usados_mes: 0 };
  }
  return data[0];
}

async function deductTokens(
  userId: string,
  tokens: number
): Promise<boolean> {
  const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error } = await client
    .rpc("decrementar_tokens", { p_user_id: userId, p_tokens: tokens });
  return !error;
}

function estimateTokens(content: string): number {
  return Math.max(50, Math.round(content.length / 4));
}

// ─── Chat completions (OpenAI, Claude, Gemini) ───────────────────────────────

async function callOpenAI(
  messages: any[],
  model: string,
  systemPrompt?: string,
  webSearch = false
) {
  // Web search: usa OpenAI Responses API com ferramenta web_search_preview
  if (webSearch) {
    const input: any[] = [];
    if (systemPrompt) input.push({ role: "system", content: systemPrompt });
    input.push(...messages);

    const searchBody = {
      model: "gpt-4o-search-preview",
      web_search_options: { search_context_size: "medium" },
      input,
    };

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody),
    });

    if (!resp.ok) {
      const errTxt = await resp.text();
      throw new Error(`OpenAI web-search error: ${resp.status} ${errTxt}`);
    }

    const data = await resp.json();
    // Responses API retorna output[] com type=message
    const textItem = data.output?.find((o: any) => o.type === "message");
    const content = textItem?.content?.[0]?.text || data.output_text || "";
    const usage = data.usage || {};
    return {
      content,
      usage: {
        input_tokens:  usage.input_tokens  || estimateTokens(JSON.stringify(messages)),
        output_tokens: usage.output_tokens || estimateTokens(content),
      },
    };
  }

  // Chat completions padrão
  const body = {
    model,
    messages: systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages,
    temperature: 0.7,
    max_tokens: 2048,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return {
    content: data.choices[0]?.message?.content || "",
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

async function callClaude(
  messages: any[],
  model: string,
  systemPrompt?: string
) {
  const body = {
    model,
    messages,
    system: systemPrompt || undefined,
    temperature: 0.7,
    max_tokens: 2048,
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude error: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return {
    content: data.content[0]?.text || "",
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
    },
  };
}

async function callGemini(
  messages: any[],
  model: string,
  systemPrompt?: string
) {
  const contents = messages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  if (systemPrompt) {
    contents.unshift({
      role: "user",
      parts: [{ text: systemPrompt }],
    });
  }

  const body = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    },
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini error: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

// ─── Whisper (transcrição de áudio) ─────────────────────────────────────────

async function callWhisper(
  audio_base64: string,
  filename: string,
  language: string
): Promise<string> {
  // Decodifica base64 para bytes
  const binaryStr = atob(audio_base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Detecta mimetype pelo filename
  const ext = filename.split(".").pop()?.toLowerCase() || "ogg";
  const mimeMap: Record<string, string> = {
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    m4a: "audio/mp4",
    wav: "audio/wav",
    webm: "audio/webm",
    flac: "audio/flac",
  };
  const mimeType = mimeMap[ext] || "audio/ogg";

  const audioBlob = new Blob([bytes], { type: mimeType });
  const formData = new FormData();
  formData.append("file", audioBlob, filename);
  formData.append("model", "whisper-1");
  formData.append("language", language);
  formData.append("response_format", "json");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Whisper error: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return data.text || "";
}

// ─── TTS (texto para áudio) ──────────────────────────────────────────────────

async function callTTS(
  text: string,
  voice: string,
  model: string
): Promise<string> {
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: "mp3",
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`TTS error: ${resp.status} ${err}`);
  }

  const audioBuffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(audioBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Handler principal ───────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "chat";
    const userId = url.searchParams.get("user_id");

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Missing user_id param" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verificar saldo para todas as ações
    const balance = await getTokenBalance(userId);
    if (balance.saldo_tokens <= 0) {
      return new Response(
        JSON.stringify({ error: "Insufficient tokens", saldo: balance.saldo_tokens }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();

    // ── Whisper ──────────────────────────────────────────────────────────────
    if (action === "whisper") {
      const { audio_base64, filename = "audio.ogg", language = "pt" } = body;

      if (!audio_base64) {
        return new Response(
          JSON.stringify({ error: "Missing audio_base64" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const text = await callWhisper(audio_base64, filename, language);

      // Desconta custo fixo (100 tokens por chamada Whisper)
      const tokensWhisper = Math.round(100 * (COST_FACTORS["whisper-1"] || 0.5));
      await deductTokens(userId, tokensWhisper);

      return new Response(
        JSON.stringify({ text, deducted_tokens: tokensWhisper }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── TTS ──────────────────────────────────────────────────────────────────
    if (action === "tts") {
      const { text, voice = "nova", model = "tts-1" } = body;

      if (!text) {
        return new Response(
          JSON.stringify({ error: "Missing text" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const audio_base64 = await callTTS(text, voice, model);

      // Desconta custo baseado no tamanho do texto (~1 token por 4 chars, fator TTS)
      const tokensTTS = Math.round(
        estimateTokens(text) * (COST_FACTORS[model] || 0.3)
      );
      await deductTokens(userId, tokensTTS);

      return new Response(
        JSON.stringify({ audio_base64, deducted_tokens: tokensTTS }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Chat completions (openai / claude / gemini) ───────────────────────────
    const provider = url.searchParams.get("provider") || "openai";
    const model = url.searchParams.get("model") || "gpt-4o-mini";
    const webSearch = url.searchParams.get("web_search") === "true";
    const { messages, system } = body;

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: "Missing messages array" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    let response;
    if (provider === "openai") {
      response = await callOpenAI(messages, model, system, webSearch);
    } else if (provider === "claude") {
      response = await callClaude(messages, model, system);
    } else if (provider === "gemini") {
      response = await callGemini(messages, model, system);
    } else {
      return new Response(
        JSON.stringify({ error: "Unknown provider: " + provider }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const costFactor = COST_FACTORS[model] || 1.0;
    const totalTokensUsed = response.usage.input_tokens + response.usage.output_tokens;
    const deductedTokens = Math.round(totalTokensUsed * costFactor);

    await deductTokens(userId, deductedTokens);

    return new Response(
      JSON.stringify({
        content: response.content,
        tokens_used: totalTokensUsed,
        cost_factor: costFactor,
        deducted_tokens: deductedTokens,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
