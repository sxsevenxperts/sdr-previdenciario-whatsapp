/**
 * Edge Function: manage-clients
 * Permite ao admin criar, listar, ativar/desativar e deletar clientes.
 * Requer JWT de usuário com role = 'admin' no header Authorization.
 *
 * Métodos:
 *   GET    → lista todos os clientes (profiles + assinaturas)
 *   POST   → cria novo cliente (cria auth user + profile + tokens_creditos + EVO instance + agente_config)
 *   PATCH  → atualiza campos do cliente (active, plano, evo_instance, etc.)
 *   DELETE → deleta cliente (remove do Auth, cascade nas tabelas)
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EVOLUTION_API_URL = Deno.env.get("EVOLUTION_API_URL")!;
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY")!;

// Client com service role (ignora RLS — usado só internamente após verificar admin)
const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/** Gera nome de instância único a partir do nome/email do cliente */
function generateInstanceName(name: string, email: string): string {
  const normalize = (s: string) =>
    s.toLowerCase().normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .replace(/[^a-z0-9]/g, "")
      .substring(0, 12);
  const base = normalize(name) || normalize(email.split("@")[0]);
  const validBase = base.length >= 3 ? base : "cliente";
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return validBase + suffix;
}

/** Cria instância na Evolution API (não-bloqueante em caso de erro) */
async function createEvoInstance(instanceName: string): Promise<void> {
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/instance/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ instanceName, qrcode: false, integration: "WHATSAPP-BAILEYS" }),
    });
    if (!res.ok) console.error("EVO create error:", res.status, await res.text());
  } catch (e: any) {
    console.error("EVO create exception:", e.message);
  }
}

/** Defaults do agente para novos clientes */
const AGENTE_DEFAULTS: Record<string, string> = {
  objetivo: "Qualificar leads interessados nos produtos e serviços da empresa e encaminhar ao responsável comercial para dar continuidade.",
  prompt_sistema: [
    "Você é um assistente de vendas especializado em qualificação de leads.",
    "Seu papel é conversar de forma humanizada, empática e objetiva com pessoas que entraram em contato, qualificá-las e, quando aplicável, encaminhar para o responsável comercial.",
    "",
    "Você NÃO fecha vendas e NÃO faz promessas de preço. Você apenas coleta informações para que o time comercial possa dar continuidade.",
    "",
    "FLUXO DA CONVERSA:",
    "",
    "Etapa 1 — Recepção:",
    'Cumprimente o lead pelo nome (se disponível): "Olá! Sou o assistente da empresa. Vou fazer algumas perguntas rápidas para entender melhor o que você precisa e verificar como podemos te ajudar. Pode ser?"',
    "",
    "Etapa 2 — Coleta de informações (faça UMA pergunta por vez):",
    '1. "Qual é o seu nome completo?"',
    '2. "Qual produto ou serviço te interessou?"',
    '3. "Pode me contar um pouco mais sobre a sua necessidade ou situação atual?"',
    '4. "Você tem algum prazo ou urgência para resolver isso?"',
    '5. "Você é o responsável pela decisão de compra ou há outras pessoas envolvidas?"',
    '6. "Qual o seu número de celular com DDD para o nosso time entrar em contato?"',
    "",
    "DESQUALIFICAÇÃO IMEDIATA (encerre com educação se):",
    "- Pessoa não tem interesse real no produto ou serviço",
    "- Já é cliente e o assunto é suporte (redirecione para o canal correto)",
    "- Pessoa não quer fornecer informações básicas",
    "- Fora do perfil de cliente atendido pela empresa",
    "",
    "BUSCA NA WEB:",
    "Se necessário para tirar dúvidas sobre produtos ou serviços, use a ferramenta de busca.",
    "Priorize informações do site oficial da empresa.",
    "",
    "FORMATO DE SAÍDA OBRIGATÓRIO:",
    "Ao concluir a triagem, inclua NO FINAL da sua última mensagem o JSON abaixo:",
    "",
    "Para lead qualificado:",
    "```json",
    '{"qualificado":true,"nome":"Nome Completo","celular":"DDD+número","tese":"Produto/Serviço de interesse identificado","resumo":"Resumo completo da conversa"}',
    "```",
    "",
    "Para lead não qualificado:",
    "```json",
    '{"qualificado":false,"motivo":"Motivo da desqualificação"}',
    "```",
  ].join("\n"),
  tonalidade: 'Empático, claro e objetivo. Use linguagem simples e acessível. Seja especialmente atencioso com pessoas que ainda estão descobrindo o produto. Se o lead fizer uma pergunta técnica específica, responda de forma genérica e direcione: "Essa é uma excelente pergunta para o nosso especialista aprofundar com você!"',
  instrucoes_comunicacao: "- Faça uma pergunta por vez. Aguarde a resposta antes de continuar.\n- Nunca prometa desconto, prazo ou resultado sem confirmação do time.\n- Nunca feche negócio ou passe valores sem autorização.\n- Limite a conversa ao máximo de 10 trocas de mensagens antes de concluir a triagem.\n- Se o lead demorar mais de 24h para responder, envie um lembrete gentil uma única vez.\n- Se o lead enviar um arquivo (foto, PDF), confirme o recebimento e registre.",
  criterios_qualificacao: "1. Interesse real — Demonstrou interesse genuíno no produto ou serviço\n2. Necessidade identificada — Tem uma necessidade ou problema que a empresa pode resolver\n3. Capacidade de compra — Possui orçamento ou capacidade de investimento\n4. Tomador de decisão — É o responsável pela decisão ou influencia diretamente\n5. Disposição para avançar — Mostrou disposição em dar próximos passos",
  msg_qualificado: "Ótimo! Com base no que você me contou, acredito que podemos te ajudar. Vou encaminhar as informações para o nosso time agora. Em breve alguém entrará em contato com você. Alguma dúvida ou informação adicional que queira que eu repasse?",
  msg_desqualificado: "Obrigado por entrar em contato! Com base nas informações que você compartilhou, no momento não identificamos o encaixe ideal com os nossos produtos ou serviços. Caso sua situação mude, fique à vontade para nos contatar novamente. Desejamos tudo de bom para você!",
  numero_destino: "",
};

/** Insere agente_config padrão para um novo usuário */
async function insertAgenteConfigDefaults(userId: string): Promise<void> {
  const rows = Object.entries(AGENTE_DEFAULTS).map(([chave, valor]) => ({ user_id: userId, chave, valor }));
  await adminDb.from("agente_config").upsert(rows, { onConflict: "user_id,chave", ignoreDuplicates: true });
}

Deno.serve(async (req) => {
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

      // Auto-gera nome da instância se não informado
      const instanceName = (evo_instance || "").trim().replace(/\s+/g, "") || generateInstanceName(name || "", email);

      // Cria instância EVO (não-bloqueante — falha silenciosa)
      await createEvoInstance(instanceName);

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
        evo_instance: instanceName,
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

      // Agente config padrão
      await insertAgenteConfigDefaults(userId);

      return json({ success: true, user_id: userId, evo_instance: instanceName }, 200, corsHeaders);
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
