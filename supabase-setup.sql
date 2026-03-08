-- =============================================
-- CLÍNICA ESTÉTICA — Schema Supabase
-- Execute no SQL Editor do projeto Supabase
-- =============================================

-- Habilitar extensão UUID
create extension if not exists "uuid-ossp";

-- =============================================
-- TABELAS PRINCIPAIS
-- =============================================

-- Perfis de usuário (complementa auth.users)
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  nome text not null,
  email text,
  telefone text,
  role text not null default 'recepcionista' check (role in ('admin', 'profissional', 'recepcionista')),
  avatar_url text,
  ativo boolean default true,
  created_at timestamptz default now()
);

-- Profissionais da clínica
create table if not exists public.profissionais (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete set null,
  nome text not null,
  especialidade text,
  telefone text,
  email text,
  cor_agenda text default '#6366f1',
  bio text,
  ativo boolean default true,
  created_at timestamptz default now()
);

-- Clientes
create table if not exists public.clientes (
  id uuid default uuid_generate_v4() primary key,
  nome text not null,
  email text,
  telefone text not null,
  data_nascimento date,
  cpf text,
  endereco text,
  observacoes text,
  foto_url text,
  ativo boolean default true,
  created_at timestamptz default now()
);

-- Categorias de procedimentos
create table if not exists public.categorias_procedimento (
  id uuid default uuid_generate_v4() primary key,
  nome text not null,
  cor text default '#6366f1',
  created_at timestamptz default now()
);

-- Procedimentos
create table if not exists public.procedimentos (
  id uuid default uuid_generate_v4() primary key,
  categoria_id uuid references public.categorias_procedimento(id) on delete set null,
  nome text not null,
  descricao text,
  duracao_minutos integer not null default 60,
  preco decimal(10,2) not null default 0,
  intervalo_recomendado_dias integer, -- intervalo entre sessões em dias
  max_sessoes_pacote integer,         -- sessões em pacote (null = avulso)
  ativo boolean default true,
  created_at timestamptz default now()
);

-- Agendamentos
create table if not exists public.agendamentos (
  id uuid default uuid_generate_v4() primary key,
  cliente_id uuid references public.clientes(id) on delete restrict not null,
  profissional_id uuid references public.profissionais(id) on delete restrict not null,
  procedimento_id uuid references public.procedimentos(id) on delete restrict not null,
  pacote_id uuid,  -- referência ao pacote (preenchido depois)
  data_hora timestamptz not null,
  data_hora_fim timestamptz not null,
  status text not null default 'agendado' check (status in ('agendado','confirmado','concluido','cancelado','faltou')),
  preco_cobrado decimal(10,2),
  observacoes text,
  lembrete_enviado boolean default false,
  created_at timestamptz default now()
);

-- Pacotes de sessões por cliente
create table if not exists public.pacotes_cliente (
  id uuid default uuid_generate_v4() primary key,
  cliente_id uuid references public.clientes(id) on delete restrict not null,
  procedimento_id uuid references public.procedimentos(id) on delete restrict not null,
  profissional_id uuid references public.profissionais(id) on delete set null,
  total_sessoes integer not null,
  sessoes_utilizadas integer not null default 0,
  valor_total decimal(10,2) not null default 0,
  valor_pago decimal(10,2) not null default 0,
  status text not null default 'ativo' check (status in ('ativo','concluido','cancelado')),
  data_compra date default current_date,
  validade date,
  observacoes text,
  lembrete_fim_enviado boolean default false,
  created_at timestamptz default now()
);

-- Atualiza referência do agendamento ao pacote
alter table public.agendamentos
  add constraint agendamentos_pacote_id_fkey
  foreign key (pacote_id) references public.pacotes_cliente(id) on delete set null;

-- Pagamentos
create table if not exists public.pagamentos (
  id uuid default uuid_generate_v4() primary key,
  agendamento_id uuid references public.agendamentos(id) on delete set null,
  pacote_id uuid references public.pacotes_cliente(id) on delete set null,
  cliente_id uuid references public.clientes(id) on delete restrict not null,
  valor decimal(10,2) not null,
  metodo text not null default 'dinheiro' check (metodo in ('dinheiro','cartao_credito','cartao_debito','pix','transferencia')),
  status text not null default 'pago' check (status in ('pendente','pago','cancelado')),
  descricao text,
  data_pagamento date default current_date,
  created_at timestamptz default now()
);

-- Configurações de lembretes WhatsApp
create table if not exists public.config_lembretes (
  id uuid default uuid_generate_v4() primary key,
  tipo text not null check (tipo in ('agendamento_24h','agendamento_2h','pacote_acabando')),
  ativo boolean default true,
  antecedencia_horas integer, -- para lembretes de agendamento
  sessoes_restantes_alerta integer, -- para alerta de pacote acabando
  template_mensagem text not null,
  updated_at timestamptz default now()
);

-- Configurações gerais da clínica
create table if not exists public.config_clinica (
  id uuid default uuid_generate_v4() primary key,
  chave text not null unique,
  valor text,
  updated_at timestamptz default now()
);

-- Horários de funcionamento
create table if not exists public.horarios_funcionamento (
  id uuid default uuid_generate_v4() primary key,
  dia_semana integer not null check (dia_semana between 0 and 6), -- 0=Dom, 1=Seg...
  hora_abertura time not null default '08:00',
  hora_fechamento time not null default '18:00',
  intervalo_almoco_inicio time,
  intervalo_almoco_fim time,
  fechado boolean default false,
  unique(dia_semana)
);

-- =============================================
-- DADOS INICIAIS
-- =============================================

-- Categorias padrão
insert into public.categorias_procedimento (nome, cor) values
  ('Facial', '#ec4899'),
  ('Corporal', '#8b5cf6'),
  ('Depilação', '#f59e0b'),
  ('Massagem', '#10b981'),
  ('Unhas', '#06b6d4'),
  ('Outros', '#6b7280')
on conflict do nothing;

-- Configurações padrão de lembretes
insert into public.config_lembretes (tipo, ativo, antecedencia_horas, sessoes_restantes_alerta, template_mensagem) values
  ('agendamento_24h', true, 24, null, 'Olá {{nome}}! 😊 Lembrando do seu agendamento amanhã às {{horario}} para {{procedimento}} com {{profissional}}. Qualquer dúvida nos chame! 💆‍♀️'),
  ('agendamento_2h', false, 2, null, 'Olá {{nome}}! Seu agendamento de {{procedimento}} é em 2 horas ({{horario}}). Te esperamos! ✨'),
  ('pacote_acabando', true, null, 2, 'Olá {{nome}}! Você está utilizando bem seu pacote de {{procedimento}}. Restam apenas {{sessoes_restantes}} sessões. Fale conosco para renovar! 💖')
on conflict do nothing;

-- Horários de funcionamento padrão (Seg a Sáb)
insert into public.horarios_funcionamento (dia_semana, hora_abertura, hora_fechamento, fechado) values
  (0, '08:00', '18:00', true),  -- Domingo fechado
  (1, '08:00', '18:00', false), -- Segunda
  (2, '08:00', '18:00', false), -- Terça
  (3, '08:00', '18:00', false), -- Quarta
  (4, '08:00', '18:00', false), -- Quinta
  (5, '08:00', '18:00', false), -- Sexta
  (6, '08:00', '13:00', false)  -- Sábado meio período
on conflict do nothing;

-- Configs da clínica
insert into public.config_clinica (chave, valor) values
  ('nome_clinica', 'Clínica Estética'),
  ('telefone', ''),
  ('whatsapp', ''),
  ('endereco', ''),
  ('evo_instance', ''),
  ('evo_api_url', ''),
  ('evo_api_key', '')
on conflict (chave) do nothing;

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================

alter table public.profiles enable row level security;
alter table public.profissionais enable row level security;
alter table public.clientes enable row level security;
alter table public.categorias_procedimento enable row level security;
alter table public.procedimentos enable row level security;
alter table public.agendamentos enable row level security;
alter table public.pacotes_cliente enable row level security;
alter table public.pagamentos enable row level security;
alter table public.config_lembretes enable row level security;
alter table public.config_clinica enable row level security;
alter table public.horarios_funcionamento enable row level security;

-- Políticas: usuários autenticados têm acesso total (ajustar por role depois)
create policy "auth_all" on public.profiles for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.profissionais for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.clientes for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.categorias_procedimento for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.procedimentos for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.agendamentos for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.pacotes_cliente for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.pagamentos for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.config_lembretes for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.config_clinica for all using (auth.role() = 'authenticated');
create policy "auth_all" on public.horarios_funcionamento for all using (auth.role() = 'authenticated');

-- =============================================
-- FUNÇÃO: cria perfil automaticamente após signup
-- =============================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nome, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', split_part(new.email, '@', 1)),
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'recepcionista')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =============================================
-- VIEWS ÚTEIS
-- =============================================

-- Agendamentos com dados completos
create or replace view public.v_agendamentos as
select
  a.id,
  a.data_hora,
  a.data_hora_fim,
  a.status,
  a.preco_cobrado,
  a.observacoes,
  a.lembrete_enviado,
  a.pacote_id,
  c.id as cliente_id,
  c.nome as cliente_nome,
  c.telefone as cliente_telefone,
  p.id as profissional_id,
  p.nome as profissional_nome,
  p.cor_agenda as profissional_cor,
  pr.id as procedimento_id,
  pr.nome as procedimento_nome,
  pr.duracao_minutos,
  cat.nome as categoria_nome,
  cat.cor as categoria_cor
from public.agendamentos a
join public.clientes c on c.id = a.cliente_id
join public.profissionais p on p.id = a.profissional_id
join public.procedimentos pr on pr.id = a.procedimento_id
left join public.categorias_procedimento cat on cat.id = pr.categoria_id;

-- Resumo financeiro por mês
create or replace view public.v_financeiro_mensal as
select
  date_trunc('month', data_pagamento) as mes,
  count(*) as total_transacoes,
  sum(valor) filter (where status = 'pago') as receita,
  sum(valor) filter (where status = 'pendente') as pendente,
  metodo,
  count(*) filter (where status = 'pago') as transacoes_pagas
from public.pagamentos
group by date_trunc('month', data_pagamento), metodo;
