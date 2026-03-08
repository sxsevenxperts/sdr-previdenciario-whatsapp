/**
 * Edge Function: gcal-proxy
 * Integração com Google Calendar via OAuth 2.0.
 *
 * ?action=auth-url          → retorna URL de autorização OAuth do Google
 * ?action=callback&code=XX  → troca code por tokens e salva em agente_config
 * ?action=create-event      POST → cria evento no calendário do usuário
 * ?action=status            → retorna se a conta Google está conectada
 * ?action=disconnect        → revoga tokens e remove integração
 *
 * Requer: Authorization: Bearer <JWT do usuário>
 * Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID     = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("GCAL_REDIRECT_URI") ?? `${SUPABASE_URL}/functions/v1/gcal-proxy?action=callback`;

const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── callback é chamado pelo Google (sem JWT) ──────────────────────────────
  if (action === "callback") {
    return await handleCallback(url, cors);
  }

  // ── Demais actions requerem JWT ───────────────────────────────────────────
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return json({ error: "Sem autorização" }, 401, cors);

  const { data: { user }, error: authErr } = await adminDb.auth.getUser(token);
  if (authErr || !user) return json({ error: "Token inválido" }, 401, cors);

  try {
    switch (action) {
      case "auth-url": {
        if (!GOOGLE_CLIENT_ID) return json({ error: "GOOGLE_CLIENT_ID não configurado" }, 500, cors);
        const state = btoa(JSON.stringify({ uid: user.id }));
        const params = new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
          state,
        });
        return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }, 200, cors);
      }

      case "status": {
        const cfg = await getGCalConfig(user.id);
        return json({
          connected: !!(cfg?.access_token),
          email: cfg?.google_email ?? null,
        }, 200, cors);
      }

      case "disconnect": {
        await adminDb.from("agente_config")
          .delete()
          .eq("user_id", user.id)
          .in("chave", ["gcal_access_token", "gcal_refresh_token", "gcal_expiry", "gcal_email"]);
        return json({ ok: true }, 200, cors);
      }

      case "create-event": {
        const body = await req.json();
        const result = await createEvent(user.id, body);
        return json(result, 200, cors);
      }

      default:
        return json({ error: `Action "${action}" não suportada` }, 400, cors);
    }
  } catch (e: any) {
    console.error("gcal-proxy error:", e);
    return json({ error: e.message }, 500, cors);
  }
});

// ── Callback OAuth ────────────────────────────────────────────────────────────
async function handleCallback(url: URL, cors: Record<string, string>): Promise<Response> {
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return json({ error: "Parâmetros inválidos" }, 400, cors);

  let uid: string;
  try {
    uid = JSON.parse(atob(state)).uid;
  } catch {
    return json({ error: "State inválido" }, 400, cors);
  }

  // Troca code por tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenRes.json();
  if (tokens.error) return json({ error: tokens.error_description ?? tokens.error }, 400, cors);

  // Busca e-mail do usuário Google
  const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const info = await infoRes.json();
  const expiry = Date.now() + (tokens.expires_in ?? 3600) * 1000;

  // Persiste tokens em agente_config
  await upsertConfig(uid, "gcal_access_token",  tokens.access_token);
  await upsertConfig(uid, "gcal_refresh_token", tokens.refresh_token ?? "");
  await upsertConfig(uid, "gcal_expiry",        String(expiry));
  await upsertConfig(uid, "gcal_email",         info.email ?? "");

  // Redireciona de volta ao painel
  const appOrigin = Deno.env.get("APP_ORIGIN") ?? "https://app.xpert.ia";
  return Response.redirect(`${appOrigin}/?gcal=connected`, 302);
}

// ── Criar evento ──────────────────────────────────────────────────────────────
async function createEvent(userId: string, body: {
  summary: string;
  description?: string;
  start: string;   // ISO datetime "2026-03-10T14:00:00"
  end: string;     // ISO datetime
  timeZone?: string;
  attendees?: string[];
}) {
  const accessToken = await getFreshToken(userId);

  const event: Record<string, unknown> = {
    summary:     body.summary,
    description: body.description ?? "",
    start:       { dateTime: body.start, timeZone: body.timeZone ?? "America/Sao_Paulo" },
    end:         { dateTime: body.end,   timeZone: body.timeZone ?? "America/Sao_Paulo" },
  };
  if (body.attendees?.length) {
    event.attendees = body.attendees.map(e => ({ email: e }));
  }

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Erro ao criar evento");
  return { ok: true, event_id: data.id, html_link: data.htmlLink };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getGCalConfig(userId: string) {
  const { data } = await adminDb
    .from("agente_config")
    .select("chave, valor")
    .eq("user_id", userId)
    .in("chave", ["gcal_access_token", "gcal_refresh_token", "gcal_expiry", "gcal_email"]);
  if (!data?.length) return null;
  const cfg = Object.fromEntries(data.map(r => [r.chave.replace("gcal_",""), r.valor]));
  return cfg as { access_token?: string; refresh_token?: string; expiry?: string; google_email?: string };
}

async function getFreshToken(userId: string): Promise<string> {
  const cfg = await getGCalConfig(userId);
  if (!cfg?.access_token) throw new Error("Google Calendar não conectado. Configure em Agente → Integrações.");

  const expiry = Number(cfg.expiry ?? 0);
  if (Date.now() < expiry - 60_000) return cfg.access_token;

  // Refresh
  if (!cfg.refresh_token) throw new Error("Refresh token ausente. Reconecte o Google Calendar.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: cfg.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokens = await res.json();
  if (tokens.error) throw new Error(tokens.error_description ?? "Falha ao renovar token Google");

  const newExpiry = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  await upsertConfig(userId, "gcal_access_token", tokens.access_token);
  await upsertConfig(userId, "gcal_expiry",       String(newExpiry));
  return tokens.access_token;
}

async function upsertConfig(userId: string, chave: string, valor: string) {
  await adminDb.from("agente_config").upsert(
    { user_id: userId, chave, valor },
    { onConflict: "user_id,chave" }
  );
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
