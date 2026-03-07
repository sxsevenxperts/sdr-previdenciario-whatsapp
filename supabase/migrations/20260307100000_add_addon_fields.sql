-- Migration: addon fields em assinaturas + tabela addon_purchases + RPC incrementar_addon

-- Colunas de addons na tabela assinaturas
ALTER TABLE assinaturas
  ADD COLUMN IF NOT EXISTS addon_objecao BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS agentes_extras INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS numeros_extras INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usuarios_extras_limite INT DEFAULT 0;

-- Tabela de histórico de compras de addons
CREATE TABLE IF NOT EXISTS addon_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  offer_code TEXT NOT NULL,
  addon_type TEXT NOT NULL,
  quantidade INT DEFAULT 1,
  valor NUMERIC(10,2),
  hotmart_transaction TEXT,
  status TEXT DEFAULT 'ativo',
  criado_em TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE addon_purchases ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'addon_purchases' AND policyname = 'addon_purchases_own'
  ) THEN
    CREATE POLICY "addon_purchases_own" ON addon_purchases
      FOR ALL USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'addon_purchases' AND policyname = 'addon_purchases_admin'
  ) THEN
    CREATE POLICY "addon_purchases_admin" ON addon_purchases
      FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
      );
  END IF;
END $$;

-- RPC para incrementar campo inteiro de addons em assinaturas com segurança
CREATE OR REPLACE FUNCTION incrementar_addon(uid UUID, coluna TEXT, qtd INT DEFAULT 1)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF coluna NOT IN ('agentes_extras', 'numeros_extras', 'usuarios_extras_limite') THEN
    RAISE EXCEPTION 'Coluna inválida: %', coluna;
  END IF;

  IF coluna = 'agentes_extras' THEN
    UPDATE assinaturas SET agentes_extras = COALESCE(agentes_extras, 0) + qtd WHERE user_id = uid;
  ELSIF coluna = 'numeros_extras' THEN
    UPDATE assinaturas SET numeros_extras = COALESCE(numeros_extras, 0) + qtd WHERE user_id = uid;
  ELSIF coluna = 'usuarios_extras_limite' THEN
    UPDATE assinaturas SET usuarios_extras_limite = COALESCE(usuarios_extras_limite, 0) + qtd WHERE user_id = uid;
  END IF;
END;
$$;
