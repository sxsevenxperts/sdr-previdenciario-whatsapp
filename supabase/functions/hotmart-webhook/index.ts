/**
 * Edge Function: hotmart-webhook
 * Recebe eventos de pagamento da Hotmart e gerencia o ciclo de vida dos clientes.
 *
 * Ativação: PURCHASE_APPROVED, PURCHASE_COMPLETE, PURCHASE_REACTIVATED, SUBSCRIPTION_REACTIVATED
 *   → cria usuário, instância EVO, agente_config padrão, envia e-mail de boas-vindas
 *
 * Desativação: SUBSCRIPTION_CANCELLATION, PURCHASE_CANCELED, PURCHASE_REFUNDED, PURCHASE_CHARGEBACK
 *   → define active=false e status da assinatura como cancelado
 *
 * Endpoint público (verify_jwt: false) — validado pelo token Hotmart no header.
 */

import { serve } from "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EVOLUTION_API_URL   = Deno.env.get("EVOLUTION_API_URL")!;   // ex: https://evo.sevenxperts.solutions
const EVOLUTION_API_KEY   = Deno.env.get("EVOLUTION_API_KEY")!;   // ex: 2ae3Y0xQFNxIcng27ufbAaHzioCDfReN
const HOTMART_SECRET      = Deno.env.get("HOTMART_WEBHOOK_SECRET") ?? ""; // opcional: token de segurança

const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Eventos que ativam/reativam o cliente
const EVENTS_ACTIVATE = [
  "PURCHASE_APPROVED",
  "PURCHASE_COMPLETE",
  "PURCHASE_REACTIVATED",
  "SUBSCRIPTION_REACTIVATED",
];

// Eventos que desativam o cliente
const EVENTS_DEACTIVATE = [
  "SUBSCRIPTION_CANCELLATION",
  "PURCHASE_CANCELED",
  "PURCHASE_REFUNDED",
  "PURCHASE_CHARGEBACK",
];

// Defaults do agente (mesmos valores do painel)
const AGENTE_DEFAULTS: Record<string, string> = {
  objetivo: "Qualificar leads de Direito Previdenciário e encaminhar ao advogado responsável para avaliação do caso.",
  prompt_sistema: [
    "Você é um assistente especializado em triagem de casos de Direito Previdenciário.",
    "Seu papel é conversar de forma humanizada, empática e objetiva com pessoas que buscam ajuda jurídica previdenciária, qualificá-las e, quando aplicável, encaminhar o caso para um advogado.",
    "",
    "Você NÃO é advogado e NÃO dá consultoria jurídica. Você apenas coleta informações para que o advogado responsável possa avaliar o caso.",
    "",
    "FLUXO DA CONVERSA:",
    "",
    "Etapa 1 — Recepção:",
    'Cumprimente o lead pelo nome (se disponível):',
    '"Olá! Sou o assistente jurídico do escritório. Vou fazer algumas perguntas rápidas para entender melhor a sua situação e verificar se podemos te ajudar. Pode ser?"',
    "",
    "Etapa 2 — Coleta de informações (faça UMA pergunta por vez):",
    '1. "Qual é o seu nome completo?"',
    '2. "Você contribuiu para o INSS em algum momento da sua vida, ou é dependente de alguém que contribuiu?"',
    '3. "Qual é a sua situação atual? Por exemplo: benefício negado, cancelado, aposentadoria que ainda não pediu, pensão por morte, auxílio-doença, BPC/LOAS, ou outro?"',
    '4. "Você já tentou dar entrada no benefício? Se sim, o que aconteceu?"',
    '5. "Você tem documentos como carteira de trabalho, extrato do CNIS, carta de indeferimento do INSS ou outros?"',
    '6. "Qual o seu número de celular com DDD para o advogado entrar em contato?"',
    "",
    "DESQUALIFICAÇÃO IMEDIATA (encerre com empatia se):",
    "- Caso é trabalhista puro, sem vínculo com INSS",
    "- Caso já está em andamento com outro advogado",
    "- Pessoa não quer fornecer informações básicas",
    "- Caso já foi julgado com trânsito em julgado sem possibilidade de revisão",
    "",
    "BUSCA NA WEB:",
    "Se necessário para identificar a tese jurídica, use a ferramenta de busca.",
    "Priorize fontes: gov.br, previdencia.gov.br, JusBrasil, STJ, TRF.",
    "",
    "FORMATO DE SAÍDA OBRIGATÓRIO:",
    "Ao concluir a triagem, inclua NO FINAL da sua última mensagem o JSON abaixo:",
    "",
    "Para lead qualificado:",
    "```json",
    '{"qualificado":true,"nome":"Nome Completo","celular":"DDD+número","tese":"Tese jurídica identificada","resumo":"Resumo completo da conversa"}',
    "```",
    "",
    "Para lead não qualificado:",
    "```json",
    '{"qualificado":false,"motivo":"Motivo da desqualificação"}',
    "```",
  ].join("\n"),
  tonalidade:
    'Empático, claro e objetivo. Use linguagem simples, sem jargão jurídico. Seja especialmente gentil com idosos ou pessoas em situação vulnerável. Se o lead fizer uma pergunta jurídica específica, responda de forma genérica e direcione: "Essa é uma excelente pergunta para o advogado aprofundar com você!"',
  instrucoes_comunicacao:
    "- Faça uma pergunta por vez. Aguarde a resposta antes de continuar.\n- Nunca prometa resultado ou vitória no processo.\n- Nunca dê consultoria jurídica.\n- Limite a conversa ao máximo de 10 trocas de mensagens antes de concluir a triagem.\n- Se o lead demorar mais de 24h para responder, envie um lembrete gentil uma única vez.\n- Se o lead enviar um arquivo (foto, PDF), confirme o recebimento e registre no caso.",
  criterios_qualificacao:
    "1. Vínculo INSS — Contribuiu ao INSS ou é dependente de quem contribuiu\n2. Benefício identificável — Existe um benefício previdenciário aplicável ao caso\n3. Indeferimento ou pendência — Benefício foi negado, cancelado ou ainda não foi requerido\n4. Tese jurídica — É possível identificar uma tese/fundamento legal para o caso\n5. Documentação mínima — Possui ao menos algum documento ou sabe como obtê-lo",
  msg_qualificado:
    "Ótimo! Com base no que você me contou, acredito que o nosso advogado pode te ajudar. Vou encaminhar as informações do seu caso para ele agora. Em breve ele entrará em contato com você. Alguma dúvida ou informação adicional que queira que eu repasse?",
  msg_desqualificado:
    "Obrigado por entrar em contato! Infelizmente, com base nas informações que você compartilhou, não identificamos uma situação que se encaixe nos casos que atendemos no momento. Caso sua situação mude ou surja algum documento novo, fique à vontade para nos contatar novamente. Desejamos tudo de bom para você!",
  numero_destino: "",
};

/** Gera nome de instância único a partir do nome/email do comprador */
function generateInstanceName(name: string, email: string): string {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .replace(/[^a-z0-9]/g, "")
      .substring(0, 12);

  const base = normalize(name) || normalize(email.split("@")[0]);
  const validBase = base.length >= 3 ? base : "cliente";
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return validBase + suffix;
}

/** Cria instância na Evolution API */
async function createEvoInstance(instanceName: string): Promise<void> {
  const res = await fetch(`${EVOLUTION_API_URL}/instance/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      instanceName,
      qrcode: false,
      integration: "WHATSAPP-BAILEYS",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("EVO create error:", res.status, body);
    // Não lançamos erro — instância pode ser configurada depois pelo admin
  }
}

/** Insere agente_config padrão para o usuário */
async function insertAgenteConfigDefaults(userId: string): Promise<void> {
  const rows = Object.entries(AGENTE_DEFAULTS).map(([chave, valor]) => ({
    user_id: userId,
    chave,
    valor,
  }));
  await adminDb.from("agente_config").upsert(rows, { onConflict: "user_id,chave", ignoreDuplicates: true });
}

/** Ativa (cria ou reativa) um cliente a partir dos dados da Hotmart */
async function activateClient(buyerName: string, buyerEmail: string, productName: string): Promise<void> {
  // Verifica se usuário já existe
  const { data: { users: existingUsers } } = await adminDb.auth.admin.listUsers();
  const existing = (existingUsers ?? []).find((u: any) => u.email === buyerEmail);

  if (existing) {
    // Reativa conta existente
    const userId = existing.id;
    await adminDb.from("profiles").update({ active: true }).eq("id", userId);
    await adminDb
      .from("assinaturas")
      .update({ status: "ativo", atualizado_em: new Date().toISOString() })
      .eq("user_id", userId);

    console.log("Cliente reativado:", buyerEmail, userId);
    return;
  }

  // Novo cliente → cria conta completa
  const instanceName = generateInstanceName(buyerName, buyerEmail);

  // 1. Cria instância EVO (não-bloqueante)
  await createEvoInstance(instanceName);

  // 2. Cria usuário no Supabase Auth
  const tempPassword = crypto.randomUUID(); // senha temporária; usuário vai redefinir
  const { data: created, error: createErr } = await adminDb.auth.admin.createUser({
    email: buyerEmail,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { display_name: buyerName, role: "client" },
  });

  if (createErr || !created.user) {
    console.error("Erro ao criar usuário:", createErr?.message);
    return;
  }

  const userId = created.user.id;

  // 3. Profile
  await adminDb.from("profiles").upsert({
    id: userId,
    role: "client",
    display_name: buyerName,
    evo_instance: instanceName,
    active: true,
  });

  // 4. Assinatura
  await adminDb.from("assinaturas").insert({
    user_id: userId,
    plano: productName || "SDR Agente Único",
    valor: 497.0,
    status: "ativo",
  });

  // 5. Créditos iniciais
  await adminDb.from("tokens_creditos").upsert({
    user_id: userId,
    saldo_tokens: 500000,
    tokens_usados_mes: 0,
    total_comprado: 500000,
    mes_referencia: new Date().toISOString().slice(0, 7),
  });

  // 6. Agente config padrão
  await insertAgenteConfigDefaults(userId);

  // 7. Envia e-mail de redefinição de senha (usuário define sua própria senha)
  await adminDb.auth.admin.generateLink({
    type: "recovery",
    email: buyerEmail,
    options: { redirectTo: `https://xpertia.sevenxperts.solutions/` },
  });

  console.log("Cliente criado:", buyerEmail, userId, "instância:", instanceName);
}

/** Desativa um cliente */
async function deactivateClient(buyerEmail: string): Promise<void> {
  const { data: { users } } = await adminDb.auth.admin.listUsers();
  const found = (users ?? []).find((u: any) => u.email === buyerEmail);
  if (!found) {
    console.warn("Usuário não encontrado para desativar:", buyerEmail);
    return;
  }

  const userId = found.id;
  await adminDb.from("profiles").update({ active: false }).eq("id", userId);
  await adminDb
    .from("assinaturas")
    .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
    .eq("user_id", userId);

  console.log("Cliente desativado:", buyerEmail, userId);
}

serve(async (req) => {
  // CORS preflight (caso alguma ferramenta teste via browser)
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, x-hotmart-webhook-token",
      },
    });
  }

  try {
    // Validação opcional do token secreto da Hotmart
    if (HOTMART_SECRET) {
      const receivedToken = req.headers.get("x-hotmart-webhook-token") ?? "";
      if (receivedToken !== HOTMART_SECRET) {
        console.warn("Token Hotmart inválido");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const payload = await req.json();
    const event: string = payload?.event ?? "";
    const buyer = payload?.data?.buyer ?? {};
    const product = payload?.data?.product ?? {};

    const buyerName  = buyer?.name  ?? "Cliente";
    const buyerEmail = (buyer?.email ?? "").toLowerCase().trim();

    if (!buyerEmail) {
      console.warn("Payload sem email do comprador:", JSON.stringify(payload));
      return new Response(JSON.stringify({ ok: false, reason: "sem email" }), { status: 200 });
    }

    console.log("Hotmart event:", event, "| email:", buyerEmail);

    if (EVENTS_ACTIVATE.includes(event)) {
      await activateClient(buyerName, buyerEmail, product?.name ?? "SDR Agente Único");
      return new Response(JSON.stringify({ ok: true, action: "activated" }), { status: 200 });
    }

    if (EVENTS_DEACTIVATE.includes(event)) {
      await deactivateClient(buyerEmail);
      return new Response(JSON.stringify({ ok: true, action: "deactivated" }), { status: 200 });
    }

    // Evento não tratado — retorna 200 para Hotmart não retentar
    console.log("Evento ignorado:", event);
    return new Response(JSON.stringify({ ok: true, action: "ignored" }), { status: 200 });

  } catch (err: any) {
    console.error("hotmart-webhook error:", err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
});
