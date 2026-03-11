-- ============================================================
-- MIGRATION: Calendar Events Table
-- ============================================================

-- Criar tabela para armazenar eventos sincronizados de calendários
CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calendar_provider TEXT NOT NULL CHECK (calendar_provider IN ('google', 'apple', 'calendly')),
  event_id TEXT NOT NULL,
  title TEXT,
  description TEXT,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  location TEXT,
  attendees JSONB,
  raw_data JSONB,
  synced_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, calendar_provider, event_id)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_calendar_events_user_time ON calendar_events(user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_provider ON calendar_events(user_id, calendar_provider);
CREATE INDEX IF NOT EXISTS idx_calendar_events_synced ON calendar_events(synced_at DESC);

-- Row Level Security
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "calendar_events_own" ON calendar_events;
CREATE POLICY "calendar_events_own" ON calendar_events
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Admin pode listar todos eventos (para analytics futura)
DROP POLICY IF EXISTS "calendar_events_admin" ON calendar_events;
CREATE POLICY "calendar_events_admin" ON calendar_events
  FOR ALL
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );

-- Comentários
COMMENT ON TABLE calendar_events IS 'Eventos sincronizados de calendários de clientes';
COMMENT ON COLUMN calendar_events.user_id IS 'Usuário que possui o evento';
COMMENT ON COLUMN calendar_events.calendar_provider IS 'Provedor do calendário: google, apple, calendly';
COMMENT ON COLUMN calendar_events.event_id IS 'ID único do evento no provedor';
COMMENT ON COLUMN calendar_events.start_time IS 'Data/hora de início do evento';
COMMENT ON COLUMN calendar_events.end_time IS 'Data/hora de fim do evento';
COMMENT ON COLUMN calendar_events.synced_at IS 'Data da última sincronização';
