-- ============================================================
-- MIGRATION: Schema completo XPERT.IA (multi-tenant)
-- Aplique em ordem. Requer extensão pgvector ativada no Supabase.
-- ============================================================

-- Extensão para embeddings (RAG)
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- PROFILES — um por usuário (admin ou client)
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('admin','client')),
  display_name  TEXT,
  evo_instance  TEXT DEFAULT '',
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_own" ON profiles
  FOR ALL USING (id = auth.uid());

CREATE POLICY "profiles_admin_all" ON profiles
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Trigger: cria profile automaticamente ao criar usuário no Auth
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, role, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'role', 'client'),
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- AGENTE_CONFIG — configurações do agente por usuário
-- ============================================================
CREATE TABLE IF NOT EXISTS agente_config (
  id           SERIAL PRIMARY KEY,
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  chave        TEXT NOT NULL,
  valor        TEXT,
  atualizado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, chave)
);

ALTER TABLE agente_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "config_own" ON agente_config
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- SESSOES — histórico de conversa por número + usuário
-- ============================================================
CREATE TABLE IF NOT EXISTS sessoes (
  numero_whatsapp TEXT NOT NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  historico       TEXT,
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  agente_pausado  BOOLEAN DEFAULT FALSE,
  pausado_em      TIMESTAMPTZ,
  PRIMARY KEY (numero_whatsapp, user_id)
);

-- Fix: PK original era só numero_whatsapp; migrado para composta
-- Se já existe com PK simples, rode:
-- ALTER TABLE sessoes DROP CONSTRAINT sessoes_pkey;
-- ALTER TABLE sessoes ADD PRIMARY KEY (numero_whatsapp, user_id);

ALTER TABLE sessoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sessoes_own" ON sessoes
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- LEADS — leads qualificados pelo agente
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id                    SERIAL PRIMARY KEY,
  user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  numero_whatsapp       TEXT,
  nome                  TEXT,
  celular               TEXT,
  tese                  TEXT,
  resumo                TEXT,
  qualificado           BOOLEAN,
  motivo_desqualificacao TEXT,
  criado_em             TIMESTAMP DEFAULT NOW(),
  -- campos CRM
  stage                 TEXT DEFAULT 'novo_contato',
  assunto               TEXT,
  data_aniversario      DATE,
  notas                 TEXT,
  atualizado_em         TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leads_own" ON leads
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- LEAD_TAREFAS — tarefas do CRM por lead
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_tarefas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  descricao       TEXT NOT NULL,
  concluida       BOOLEAN DEFAULT FALSE,
  data_vencimento DATE,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE lead_tarefas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tarefas_own" ON lead_tarefas
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- DOCUMENTOS_CONHECIMENTO — base RAG por usuário
-- ============================================================
CREATE TABLE IF NOT EXISTS documentos_conhecimento (
  id        BIGSERIAL PRIMARY KEY,
  user_id   UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  conteudo  TEXT,
  metadata  JSONB,
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS docs_embedding_idx
  ON documentos_conhecimento USING ivfflat (embedding vector_cosine_ops);

ALTER TABLE documentos_conhecimento ENABLE ROW LEVEL SECURITY;

CREATE POLICY "docs_own" ON documentos_conhecimento
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- ASSINATURAS — plano e status de pagamento
-- ============================================================
CREATE TABLE IF NOT EXISTS assinaturas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  plano               TEXT DEFAULT 'SDR Agente Único',
  valor               NUMERIC DEFAULT 497.00,
  status              TEXT DEFAULT 'trial' CHECK (status IN ('trial','ativa','inadimplente','cancelada')),
  ciclo               TEXT DEFAULT 'mensal',
  proxima_cobranca    DATE,
  dia_vencimento      INTEGER DEFAULT 1,
  criado_em           TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ DEFAULT NOW(),
  creditos_tokens     BIGINT DEFAULT 0,
  tokens_usados       BIGINT DEFAULT 0,
  referencia_hotmart  TEXT
);

ALTER TABLE assinaturas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assinaturas_own" ON assinaturas
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "assinaturas_admin" ON assinaturas
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ============================================================
-- HISTORICO_COBRANCAS
-- ============================================================
CREATE TABLE IF NOT EXISTS historico_cobrancas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  assinatura_id  UUID REFERENCES assinaturas(id),
  valor          NUMERIC DEFAULT 397.00,
  status         TEXT DEFAULT 'pendente' CHECK (status IN ('pago','pendente','atrasado','cancelado')),
  mes_referencia TEXT,
  vencimento     DATE,
  pago_em        TIMESTAMPTZ,
  observacao     TEXT,
  criado_em      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE historico_cobrancas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cobrancas_own" ON historico_cobrancas
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "cobrancas_admin" ON historico_cobrancas
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ============================================================
-- TOKENS_CREDITOS — saldo de tokens por usuário
-- ============================================================
CREATE TABLE IF NOT EXISTS tokens_creditos (
  user_id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  saldo_tokens      BIGINT DEFAULT 0,
  tokens_usados_mes BIGINT DEFAULT 0,
  total_comprado    BIGINT DEFAULT 0,
  mes_referencia    TEXT,
  atualizado_em     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tokens_creditos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tokens_own" ON tokens_creditos
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- PEDIDOS_CREDITOS — pedidos de compra de tokens
-- ============================================================
CREATE TABLE IF NOT EXISTS pedidos_creditos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  pacote     TEXT NOT NULL,
  tokens     BIGINT NOT NULL,
  preco_usd  NUMERIC NOT NULL,
  preco_brl  NUMERIC,
  status     TEXT DEFAULT 'pendente',
  obs_admin  TEXT,
  criado_em  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pedidos_creditos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pedidos_own" ON pedidos_creditos
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "pedidos_admin" ON pedidos_creditos
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ============================================================
-- TOKEN_USAGE — log de uso de tokens por conversa
-- ============================================================
CREATE TABLE IF NOT EXISTS token_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  modelo        TEXT DEFAULT 'gpt-4o',
  tokens_input  INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  tokens_total  INTEGER GENERATED ALWAYS AS (tokens_input + tokens_output) STORED,
  conversa_id   TEXT,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "token_usage_own" ON token_usage
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- FLUXOS — futuro (fluxos de conversa customizáveis)
-- ============================================================
CREATE TABLE IF NOT EXISTS fluxos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  descricao   TEXT,
  dados       JSONB DEFAULT '{}',
  criado_em   TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE fluxos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fluxos_own" ON fluxos
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- RPC: admin vê saldo de tokens de todos os clientes
-- ============================================================
CREATE OR REPLACE FUNCTION admin_get_all_tokens()
RETURNS TABLE (
  user_id       UUID,
  display_name  TEXT,
  evo_instance  TEXT,
  saldo_tokens  BIGINT,
  tokens_usados_mes BIGINT,
  total_comprado BIGINT,
  atualizado_em TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Verifica se quem chama é admin
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;

  RETURN QUERY
  SELECT
    tc.user_id,
    p.display_name,
    p.evo_instance,
    tc.saldo_tokens,
    tc.tokens_usados_mes,
    tc.total_comprado,
    tc.atualizado_em
  FROM tokens_creditos tc
  JOIN profiles p ON p.id = tc.user_id
  ORDER BY tc.atualizado_em DESC;
END;
$$;

-- ============================================================
-- RPC: incrementa saldo de tokens de um cliente (admin only)
-- Usada pela Edge Function manage-clients ao adicionar tokens
-- ============================================================
CREATE OR REPLACE FUNCTION incrementar_tokens(uid UUID, qtd BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Verifica se quem chama é admin
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;

  UPDATE tokens_creditos
  SET saldo_tokens   = saldo_tokens + qtd,
      total_comprado = total_comprado + qtd,
      atualizado_em  = NOW()
  WHERE user_id = uid;
END;
$$;
