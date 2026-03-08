-- Migration: colunas de addon em assinaturas + tabela addon_purchases + função incrementar_addon
-- Necessário para o webhook Hotmart gerenciar addons de assinatura (cartão recorrente).

-- ── Colunas de addon em assinaturas ──────────────────────────────────────
ALTER TABLE public.assinaturas
  ADD COLUMN IF NOT EXISTS addon_objecao          BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS agentes_extras         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS numeros_extras         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usuarios_extras_limite INTEGER     NOT NULL DEFAULT 0;


-- ── Tabela addon_purchases ────────────────────────────────────────────────
-- Histórico de compras e renovações de addons por cliente.
CREATE TABLE IF NOT EXISTS public.addon_purchases (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  addon_type        TEXT NOT NULL,   -- 'objecao' | 'agente_extra' | 'numero_extra' | 'usuario_extra' | 'tokens_extra'
  offer_code        TEXT,
  quantidade        INTEGER NOT NULL DEFAULT 1,
  valor             NUMERIC(10,2),
  hotmart_transaction TEXT,
  status            TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','cancelado')),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.addon_purchases ENABLE ROW LEVEL SECURITY;

-- Apenas super admin lê; Edge Functions usam service_role (bypassa RLS)
CREATE POLICY "admin_all_addon_purchases"
  ON public.addon_purchases FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ── Função incrementar_addon ──────────────────────────────────────────────
-- Incrementa (ou decrementa) uma coluna inteira em assinaturas.
-- Garante que o valor nunca fique abaixo de zero.
-- Usada pelo webhook Hotmart para ativar e cancelar addons.
CREATE OR REPLACE FUNCTION public.incrementar_addon(
  uid    UUID,
  coluna TEXT,
  qtd    INTEGER DEFAULT 1
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allowed_columns TEXT[] := ARRAY[
    'agentes_extras',
    'numeros_extras',
    'usuarios_extras_limite'
  ];
BEGIN
  -- Valida o nome da coluna (evita SQL injection)
  IF coluna != ALL(allowed_columns) THEN
    RAISE EXCEPTION 'Coluna não permitida: %', coluna;
  END IF;

  -- Incrementa/decrementa, garantindo mínimo 0
  EXECUTE format(
    'UPDATE public.assinaturas
     SET %I = GREATEST(0, COALESCE(%I, 0) + $1)
     WHERE user_id = $2',
    coluna, coluna
  ) USING qtd, uid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.incrementar_addon(UUID, TEXT, INTEGER) TO service_role;
