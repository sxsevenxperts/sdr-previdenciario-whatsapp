-- RPC: Agrega custo por modelo para todos os clientes (admin only)
CREATE OR REPLACE FUNCTION public.admin_get_model_costs()
RETURNS TABLE (
  modelo TEXT,
  total_tokens_reais BIGINT,
  total_tokens_deduzidos BIGINT,
  cost_factor NUMERIC,
  num_conversas INTEGER,
  clientes_unicos INTEGER,
  receita_estimada NUMERIC,
  margem_percentual NUMERIC
) LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  WITH cost_factors AS (
    SELECT 'gpt-3.5-turbo'::TEXT as modelo, 0.2::NUMERIC as factor
    UNION ALL SELECT 'gpt-4.1-nano', 0.3
    UNION ALL SELECT 'gpt-4.1-mini', 0.8
    UNION ALL SELECT 'gpt-4o-mini', 1.0
    UNION ALL SELECT 'o4-mini', 2.0
    UNION ALL SELECT 'o3-mini', 3.0
    UNION ALL SELECT 'gpt-4.1', 5.5
    UNION ALL SELECT 'gpt-4-turbo', 6.0
    UNION ALL SELECT 'gpt-4o', 8.0
    UNION ALL SELECT 'o3', 12
    UNION ALL SELECT 'claude-3-haiku', 10
    UNION ALL SELECT 'claude-haiku-4-5', 12
    UNION ALL SELECT 'claude-haiku-4-5-20251001', 12
    UNION ALL SELECT 'claude-3-opus-20240229', 40
    UNION ALL SELECT 'claude-opus-4-6', 50
    UNION ALL SELECT 'claude-3.5-sonnet', 25
    UNION ALL SELECT 'claude-sonnet-4-6', 35
    UNION ALL SELECT 'gemini-2.0-flash', 2.5
    UNION ALL SELECT 'gemini-1.5-flash', 2.0
    UNION ALL SELECT 'gemini-1.5-pro', 5.0
    UNION ALL SELECT 'whisper-1', 0.5
    UNION ALL SELECT 'tts-1', 0.3
    UNION ALL SELECT 'tts-1-hd', 1.0
  ),
  model_usage AS (
    SELECT
      tu.modelo,
      SUM(tu.tokens_total) as total_reais,
      SUM(ROUND(tu.tokens_total * cf.factor)) as total_deduzidos,
      COUNT(DISTINCT tu.conversa_id) as num_conv,
      COUNT(DISTINCT tu.user_id) as clientes,
      cf.factor
    FROM token_usage tu
    LEFT JOIN cost_factors cf ON tu.modelo = cf.modelo
    WHERE tu.criado_em >= DATE_TRUNC('month', NOW())
    GROUP BY tu.modelo, cf.factor
  )
  SELECT
    mu.modelo,
    mu.total_reais::BIGINT,
    mu.total_deduzidos::BIGINT,
    mu.factor,
    mu.num_conv::INTEGER,
    mu.clientes::INTEGER,
    (mu.total_deduzidos * 0.00000002)::NUMERIC,
    CASE
      WHEN mu.total_deduzidos = 0 THEN 0
      ELSE ((mu.total_deduzidos - mu.total_reais) * 100.0 / mu.total_deduzidos)::NUMERIC
    END
  FROM model_usage mu
  WHERE mu.modelo IS NOT NULL
  ORDER BY mu.total_deduzidos DESC;
$$;
