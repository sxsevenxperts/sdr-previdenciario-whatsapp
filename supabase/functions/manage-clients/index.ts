/**
 * Edge Function: manage-clients
 * Permite ao admin criar, listar, ativar/desativar e deletar clientes.
 * Requer JWT de usuário com role = 'admin' no header Authorization.
 *
 * Métodos:
 *   GET    → lista todos os clientes (profiles + assinaturas)
 *   POST   → cria novo cliente (cria auth user + profile + tokens_creditos)
 *   PATCH  → atualiza campos do cliente (active, plano, evo_instance, etc.)
 *   DELETE → deleta cliente (remove do Auth, cascade nas tabelas)
 */

import { serve } from "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Client com service role (ignora RLS — usado só internamente após verificar admin)
const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verifica JWT e extrai user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Sem autorização" }, 401, corsHeaders);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await adminDb.auth.getUser(token);
    if (authErr || !user) return json({ error: "Token inválido" }, 401, corsHeaders);

    // Verifica se é admin
    const { data: profile } = await adminDb
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "admin") {
      return json({ error: "Acesso negado. Apenas administradores." }, 403, corsHeaders);
    }

    // ── GET: lista clientes ──────────────────────────────────────────────
    if (req.method === "GET") {
      const { data: profiles } = await adminDb
        .from("profiles")
        .select("id, role, display_name, evo_instance, active, created_at")
        .order("created_at", { ascending: false });

      const { data: assinaturas } = await adminDb
        .from("assinaturas")
        .select("user_id, plano, status, valor, proxima_cobranca");

      const assMap: Record<string, any> = {};
      (assinaturas || []).forEach((a) => (assMap[a.user_id] = a));

      const result = (profiles || []).map((p) => ({
        ...p,
        assinatura: assMap[p.id] || null,
        email: null, // preenchido abaixo
      }));

      // Busca emails via Auth Admin API
      const { data: { users: authUsers } } = await adminDb.auth.admin.listUsers();
      const emailMap: Record<string, string> = {};
      (authUsers || []).forEach((u: any) => (emailMap[u.id] = u.email));
      result.forEach((r) => (r.email = emailMap[r.id] || ""));

      return json({ users: result }, 200, corsHeaders);
    }

    // ── POST: cria cliente ───────────────────────────────────────────────
    if (req.method === "POST") {
      const { name, email, password, evo_instance, plano, valor, tokens_iniciais } = await req.json();

      if (!email || !password) return json({ error: "email e password obrigatórios" }, 400, corsHeaders);

      // Cria usuário no Auth
      const { data: created, error: createErr } = await adminDb.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: name || email, role: "client" },
      });

      if (createErr) return json({ error: createErr.message }, 400, corsHeaders);

      const userId = created.user!.id;

      // Profile (criado pelo trigger, mas garante campos extras)
      await adminDb.from("profiles").upsert({
        id: userId,
        role: "client",
        display_name: name || email,
        evo_instance: evo_instance || "",
        active: true,
      });

      // Assinatura
      await adminDb.from("assinaturas").insert({
        user_id: userId,
        plano: plano || "SDR Agente Único",
        valor: valor || 497.00,
        status: "trial",
      });

      // Créditos iniciais
      await adminDb.from("tokens_creditos").upsert({
        user_id: userId,
        saldo_tokens: tokens_iniciais || 500000,
        tokens_usados_mes: 0,
        total_comprado: tokens_iniciais || 500000,
        mes_referencia: new Date().toISOString().slice(0, 7),
      });

      return json({ success: true, user_id: userId }, 200, corsHeaders);
    }

    // ── PATCH: atualiza cliente ──────────────────────────────────────────
    if (req.method === "PATCH") {
      const body = await req.json();
      const { user_id, ...fields } = body;
      if (!user_id) return json({ error: "user_id obrigatório" }, 400, corsHeaders);

      // Campos de profile
      const profileFields: any = {};
      if ("active"       in fields) profileFields.active       = fields.active;
      if ("display_name" in fields) profileFields.display_name = fields.display_name;
      if ("evo_instance" in fields) profileFields.evo_instance = fields.evo_instance;
      if ("role"         in fields) profileFields.role         = fields.role;

      if (Object.keys(profileFields).length) {
        await adminDb.from("profiles").update(profileFields).eq("id", user_id);
      }

      // Campos de assinatura
      const assFields: any = {};
      if ("plano"            in fields) assFields.plano            = fields.plano;
      if ("status"           in fields) assFields.status           = fields.status;
      if ("valor"            in fields) assFields.valor            = fields.valor;
      if ("proxima_cobranca" in fields) assFields.proxima_cobranca = fields.proxima_cobranca;

      if (Object.keys(assFields).length) {
        await adminDb.from("assinaturas").update({ ...assFields, atualizado_em: new Date().toISOString() }).eq("user_id", user_id);
      }

      // Reset de senha
      if (fields.new_password) {
        await adminDb.auth.admin.updateUserById(user_id, { password: fields.new_password });
      }

      // Adicionar tokens manualmente
      if (fields.add_tokens) {
        await adminDb.from("tokens_creditos").upsert({
          user_id,
          saldo_tokens: fields.add_tokens,
          tokens_usados_mes: 0,
          total_comprado: fields.add_tokens,
          mes_referencia: new Date().toISOString().slice(0, 7),
          atualizado_em: new Date().toISOString(),
        }, { onConflict: "user_id", ignoreDuplicates: false });

        // Incrementa via RPC para não sobrescrever saldo existente
        await adminDb.rpc("incrementar_tokens", { uid: user_id, qtd: fields.add_tokens });
      }

      return json({ success: true }, 200, corsHeaders);
    }

    // ── DELETE: remove cliente ───────────────────────────────────────────
    if (req.method === "DELETE") {
      const { user_id } = await req.json();
      if (!user_id) return json({ error: "user_id obrigatório" }, 400, corsHeaders);

      // Segurança: não pode deletar a si mesmo
      if (user_id === user.id) return json({ error: "Não pode deletar sua própria conta" }, 400, corsHeaders);

      const { error: delErr } = await adminDb.auth.admin.deleteUser(user_id);
      if (delErr) return json({ error: delErr.message }, 400, corsHeaders);

      return json({ success: true }, 200, corsHeaders);
    }

    return json({ error: "Método não suportado" }, 405, corsHeaders);

  } catch (err: any) {
    return json({ error: err.message }, 500, corsHeaders);
  }
});

function json(data: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
