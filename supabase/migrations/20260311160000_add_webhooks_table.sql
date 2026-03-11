-- ============================================================
-- MIGRATION: Webhooks (Outbound + Logs)
-- ============================================================

-- Criar tabela para webhooks outbound (dados enviados pelo sistema)
CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_token TEXT NOT NULL,
  events TEXT[] DEFAULT ARRAY['lead.created', 'lead.converted'],
  active BOOLEAN DEFAULT true,
  last_sent_at TIMESTAMP,
  last_error TEXT,
  error_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_webhooks_user_active ON webhooks(user_id, active);
CREATE INDEX IF NOT EXISTS idx_webhooks_created ON webhooks(created_at DESC);

-- Row Level Security
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhooks_own" ON webhooks;
CREATE POLICY "webhooks_own" ON webhooks
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Tabela para log de tentativas de envio de webhooks
CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  error_message TEXT,
  payload JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook_created ON webhook_logs(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON webhook_logs(status_code);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON webhook_logs(created_at DESC);

-- Row Level Security para logs (acessar logs do seu próprio webhook)
ALTER TABLE webhook_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_logs_own" ON webhook_logs;
CREATE POLICY "webhook_logs_own" ON webhook_logs
  FOR SELECT
  USING (
    webhook_id IN (
      SELECT id FROM webhooks WHERE user_id = auth.uid()
    )
  );

-- Tabela para webhooks inbound (dados recebidos de sistemas externos)
CREATE TABLE IF NOT EXISTS webhooks_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  secret_token TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_webhooks_inbound_user ON webhooks_inbound(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_inbound_token ON webhooks_inbound(secret_token);

-- Row Level Security
ALTER TABLE webhooks_inbound ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhooks_inbound_own" ON webhooks_inbound;
CREATE POLICY "webhooks_inbound_own" ON webhooks_inbound
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Tabela para logs de webhooks inbound
CREATE TABLE IF NOT EXISTS webhook_inbound_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type TEXT,
  status_code INTEGER,
  error_message TEXT,
  payload JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_webhook_inbound_logs_user_created ON webhook_inbound_logs(user_id, created_at DESC);

-- Comentários
COMMENT ON TABLE webhooks IS 'Webhooks outbound enviados pelo sistema para URLs de clientes';
COMMENT ON COLUMN webhooks.user_id IS 'Usuário que configurou o webhook';
COMMENT ON COLUMN webhooks.url IS 'URL de destino onde os webhooks serão enviados';
COMMENT ON COLUMN webhooks.secret_token IS 'Token secreto para validação de segurança';
COMMENT ON COLUMN webhooks.events IS 'Array de tipos de eventos a disparar (lead.created, lead.converted, etc)';
COMMENT ON COLUMN webhooks.active IS 'Se o webhook está ativo ou desativado';

COMMENT ON TABLE webhook_logs IS 'Log de todas as tentativas de envio de webhooks';
COMMENT ON COLUMN webhook_logs.event_type IS 'Tipo de evento que disparou o webhook';
COMMENT ON COLUMN webhook_logs.status_code IS 'HTTP status code da resposta (200, 500, timeout, etc)';
COMMENT ON COLUMN webhook_logs.response_time_ms IS 'Tempo de resposta em milissegundos';

COMMENT ON TABLE webhooks_inbound IS 'Configuração para receber webhooks de sistemas externos';
COMMENT ON COLUMN webhooks_inbound.secret_token IS 'Token para validar webhooks de entrada';

COMMENT ON TABLE webhook_inbound_logs IS 'Log de webhooks recebidos de sistemas externos';
