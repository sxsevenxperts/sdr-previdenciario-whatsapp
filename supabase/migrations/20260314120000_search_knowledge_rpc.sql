-- ============================================================
-- RPC: buscar_conhecimento
-- Busca full-text na base de conhecimento do cliente
-- Retorna os chunks mais relevantes para a query
-- ============================================================

-- Adiciona índice GIN para full-text search (se não existir)
CREATE INDEX IF NOT EXISTS docs_content_fts_idx
  ON documentos_conhecimento
  USING GIN (to_tsvector('portuguese', conteudo));

-- RPC de busca por relevância
CREATE OR REPLACE FUNCTION buscar_conhecimento(
  p_user_id UUID,
  p_query   TEXT,
  p_limit   INT DEFAULT 3
)
RETURNS TABLE(
  conteudo   TEXT,
  nome       TEXT,
  categoria  TEXT,
  relevancia FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.conteudo,
    COALESCE(dc.metadata->>'nome', 'Documento')::TEXT       AS nome,
    COALESCE(dc.metadata->>'categoria', 'Geral')::TEXT      AS categoria,
    ts_rank(
      to_tsvector('portuguese', dc.conteudo),
      plainto_tsquery('portuguese', p_query)
    )::FLOAT                                                 AS relevancia
  FROM documentos_conhecimento dc
  WHERE dc.user_id = p_user_id
    AND to_tsvector('portuguese', dc.conteudo)
        @@ plainto_tsquery('portuguese', p_query)
  ORDER BY relevancia DESC
  LIMIT p_limit;
END;
$$;

-- Fallback: se não houver match por FTS, retorna os N últimos chunks
-- (para uso quando a query não tem palavras-chave claras)
CREATE OR REPLACE FUNCTION buscar_conhecimento_recente(
  p_user_id UUID,
  p_limit   INT DEFAULT 5
)
RETURNS TABLE(
  conteudo  TEXT,
  nome      TEXT,
  categoria TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.conteudo,
    COALESCE(dc.metadata->>'nome', 'Documento')::TEXT    AS nome,
    COALESCE(dc.metadata->>'categoria', 'Geral')::TEXT   AS categoria
  FROM documentos_conhecimento dc
  WHERE dc.user_id = p_user_id
  ORDER BY dc.id DESC
  LIMIT p_limit;
END;
$$;

-- Permissões
GRANT EXECUTE ON FUNCTION buscar_conhecimento(UUID, TEXT, INT)         TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION buscar_conhecimento_recente(UUID, INT)       TO anon, authenticated, service_role;
