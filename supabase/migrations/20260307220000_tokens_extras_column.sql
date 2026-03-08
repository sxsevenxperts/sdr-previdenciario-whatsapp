-- Migration: coluna tokens_extras em tokens_creditos
-- Necessária para separar tokens do plano base (renovam todo mês)
-- dos tokens extras comprados (acumulam de um mês para o outro).
--
-- Lógica:
--   tokens_extras  → total de tokens extras já comprados (cresce, nunca reseta)
--   saldo_tokens   → saldo atual (base + extras restantes)
--
-- Na renovação mensal:
--   extras_restantes = MIN(saldo_tokens, tokens_extras)
--   saldo_tokens = 5.000.000 + extras_restantes
--
-- Na compra de extras:
--   tokens_extras += QTD
--   saldo_tokens  += QTD

ALTER TABLE public.tokens_creditos
  ADD COLUMN IF NOT EXISTS tokens_extras BIGINT NOT NULL DEFAULT 0;
