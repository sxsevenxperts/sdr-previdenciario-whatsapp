/**
 * Edge Function: evo-proxy
 * Proxy seguro para a Evolution API — nunca expõe a chave no frontend.
 * Resolve a instância do usuário automaticamente pelo JWT.
 *
 * GET/POST ?action=status|connect|logout|send-text
 *
 * Requer: Authorization: Bearer <JWT do usuário>
 * Env vars: EVOLUTION_API_URL, EVOLUTION_API_KEY
 */

import { serve } from "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EVO_URL          = Deno.env.get("EVOLUTION_API_URL")!;
const EVO_KEY          = Deno.env.get("EVOLUTION_API_KEY")!;

const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // ── Auth ──────────────────────────────────────────────────────────────
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return json({ error: "Sem autorização" }, 401, cors);

    const { data: { user }, error: authErr } = await adminDb.auth.getUser(token);
    if (authErr || !user) return json({ error: "Token inválido" }, 401, cors);

    // ── Resolve instância do usuário ─────────────────────────────────────
    const { data: profile } = await adminDb
      .from("profiles")
      .select("evo_instance, active")
      .eq("id", user.id)
      .single();

    if (!profile) return json({ error: "Perfil não encontrado" }, 404, cors);
    if (!profile.active) return json({ error: "Conta desativada. Contate o administrador." }, 403, cors);
    if (!profile.evo_instance) return json({ error: "Instância Evolution API não configurada. Contate o administrador." }, 400, cors);

    const instance = profile.evo_instance;

    // ── Action router ────────────────────────────────────────────────────
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    switch (action) {
      // Verifica status da instância (conectada ou não)
      case "status": {
        const res = await evoFetch(`/instance/connectionState/${instance}`, "GET");
        return json(res, 200, cors);
      }

      // Gera QR Code para conectar o WhatsApp
      case "connect": {
        const res = await evoFetch(`/instance/connect/${instance}`, "GET");
        return json(res, 200, cors);
      }

      // Desconecta o WhatsApp
      case "logout": {
        const res = await evoFetch(`/instance/logout/${instance}`, "DELETE");
        return json(res, 200, cors);
      }

      // Envia mensagem de texto via WhatsApp
      case "send-text": {
        const body = await req.json();
        if (!body.number || !body.text) {
          return json({ error: "number e text são obrigatórios" }, 400, cors);
        }
        const res = await evoFetch(`/message/sendText/${instance}`, "POST", {
          number: body.number,
          text: body.text,
        });
        return json(res, 200, cors);
      }

      default:
        return json({ error: `Action "${action}" não suportada. Use: status, connect, logout, send-text` }, 400, cors);
    }

  } catch (e: any) {
    console.error("evo-proxy error:", e);
    return json({ error: e.message }, 500, cors);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function evoFetch(path: string, method: string, body?: unknown) {
  const baseUrl = EVO_URL.replace(/\/+$/, ""); // remove trailing slash
  const opts: RequestInit = {
    method,
    headers: {
      "apikey": EVO_KEY,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl}${path}`, opts);

  // Tenta parsear como JSON, senão retorna texto
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await res.json();
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
