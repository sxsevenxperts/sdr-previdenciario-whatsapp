-- Migration: Tabela de histórico de mensagens para contexto de conversa
-- Armazena todas as mensagens da conversa para passar contexto à IA

CREATE TABLE IF NOT EXISTS message_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  numero_whatsapp TEXT NOT NULL,
  sender TEXT NOT NULL,  -- 'user' = cliente, 'agent' = agente/IA
  conteudo TEXT NOT NULL,
  tipo_mensagem TEXT DEFAULT 'text',  -- 'text', 'image', 'audio', 'document'
  tokens_usados INTEGER DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE message_history ENABLE ROW LEVEL SECURITY;

-- RLS: usuários só veem histórico dos seus próprios leads
CREATE POLICY "message_history_own_leads" ON message_history
  FOR SELECT USING (
    user_id = auth.uid()
  );

CREATE POLICY "message_history_insert_own" ON message_history
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
  );

CREATE INDEX idx_message_history_lead ON message_history(lead_id);
CREATE INDEX idx_message_history_numero ON message_history(numero_whatsapp);
CREATE INDEX idx_message_history_timestamp ON message_history(criado_em DESC);
