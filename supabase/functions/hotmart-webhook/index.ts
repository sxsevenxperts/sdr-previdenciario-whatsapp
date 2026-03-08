/**
 * Edge Function: hotmart-webhook
 * Recebe eventos de pagamento da Hotmart e gerencia o ciclo de vida dos clientes.
 *
 * ATIVAÇÃO: PURCHASE_APPROVED, PURCHASE_COMPLETE, PURCHASE_REACTIVATED, SUBSCRIPTION_REACTIVATED
 *   → cria usuário novo OU reativa conta existente OU aplica addon
 *
 * DESATIVAÇÃO: SUBSCRIPTION_CANCELLATION, PURCHASE_CANCELED, PURCHASE_REFUNDED, PURCHASE_CHARGEBACK
 *   → se for addon: remove apenas aquele recurso
 *   → se for produto principal: desativa conta
 *
 * RENOVAÇÃO (cartão — recurrence_number > 1):
 *   → addons recorrentes (agente, número, usuário): ignoram o incremento (já ativo)
 *   → tokens e produto principal: somam ao saldo normalmente
 *
 * ADDONS (identificados pelo offer code da Hotmart — todas as ofertas pertencem ao produto 7336568):
 *   → atualiza assinatura do cliente existente
 *   → Offer codes hardcoded: cjszocj0 (agente), 8ivu9gbb (objeção), w17oc1q3 (número),
 *     vhne1box (usuário), f623v6bt/z9f5y7h3/yfbmox0t/e23bospr (tokens)
 *
 * Endpoint público (verify_jwt: false).
 * Segurança: token secreto via HOTMART_WEBHOOK_SECRET (query param ?token= ou header X-Hotmart-Webhook-Token).
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EVOLUTION_API_URL = Deno.env.get("EVOLUTION_API_URL") ?? "";
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
const HOTMART_SECRET    = Deno.env.get("HOTMART_WEBHOOK_SECRET") ?? "";
const PANEL_URL         = Deno.env.get("PANEL_URL") ?? "https://xpertia.sevenxperts.solutions/";

// ID do produto principal XPERT.IA na Hotmart.
// Se configurado, apenas este produto ativa/desativa contas.
// Se vazio, qualquer produto não-addon ativa contas (fallback).
const MAIN_PRODUCT_ID   = Deno.env.get("MAIN_PRODUCT_ID") ?? "7336568";

// Offer code da oferta base (Start / Plano Principal)
const MAIN_PLAN_OFFER = "xj0983i2";

// Offer codes dos addons/pacotes — todos dentro do produto 7336568
// Chave: offer code da Hotmart → valor: tipo do addon + tokens (se aplicável)
const ADDON_OFFERS: Record<string, { type: string; tokens?: number }> = {
  "cjszocj0": { type: "agente_extra" },              // R$197/mês
  "8ivu9gbb": { type: "objecao" },                   // R$127/mês
  "w17oc1q3": { type: "numero_extra" },               // R$97/mês
  "vhne1box": { type: "usuario_extra" },              // R$57/mês
  "f623v6bt": { type: "tokens_extra", tokens:  5_000_000 },  // Mini  R$97
  "z9f5y7h3": { type: "tokens_extra", tokens: 10_000_000 },  // Médio R$177
  "yfbmox0t": { type: "tokens_extra", tokens: 20_000_000 },  // Grande R$297
  "e23bospr": { type: "tokens_extra", tokens: 50_000_000 },  // Max   R$597
};

const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Eventos Hotmart ───────────────────────────────────────────────────────
const EVENTS_ACTIVATE = [
  "PURCHASE_APPROVED",
  "PURCHASE_COMPLETE",
  "PURCHASE_REACTIVATED",
  "SUBSCRIPTION_REACTIVATED",
];

const EVENTS_DEACTIVATE = [
  "SUBSCRIPTION_CANCELLATION",
  "PURCHASE_CANCELED",
  "PURCHASE_REFUNDED",
  "PURCHASE_CHARGEBACK",
];

// ── Agente padrão genérico ────────────────────────────────────────────────
const AGENTE_DEFAULTS: Record<string, string> = {
  objetivo:
    "Qualificar leads interessados nos produtos e serviços da empresa e encaminhar ao responsável comercial para dar continuidade.",
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
  tonalidade:
    'Empático, claro e objetivo. Use linguagem simples e acessível. Seja especialmente atencioso com pessoas que ainda estão descobrindo o produto. Se o lead fizer uma pergunta técnica específica, responda de forma genérica e direcione: "Essa é uma excelente pergunta para o nosso especialista aprofundar com você!"',
  instrucoes_comunicacao:
    "- Faça uma pergunta por vez. Aguarde a resposta antes de continuar.\n- Nunca prometa desconto, prazo ou resultado sem confirmação do time.\n- Nunca feche negócio ou passe valores sem autorização.\n- Limite a conversa ao máximo de 10 trocas de mensagens antes de concluir a triagem.\n- Se o lead demorar mais de 24h para responder, envie um lembrete gentil uma única vez.\n- Se o lead enviar um arquivo (foto, PDF), confirme o recebimento e registre.",
  criterios_qualificacao:
    "1. Interesse real — Demonstrou interesse genuíno no produto ou serviço\n2. Necessidade identificada — Tem uma necessidade ou problema que a empresa pode resolver\n3. Capacidade de compra — Possui orçamento ou capacidade de investimento\n4. Tomador de decisão — É o responsável pela decisão ou influencia diretamente\n5. Disposição para avançar — Mostrou disposição em dar próximos passos",
  msg_qualificado:
    "Ótimo! Com base no que você me contou, acredito que podemos te ajudar. Vou encaminhar as informações para o nosso time agora. Em breve alguém entrará em contato com você. Alguma dúvida ou informação adicional que queira que eu repasse?",
  msg_desqualificado:
    "Obrigado por entrar em contato! Com base nas informações que você compartilhou, no momento não identificamos o encaixe ideal com os nossos produtos ou serviços. Caso sua situação mude, fique à vontade para nos contatar novamente. Desejamos tudo de bom para você!",
  numero_destino: "",
};

// ── Helpers ───────────────────────────────────────────────────────────────

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

async function createEvoInstance(instanceName: string): Promise<void> {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return;
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

async function insertAgenteConfigDefaults(userId: string): Promise<void> {
  const rows = Object.entries(AGENTE_DEFAULTS).map(([chave, valor]) => ({ user_id: userId, chave, valor }));
  await adminDb.from("agente_config").upsert(rows, { onConflict: "user_id,chave", ignoreDuplicates: true });
}

async function findUserByEmail(email: string): Promise<string | null> {
  const { data } = await adminDb
    .schema("auth")
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  return (data as any)?.id ?? null;
}

// ── Addon: aplica benefício ao cliente existente ──────────────────────────

async function applyAddon(
  buyerEmail: string,
  addonType: string,
  productName: string,
  transactionId: string,
  valor: number,
  recurrenceNumber: number,  // 1 = primeira compra, > 1 = renovação
  tokenQtd?: number,         // quantidade de tokens (Mini=5M, Médio=10M, Grande=20M, Max=50M)
): Promise<{ action: string; userId: string | null }> {
  const userId = await findUserByEmail(buyerEmail);

  if (!userId) {
    console.warn("Addon comprado por usuário não cadastrado:", buyerEmail, addonType);
    return { action: "addon_user_not_found", userId: null };
  }

  // Registra a compra/renovação do addon (histórico financeiro)
  await adminDb.from("addon_purchases").insert({
    user_id: userId,
    offer_code: addonType,
    addon_type: addonType,
    quantidade: 1,
    valor,
    hotmart_transaction: transactionId,
    status: "ativo",
  });

  // Renovação de assinatura (recurrence_number > 1):
  //   - objecao: idempotente → aplica normalmente
  //   - agente/numero/usuario: já ativo, NÃO incrementa de novo
  //   - tokens_extra: consumível → sempre soma ao saldo
  const isRenewal = recurrenceNumber > 1;

  switch (addonType) {
    case "objecao":
      // Idempotente — seguro aplicar em renovações também
      await adminDb.from("assinaturas")
        .update({ addon_objecao: true })
        .eq("user_id", userId);
      break;

    case "agente_extra":
      if (!isRenewal) {
        // Primeira compra: incrementa o limite
        await adminDb.rpc("incrementar_addon", { uid: userId, coluna: "agentes_extras", qtd: 1 });
      } else {
        console.log(`Renovação de agente_extra ignorada (já ativo): ${buyerEmail}`);
      }
      break;

    case "numero_extra":
      if (!isRenewal) {
        await adminDb.rpc("incrementar_addon", { uid: userId, coluna: "numeros_extras", qtd: 1 });
      } else {
        console.log(`Renovação de numero_extra ignorada (já ativo): ${buyerEmail}`);
      }
      break;

    case "usuario_extra":
      if (!isRenewal) {
        await adminDb.rpc("incrementar_addon", { uid: userId, coluna: "usuarios_extras_limite", qtd: 1 });
      } else {
        console.log(`Renovação de usuario_extra ignorada (já ativo): ${buyerEmail}`);
      }
      break;

    case "tokens_extra": {
      // Tokens extras acumulam de um mês para o outro — nunca expiram.
      // tokens_extras: total de extras comprados (cresce sempre, referência para renovação)
      // saldo_tokens: total disponível agora (base + extras restantes)
      const qtd = tokenQtd ?? 5_000_000; // fallback 5M (Mini)
      const { data: tc } = await adminDb.from("tokens_creditos")
        .select("saldo_tokens, total_comprado, tokens_extras")
        .eq("user_id", userId)
        .maybeSingle();
      await adminDb.from("tokens_creditos").upsert({
        user_id: userId,
        saldo_tokens:   (tc?.saldo_tokens   ?? 0) + qtd,
        total_comprado: (tc?.total_comprado  ?? 0) + qtd,
        tokens_extras:  (tc?.tokens_extras   ?? 0) + qtd,
        mes_referencia: new Date().toISOString().slice(0, 7),
      }, { onConflict: "user_id" });
      console.log(`Tokens adicionados: ${qtd.toLocaleString()} → ${buyerEmail}`);
      break;
    }

    default:
      console.warn("Tipo de addon desconhecido:", addonType);
  }

  const label = isRenewal ? "renovado" : "aplicado";
  console.log(`Addon ${label}: ${addonType} → ${buyerEmail} (${userId})`);
  return { action: `addon_${addonType}${isRenewal ? "_renewal" : ""}`, userId };
}

// ── Remoção de addon (cancelamento de assinatura) ─────────────────────────

async function removeAddon(
  buyerEmail: string,
  addonType: string,
): Promise<{ action: string; userId: string | null }> {
  const userId = await findUserByEmail(buyerEmail);
  if (!userId) {
    console.warn("Addon cancelado por usuário não encontrado:", buyerEmail, addonType);
    return { action: "addon_remove_user_not_found", userId: null };
  }

  // Marca as compras desse addon como canceladas
  await adminDb.from("addon_purchases")
    .update({ status: "cancelado" })
    .eq("user_id", userId)
    .eq("addon_type", addonType)
    .eq("status", "ativo");

  switch (addonType) {
    case "objecao":
      await adminDb.from("assinaturas")
        .update({ addon_objecao: false })
        .eq("user_id", userId);
      break;

    case "agente_extra":
      // Decrementa, mínimo 0
      await adminDb.rpc("incrementar_addon", { uid: userId, coluna: "agentes_extras", qtd: -1 });
      break;

    case "numero_extra":
      await adminDb.rpc("incrementar_addon", { uid: userId, coluna: "numeros_extras", qtd: -1 });
      break;

    case "usuario_extra":
      await adminDb.rpc("incrementar_addon", { uid: userId, coluna: "usuarios_extras_limite", qtd: -1 });
      break;

    case "tokens_extra":
      // Tokens já usados não são revertidos
      console.log("Cancelamento de tokens_extra registrado (saldo mantido).");
      break;

    default:
      console.warn("removeAddon: tipo desconhecido:", addonType);
  }

  console.log(`Addon cancelado: ${addonType} → ${buyerEmail} (${userId})`);
  return { action: `addon_${addonType}_canceled`, userId };
}

// ── Ativação de cliente (produto principal) ───────────────────────────────

async function activateClient(
  buyerName: string,
  buyerEmail: string,
  productName: string,
  tokensIniciais: number,
): Promise<{ action: string; userId: string }> {
  const existingId = await findUserByEmail(buyerEmail);

  if (existingId) {
    // Reativa ou renova conta existente.
    await adminDb.from("profiles").update({ active: true }).eq("id", existingId);
    await adminDb.from("assinaturas").upsert(
      { user_id: existingId, plano: productName, valor: 497, status: "ativa" },
      { onConflict: "user_id" },
    );

    const { data: tc } = await adminDb.from("tokens_creditos")
      .select("saldo_tokens, total_comprado, tokens_extras")
      .eq("user_id", existingId)
      .maybeSingle();

    // Renovação de tokens:
    //   - Tokens extras (comprados) são consumidos PRIMEIRO (preferência do cliente)
    //   - Plano base (5M) é consumido por último → expira ao renovar se sobrar
    //
    // Se saldo > 5M: extras ainda intactos → extras_restantes = saldo - 5M
    // Se saldo ≤ 5M: todos os extras foram consumidos → extras_restantes = 0
    //
    // extras_restantes = MAX(0, saldo_atual - BASE_MENSAL)
    const BASE_MENSAL     = tokensIniciais;          // 5.000.000
    const saldoAtual      = tc?.saldo_tokens ?? 0;
    const totalExtras     = tc?.tokens_extras ?? 0;  // total comprado (para histórico/display)
    const extrasRestantes = Math.max(0, saldoAtual - BASE_MENSAL);
    const novoSaldo       = BASE_MENSAL + extrasRestantes;  // 5M novo base + extras restantes

    await adminDb.from("tokens_creditos").upsert({
      user_id: existingId,
      saldo_tokens:    novoSaldo,
      tokens_usados_mes: 0,
      total_comprado:  (tc?.total_comprado ?? 0) + tokensIniciais,
      tokens_extras:   totalExtras,        // preserva total de extras (não altera)
      mes_referencia:  new Date().toISOString().slice(0, 7),
    }, { onConflict: "user_id" });

    console.log(
      `Cliente reativado/renovado: ${buyerEmail} (${existingId}) | base=5M extras_restantes=${extrasRestantes} novo_saldo=${novoSaldo}`
    );
    return { action: "reactivated", userId: existingId };
  }

  // ── Novo cliente ──────────────────────────────────────────────────────
  const instanceName = generateInstanceName(buyerName, buyerEmail);

  // 1. Instância EVO (não-bloqueante)
  await createEvoInstance(instanceName);

  // 2. Cria usuário no Auth com senha temporária aleatória
  const tempPassword = crypto.randomUUID() + crypto.randomUUID();
  const { data: created, error: createErr } = await adminDb.auth.admin.createUser({
    email: buyerEmail,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { display_name: buyerName, role: "client" },
  });

  if (createErr || !created.user) {
    console.error("Erro ao criar usuário:", createErr?.message);
    throw new Error("Falha ao criar conta: " + (createErr?.message ?? "desconhecido"));
  }

  const userId = created.user.id;

  // Envia email de redefinição de senha para o cliente acessar o painel
  await adminDb.auth.admin.generateLink({
    type: "recovery",
    email: buyerEmail,
    options: { redirectTo: PANEL_URL },
  });

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
    plano: productName || "SDR Agente",
    valor: 497,
    status: "ativa",
  });

  // 5. Tokens iniciais (5M base, nenhum extra ainda)
  await adminDb.from("tokens_creditos").upsert({
    user_id: userId,
    saldo_tokens:    tokensIniciais,
    tokens_usados_mes: 0,
    total_comprado:  tokensIniciais,
    tokens_extras:   0,    // extras acumulam com compras futuras
    mes_referencia:  new Date().toISOString().slice(0, 7),
  }, { onConflict: "user_id" });

  // 6. Configurações padrão do agente
  await insertAgenteConfigDefaults(userId);

  console.log("Cliente criado via Hotmart:", buyerEmail, userId, "instância:", instanceName);
  return { action: "created", userId };
}

// ── Desativação (produto principal) ──────────────────────────────────────

async function deactivateClient(buyerEmail: string): Promise<{ action: string; userId: string | null }> {
  const userId = await findUserByEmail(buyerEmail);
  if (!userId) {
    console.warn("Usuário não encontrado para desativar:", buyerEmail);
    return { action: "not_found", userId: null };
  }
  await adminDb.from("profiles").update({ active: false }).eq("id", userId);
  await adminDb.from("assinaturas").update({ status: "cancelada" }).eq("user_id", userId);

  console.log("Cliente desativado:", buyerEmail, userId);
  return { action: "deactivated", userId };
}

// ── Serve ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, x-hotmart-webhook-token",
      },
    });
  }

  try {
    // ── Validação do token secreto ─────────────────────────────────────
    if (HOTMART_SECRET) {
      const url    = new URL(req.url);
      const qToken = url.searchParams.get("token") ?? "";
      const hToken = req.headers.get("x-hotmart-webhook-token") ?? "";
      if (qToken !== HOTMART_SECRET && hToken !== HOTMART_SECRET) {
        console.warn("Token Hotmart inválido. Recebido:", qToken || hToken);
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const payload           = await req.json();
    const event: string     = payload?.event ?? "";
    const buyer             = payload?.data?.buyer ?? {};
    const product           = payload?.data?.product ?? {};
    const purchase          = payload?.data?.purchase ?? {};
    const productId: string = String(product?.id ?? "");
    const transactionId     = purchase?.transaction ?? purchase?.id ?? "";
    const valor             = Number(purchase?.price?.value ?? purchase?.value ?? 0);

    // Offer code identifica qual oferta do produto foi comprada (addon vs plano base)
    const offerCode: string = purchase?.offer?.code ?? purchase?.offer_code ?? "";

    // recurrence_number: 1 = primeira compra, > 1 = renovação automática (cartão)
    const recurrenceNumber  = Number(purchase?.recurrence_number ?? purchase?.subscription?.recurrenceNumber ?? 1);

    const buyerName  = buyer?.name ?? "Cliente";
    const buyerEmail = (buyer?.email ?? "").toLowerCase().trim();

    if (!buyerEmail) {
      console.warn("Payload sem email do comprador");
      return new Response(JSON.stringify({ ok: true, reason: "sem_email" }), { status: 200 });
    }

    console.log(`Hotmart event: ${event} | product_id: ${productId} | offer: ${offerCode} | email: ${buyerEmail} | recurrence: ${recurrenceNumber}`);

    // ── Ativação ──────────────────────────────────────────────────────
    if (EVENTS_ACTIVATE.includes(event)) {
      // Identifica addon pelo offer code (todas as ofertas estão no mesmo produto 7336568)
      const addonOffer = offerCode ? ADDON_OFFERS[offerCode] : null;

      if (addonOffer) {
        const result = await applyAddon(
          buyerEmail,
          addonOffer.type,
          product?.name ?? "",
          transactionId,
          valor,
          recurrenceNumber,
          addonOffer.tokens,   // quantidade de tokens (undefined para addons não-token)
        );
        return new Response(JSON.stringify({ ok: true, ...result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Produto principal — verifica product ID e offer code
      const isMainProduct = (!MAIN_PRODUCT_ID || productId === MAIN_PRODUCT_ID)
        && (!offerCode || offerCode === MAIN_PLAN_OFFER);
      if (!isMainProduct) {
        console.warn(`Oferta desconhecida ignorada: product=${productId} offer=${offerCode}`);
        return new Response(JSON.stringify({ ok: true, action: "ignored", reason: "unknown_offer", productId, offerCode }), { status: 200 });
      }

      const TOKENS_INICIAIS = 5_000_000;
      const result = await activateClient(
        buyerName,
        buyerEmail,
        product?.name ?? "SDR Agente",
        TOKENS_INICIAIS,
      );
      return new Response(JSON.stringify({ ok: true, ...result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Desativação / Cancelamento ────────────────────────────────────
    if (EVENTS_DEACTIVATE.includes(event)) {
      const addonOffer = offerCode ? ADDON_OFFERS[offerCode] : null;

      if (addonOffer) {
        // Cancelamento de addon: remove só aquele recurso, conta continua ativa
        const result = await removeAddon(buyerEmail, addonOffer.type);
        return new Response(JSON.stringify({ ok: true, ...result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Produto principal: desativa conta (verifica product ID + offer)
      const isMainCancel = (!MAIN_PRODUCT_ID || productId === MAIN_PRODUCT_ID)
        && (!offerCode || offerCode === MAIN_PLAN_OFFER);
      if (!isMainCancel) {
        console.warn(`Cancelamento de oferta desconhecida ignorado: product=${productId} offer=${offerCode}`);
        return new Response(JSON.stringify({ ok: true, action: "ignored", reason: "unknown_offer", productId, offerCode }), { status: 200 });
      }
      const result = await deactivateClient(buyerEmail);
      return new Response(JSON.stringify({ ok: true, ...result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log("Evento ignorado:", event);
    return new Response(JSON.stringify({ ok: true, action: "ignored", event }), { status: 200 });

  } catch (err: any) {
    console.error("hotmart-webhook error:", err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
