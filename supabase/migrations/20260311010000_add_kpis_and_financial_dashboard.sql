-- ============================================================
-- MIGRATION: Tabelas e campos para KPIs, OKRs e Dashboard Financeiro
-- ============================================================

-- 1. Criar tabela user_kpis para KPIs e OKRs do usuário
CREATE TABLE IF NOT EXISTS user_kpis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('taxa_finalizacao', 'leads_semana', 'conversao', 'okr', 'customizado')),
  nome TEXT NOT NULL,
  meta_definida NUMERIC,
  valor_atual NUMERIC DEFAULT 0,
  percentual NUMERIC DEFAULT 0,
  unidade TEXT DEFAULT '%',
  status TEXT DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'alcancado')),
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, nome)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_user_kpis_user_id ON user_kpis(user_id);
CREATE INDEX IF NOT EXISTS idx_user_kpis_status ON user_kpis(status);

-- 2. Adicionar campos a tabela assinaturas
ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS forma_pagamento TEXT;
ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;
ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS data_avisos_sent TIMESTAMP;
ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS cancelada_em TIMESTAMP;

-- Comentários explicativos
COMMENT ON COLUMN assinaturas.forma_pagamento IS 'Forma de pagamento: cartao, pix, boleto - vem do Hotmart';
COMMENT ON COLUMN assinaturas.suspended_at IS 'Data quando a assinatura foi suspensa (7+ dias de atraso)';
COMMENT ON COLUMN assinaturas.data_avisos_sent IS 'Data do último aviso enviado ao cliente';
COMMENT ON COLUMN assinaturas.cancelada_em IS 'Data quando a assinatura foi cancelada';

-- 3. Adicionar campo a tabela profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
COMMENT ON COLUMN profiles.deleted_at IS 'Data quando o banco de dados do cliente foi apagado (30+ dias suspenso)';

-- 4. Criar função para atualizar percentual de KPI automaticamente
CREATE OR REPLACE FUNCTION update_kpi_percentual()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.meta_definida > 0 THEN
    NEW.percentual := (NEW.valor_atual / NEW.meta_definida) * 100;
  END IF;
  NEW.atualizado_em := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para calcular percentual automaticamente
DROP TRIGGER IF EXISTS trigger_update_kpi_percentual ON user_kpis;
CREATE TRIGGER trigger_update_kpi_percentual
BEFORE INSERT OR UPDATE ON user_kpis
FOR EACH ROW
EXECUTE FUNCTION update_kpi_percentual();

-- 5. RLS: user_kpis — cada usuário vê APENAS seus próprios KPIs
ALTER TABLE user_kpis ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "user_kpis_own" ON user_kpis
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Admin pode ver KPIs de todos os usuários (para analytics futura)
CREATE POLICY IF NOT EXISTS "user_kpis_admin" ON user_kpis
  FOR ALL
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );
