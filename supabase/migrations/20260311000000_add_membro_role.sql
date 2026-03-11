-- ============================================================
-- MIGRATION: Papel "membro" (atendente) com acesso restrito
-- ============================================================

-- 1. Atualiza constraint de role para aceitar 'membro'
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin','client','membro'));

-- 2. Adiciona owner_id em profiles (para membros saberem de qual conta fazem parte)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 3. Atualiza trigger para capturar owner_id dos metadados do convite
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, role, display_name, owner_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'role', 'client'),
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email),
    NULLIF(NEW.raw_user_meta_data->>'owner_id', '')::uuid
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- 4. RLS: membro pode ler e escrever leads do owner
CREATE POLICY IF NOT EXISTS "leads_membro" ON leads
  FOR ALL
  USING (
    user_id = (SELECT owner_id FROM profiles WHERE id = auth.uid() AND role = 'membro')
  )
  WITH CHECK (
    user_id = (SELECT owner_id FROM profiles WHERE id = auth.uid() AND role = 'membro')
  );

-- 5. RLS: membro pode ler e escrever tarefas de leads do owner
CREATE POLICY IF NOT EXISTS "lead_tarefas_membro" ON lead_tarefas
  FOR ALL
  USING (
    user_id = (SELECT owner_id FROM profiles WHERE id = auth.uid() AND role = 'membro')
  )
  WITH CHECK (
    user_id = (SELECT owner_id FROM profiles WHERE id = auth.uid() AND role = 'membro')
  );

-- 6. RLS: membro pode ler e escrever sessões (bate-papo) do owner
CREATE POLICY IF NOT EXISTS "sessoes_membro" ON sessoes
  FOR ALL
  USING (
    user_id = (SELECT owner_id FROM profiles WHERE id = auth.uid() AND role = 'membro')
  )
  WITH CHECK (
    user_id = (SELECT owner_id FROM profiles WHERE id = auth.uid() AND role = 'membro')
  );

-- 7. RLS: membro pode ler perfil do owner (para carregar nome, evo_instance, etc.)
CREATE POLICY IF NOT EXISTS "profiles_membro_read_owner" ON profiles
  FOR SELECT
  USING (
    id = (SELECT owner_id FROM profiles p2 WHERE p2.id = auth.uid() AND p2.role = 'membro')
  );

-- 8. RLS: membro pode ler e atualizar seu próprio registro em usuarios_extras
CREATE POLICY IF NOT EXISTS "uex_membro_self" ON usuarios_extras
  FOR ALL
  USING (
    email = (SELECT email FROM auth.users WHERE id = auth.uid())
    AND owner_id = (SELECT owner_id FROM profiles WHERE id = auth.uid() AND role = 'membro')
  )
  WITH CHECK (
    email = (SELECT email FROM auth.users WHERE id = auth.uid())
    AND owner_id = (SELECT owner_id FROM profiles WHERE id = auth.uid() AND role = 'membro')
  );
