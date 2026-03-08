-- RPC: decrementar_tokens
-- Chamada pelo n8n após cada resposta do agente Claude.
-- Debita o saldo e acumula o consumo do mês de forma atômica (sem race condition).
-- Usa SECURITY DEFINER — pode ser chamada com a service_role key do n8n.
--
-- Parâmetros:
--   p_user_id  UUID    — ID do usuário dono do agente
--   p_tokens   BIGINT  — total de tokens consumidos (input_tokens + output_tokens)
--
-- Retorna:
--   saldo_atual  BIGINT  — saldo restante após débito
--   saldo_ok     BOOLEAN — true se ainda há crédito; false se zerou ou ficou negativo

CREATE OR REPLACE FUNCTION public.decrementar_tokens(p_user_id UUID, p_tokens BIGINT)
RETURNS TABLE (saldo_atual BIGINT, saldo_ok BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saldo BIGINT;
BEGIN
  -- Atualiza atomicamente (evita race condition em concorrência)
  UPDATE tokens_creditos
  SET
    saldo_tokens      = GREATEST(0, saldo_tokens - p_tokens),
    tokens_usados_mes = tokens_usados_mes + p_tokens,
    atualizado_em     = NOW()
  WHERE user_id = p_user_id
  RETURNING saldo_tokens INTO v_saldo;

  -- Se não existe registro ainda, cria com saldo 0
  IF NOT FOUND THEN
    INSERT INTO tokens_creditos (user_id, saldo_tokens, tokens_usados_mes, total_comprado)
    VALUES (p_user_id, 0, p_tokens, 0);
    v_saldo := 0;
  END IF;

  RETURN QUERY SELECT v_saldo, (v_saldo > 0);
END;
$$;

-- Permite que a service_role chame sem autenticação de usuário
GRANT EXECUTE ON FUNCTION public.decrementar_tokens(UUID, BIGINT) TO service_role;
