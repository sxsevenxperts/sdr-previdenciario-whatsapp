-- RPC: get_token_balance
-- Retorna o saldo de tokens consolidado do usuário
-- Usada no n8n para validar se há tokens suficientes ANTES de chamar LLM
--
-- Retorna:
--   saldo_tokens        BIGINT  — saldo atual disponível
--   tokens_extras       BIGINT  — total de tokens extras já comprados
--   tokens_usados_mes   BIGINT  — tokens usados neste mês
--   tem_saldo_suficiente BOOLEAN — true se saldo_tokens > 0

CREATE OR REPLACE FUNCTION public.get_token_balance(p_user_id UUID)
RETURNS TABLE (
  saldo_tokens BIGINT,
  tokens_extras BIGINT,
  tokens_usados_mes BIGINT,
  tem_saldo_suficiente BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(tc.saldo_tokens, 0),
    COALESCE(tc.tokens_extras, 0),
    COALESCE(tc.tokens_usados_mes, 0),
    (COALESCE(tc.saldo_tokens, 0) > 0)
  FROM tokens_creditos tc
  WHERE tc.user_id = p_user_id;

  -- Se não existe registro ainda, retorna valores padrão (0 tokens)
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::BIGINT, 0::BIGINT, 0::BIGINT, FALSE;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_token_balance(UUID) TO authenticated, service_role;
