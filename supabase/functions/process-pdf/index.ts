/**
 * Edge Function: process-pdf
 * Recebe um PDF do painel, extrai o texto via GPT-4o,
 * gera embeddings (text-embedding-3-small) e salva na
 * tabela documentos_conhecimento (pgvector).
 *
 * POST multipart/form-data:
 *   - file: PDF file
 *   - nome: string
 *   - categoria: string
 *
 * Requer: Authorization: Bearer <JWT do usuário>
 */

import { serve } from "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY     = Deno.env.get("OPENAI_API_KEY")!;

const CHUNK_SIZE    = 1000;  // chars por chunk
const CHUNK_OVERLAP = 200;   // sobreposição entre chunks

serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // ── Auth ───────────────────────────────────────────────────────────
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return err("Sem autorização", 401, cors);

    const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: { user }, error: authErr } = await adminDb.auth.getUser(token);
    if (authErr || !user) return err("Token inválido", 401, cors);

    // ── Parse multipart ────────────────────────────────────────────────
    const form = await req.formData();
    const file     = form.get("file") as File | null;
    const nome     = (form.get("nome") as string) || file?.name || "Documento";
    const categoria = (form.get("categoria") as string) || "Outros";

    if (!file) return err("Nenhum arquivo enviado", 400, cors);
    if (!file.type.includes("pdf") && !file.name.endsWith(".pdf")) {
      return err("Apenas arquivos PDF são suportados", 400, cors);
    }

    // ── Converte PDF → base64 ──────────────────────────────────────────
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkLen = 8192;
    for (let i = 0; i < uint8.length; i += chunkLen) {
      binary += String.fromCharCode(...uint8.subarray(i, i + chunkLen));
    }
    const base64 = btoa(binary);

    // ── Extrai texto via GPT-4o ────────────────────────────────────────
    const extractRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "Você é um extrator de texto de documentos PDF. Transcreva TODO o conteúdo textual do documento enviado, mantendo a estrutura original (títulos, parágrafos, listas, tabelas). Não omita nenhuma informação. Não adicione comentários, apenas o conteúdo do documento.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Extraia todo o conteúdo de texto deste arquivo PDF chamado "${nome}".`,
              },
              {
                type: "file",
                file: {
                  filename: file.name,
                  file_data: `data:application/pdf;base64,${base64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 8000,
      }),
    });

    if (!extractRes.ok) {
      const errBody = await extractRes.text();
      console.error("OpenAI extract error:", errBody);
      return err("Erro ao extrair texto do PDF via OpenAI: " + errBody, 502, cors);
    }

    const extractJson = await extractRes.json();
    const textoCompleto: string = extractJson.choices?.[0]?.message?.content || "";

    if (!textoCompleto.trim()) {
      return err("Não foi possível extrair texto do PDF. Verifique se o arquivo não está protegido.", 422, cors);
    }

    // ── Divide em chunks ──────────────────────────────────────────────
    const chunks: string[] = [];
    for (let i = 0; i < textoCompleto.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      const chunk = textoCompleto.slice(i, i + CHUNK_SIZE).trim();
      if (chunk.length > 50) chunks.push(chunk);  // ignora chunks muito pequenos
    }

    if (!chunks.length) return err("Texto extraído muito curto ou vazio.", 422, cors);

    // ── Gera embeddings (batch) ───────────────────────────────────────
    const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: chunks,
      }),
    });

    if (!embedRes.ok) {
      const errBody = await embedRes.text();
      return err("Erro ao gerar embeddings: " + errBody, 502, cors);
    }

    const embedJson = await embedRes.json();
    const embeddings: number[][] = embedJson.data.map((d: any) => d.embedding);

    // ── Deleta versão anterior do mesmo documento (mesmo user_id + nome) ─
    await adminDb
      .from("documentos_conhecimento")
      .delete()
      .eq("user_id", user.id)
      .contains("metadata", { nome });

    // ── Salva chunks no Supabase ──────────────────────────────────────
    const rows = chunks.map((chunk, i) => ({
      user_id:   user.id,
      conteudo:  chunk,
      metadata:  {
        nome,
        categoria,
        chunk_index: i,
        total_chunks: chunks.length,
        uploadedAt: new Date().toISOString(),
        user_id: user.id,
      },
      embedding: `[${embeddings[i].join(",")}]`,
    }));

    // Insere em batches de 50
    for (let i = 0; i < rows.length; i += 50) {
      const { error: insErr } = await adminDb
        .from("documentos_conhecimento")
        .insert(rows.slice(i, i + 50));
      if (insErr) {
        console.error("Insert error:", insErr);
        return err("Erro ao salvar no banco: " + insErr.message, 500, cors);
      }
    }

    return json({
      success: true,
      nome,
      categoria,
      chunks: chunks.length,
      chars: textoCompleto.length,
    }, 200, cors);

  } catch (e: any) {
    console.error("process-pdf error:", e);
    return err(e.message, 500, cors);
  }
});

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function err(msg: string, status = 400, headers: Record<string, string> = {}) {
  return json({ error: msg }, status, headers);
}
