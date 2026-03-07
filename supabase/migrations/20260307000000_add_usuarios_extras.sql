-- Tabela de usuários extras (membros da equipe)
CREATE TABLE IF NOT EXISTS usuarios_extras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  email TEXT,
  whatsapp_contato TEXT,
  numero_atribuido TEXT,
  cargo TEXT DEFAULT 'Colaborador',
  cor TEXT DEFAULT '#6366f1',
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE usuarios_extras ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "uex_own" ON usuarios_extras
  FOR ALL USING (owner_id = auth.uid());

-- Adiciona coluna atribuido_a na tabela lead_tarefas
ALTER TABLE lead_tarefas
  ADD COLUMN IF NOT EXISTS atribuido_a UUID REFERENCES usuarios_extras(id) ON DELETE SET NULL;
