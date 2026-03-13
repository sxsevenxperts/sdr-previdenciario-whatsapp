-- Migration: Campos SDR com silêncios estratégicos
-- Rastreia quem enviou última mensagem e timestamp para controlar silêncios

ALTER TABLE message_history
  ADD COLUMN IF NOT EXISTS ultimo_sender TEXT,  -- 'user' or 'agent'
  ADD COLUMN IF NOT EXISTS tempo_resposta_ms INTEGER;  -- milisegundos entre mensagens

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS aguardando_resposta BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS ultima_pergunta TEXT,
  ADD COLUMN IF NOT EXISTS ultima_pergunta_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS objecoes_count INTEGER DEFAULT 0;

-- Índice para queries rápidas de silêncio estratégico
CREATE INDEX IF NOT EXISTS idx_message_history_sender 
  ON message_history(lead_id, sender, criado_em DESC);
