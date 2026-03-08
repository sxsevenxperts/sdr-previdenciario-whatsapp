-- Fix: handle_new_user_billing sem search_path causava "Database error creating new user"
-- A função SECURITY DEFINER precisa de search_path fixo para encontrar a tabela assinaturas
CREATE OR REPLACE FUNCTION public.handle_new_user_billing()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO assinaturas (user_id, status, proxima_cobranca)
  VALUES (NEW.id, 'trial', (now() + interval '7 days')::date)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
