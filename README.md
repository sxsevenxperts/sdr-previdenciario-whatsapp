# 🤖 XPERT.IA — SDR Previdenciário via WhatsApp

SaaS multi-tenant: agente de IA que qualifica leads de Direito Previdenciário no WhatsApp. Cada advogado/escritório tem sua própria instância isolada, gerenciada por um admin central.

---

## Fluxo geral

```
Lead manda mensagem no WhatsApp
         ↓
Evolution API → Webhook n8n
         ↓
Identifica o cliente pelo nome da instância (evo_instance)
         ↓
Agente SDR faz as perguntas de qualificação
  + ouve áudios (Whisper)
  + pesquisa na web (SerpAPI)
  + consulta base de conhecimento em PDF (RAG pgvector)
         ↓
       Qualificado?
       ├── SIM → stage = 'qualificado' no CRM
       └── NÃO → stage = 'nao_qualificado'

Admin / cliente acompanham tudo no painel XPERT.IA:
  - CRM Kanban com drag-and-drop
  - Bate-papo ao vivo (pausa o agente)
  - Relatórios, billing, tokens
```

---

## Stack

| Componente | Tecnologia | Função |
|---|---|---|
| Painel | `software/index.html` (HTML/CSS/JS + Supabase JS) | Interface admin e cliente |
| Deploy painel | Docker + EasyPanel | Serve o HTML via nginx |
| Automação | n8n (self-hosted) | Orquestra os 3 workflows |
| WhatsApp | Evolution API | Envio/recebimento de mensagens |
| IA | OpenAI GPT-4o + Whisper | Agente conversacional + transcrição de áudio |
| Busca web | SerpAPI | Valida informações previdenciárias |
| Banco de dados | Supabase (Postgres) | Multi-tenant com RLS |
| RAG | Supabase pgvector | Base de conhecimento em PDFs |
| Auth | Supabase Auth | Login admin e clientes |
| Edge Functions | Supabase Functions | CRUD seguro de clientes (admin only) |

---

## Estrutura de arquivos

```
xpert-ia/
├── software/
│   ├── index.html              # Painel completo (SPA)
│   └── Dockerfile              # Build para EasyPanel
├── supabase/
│   ├── migrations/
│   │   └── 20260227170556_add_multi_tenancy.sql  # Schema completo
│   └── functions/
│       ├── manage-clients/
│       │   └── index.ts        # Edge Function (CRUD de clientes — admin only)
│       └── process-pdf/
│           └── index.ts        # Edge Function (upload PDF → embeddings pgvector)
├── workflow-agente-sdr.json    # ← O ÚNICO WORKFLOW NECESSÁRIO
├── .env.example                # Variáveis de ambiente necessárias
└── README.md
```

---

## Multi-tenancy: como funciona

**Um único set de 3 workflows n8n serve TODOS os clientes.**

```
Mensagem chega de instância "escritorio-silva"
         ↓
n8n: SELECT user_id FROM profiles WHERE evo_instance = 'escritorio-silva'
         ↓
Todos os dados (configs, leads, sessões, docs) filtrados por user_id
RLS do Supabase garante isolamento total
```

Cada cliente tem:
- Seu próprio login (email + senha)
- Sua própria instância Evolution API
- Seus próprios leads, configurações e documentos

---

## Sistema de usuários

### Dois tipos de acesso

| Tipo | Como acessar | O que vê |
|---|---|---|
| **Admin** (`role = 'admin'`) | Login normal no painel | Tudo: todos os clientes, billing global, uso de tokens, pedidos |
| **Cliente** (`role = 'client'`) | Login normal no painel | Apenas seus próprios dados |

### Como criar o admin inicial

1. No Supabase → Authentication → Users → Add User
2. Preencha email e senha
3. No SQL Editor do Supabase:
```sql
UPDATE profiles SET role = 'admin' WHERE id = 'uuid-do-usuario-criado';
```

### Como criar um novo cliente (via painel)

1. Logue como admin
2. Menu lateral → **👥 Clientes**
3. Clique em **➕ Adicionar cliente**
4. Preencha: nome, email, senha, nome da instância EVO
5. O sistema cria automaticamente: conta de auth, profile, assinatura trial, 500k tokens

### O que acontece automaticamente ao criar um cliente

```
adminFetch POST /manage-clients
    ↓
Cria auth.users (email + senha)
    ↓ trigger
Cria profiles (role=client, evo_instance=...)
    ↓
Cria assinaturas (status=trial)
    ↓
Cria tokens_creditos (500k tokens iniciais)
```

### Após criar o cliente — passo manual obrigatório

Criar a instância no Evolution API com exatamente o mesmo nome do campo `evo_instance`:

```bash
# Via API do Evolution
POST https://sua-evo-api.com/instance/create
{
  "instanceName": "nome-que-você-definiu",
  "qrcode": true,
  "integration": "WHATSAPP-BAILEYS"
}
```

O cliente então escaneia o QR code no painel → WhatsApp → Código QR.

---

## Configuração inicial (do zero)

### 1. Supabase

```bash
# No SQL Editor do Supabase, execute:
supabase/migrations/20260227170556_add_multi_tenancy.sql
```

Depois ative a extensão pgvector:
```
Supabase Dashboard → Database → Extensions → vector → Enable
```

### 2. Edge Functions

```bash
# Com Supabase CLI instalado:
supabase functions deploy manage-clients --project-ref SEU_PROJECT_ID
supabase functions deploy process-pdf --project-ref SEU_PROJECT_ID
```

Ou via Supabase Dashboard → Edge Functions → New Function:
- Cole `supabase/functions/manage-clients/index.ts` → função `manage-clients`
- Cole `supabase/functions/process-pdf/index.ts` → função `process-pdf`

Configure os Secrets da Edge Function no Supabase Dashboard → Edge Functions → Secrets:
```
SUPABASE_URL=https://SEU_PROJECT_ID.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
OPENAI_API_KEY=sk-proj-...
```

### 3. n8n — importar o workflow

Importe o único arquivo necessário:
- `workflow-agente-sdr.json`

Configure as credenciais:
| Credencial | Onde criar no n8n |
|---|---|
| Supabase | Credentials → Supabase API → URL + Service Role Key |
| OpenAI | Credentials → OpenAI → API Key |
| SerpAPI | Credentials → SerpAPI → API Key |
| Evolution API | Credencial HTTP Header Auth (chave global) |

**Webhook URL** do workflow-3 → configure no Evolution API como webhook global ou por instância.

### 4. Deploy do painel (EasyPanel)

1. Conecte o repositório GitHub
2. Crie um serviço → **App** → Source: GitHub, Build Path: `/software`
3. EasyPanel detecta o Dockerfile automaticamente
4. O painel sobe em nginx na porta 80

### 5. Configurar o painel

No `software/index.html`, localize e atualize as constantes:
```javascript
const SUPABASE_URL = 'https://SEU_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGci...';
const EVOLUTION_API_URL = 'https://sua-evo-api.com';
const EVOLUTION_API_KEY = 'SUA_CHAVE';
```

---

## O único workflow n8n necessário

**`workflow-agente-sdr.json`** — importe este arquivo no n8n e configure as credenciais. Só isso.

> Configs do agente são feitas pelo painel (salvas direto no Supabase).
> Upload de PDFs é feito pelo painel (salvo direto no Supabase pgvector via Edge Function).

### Nós do workflow

```
Webhook Evolution API
  → Normaliza e filtra mensagem
  → É áudio? → Transcreve (Whisper)
  → Resolve cliente pelo instanceName
  → Carrega configurações do Supabase
  → Verifica saldo de tokens
  → Busca histórico da sessão
  → Agente SDR — IA (GPT-4o)
      ├── Tool: Busca na Web (SerpAPI)
      └── Tool: Base de Conhecimento PDF (pgvector)
  → Processa resposta e qualificação
  → Salva histórico na sessão
  → Salva/atualiza lead (upsert com stage)
  → Responder em áudio? → TTS OpenAI
  → Envia mensagem via Evolution API
```

---

## CRM Kanban

Estágios padrão (configuráveis pelo usuário via painel):

| Stage ID | Label | Gatilho |
|---|---|---|
| `novo_contato` | 🆕 Novo Contato | Automático — primeira mensagem |
| `em_atendimento` | 💬 Em Atendimento | Automático — agente responde |
| `qualificado` | ✅ Qualificado | Automático — agente qualifica |
| `nao_qualificado` | ❌ Não Qualificado | Automático — agente desqualifica |
| `convertido` | 🎉 Convertido | Manual |
| `perdido` | 🚪 Perdido | Manual |

Colunas são customizáveis: adicionar, renomear, reordenar, trocar cor.
Configuração salva em `agente_config` (chave: `crm_stages`) por usuário.

---

## Segurança

- **RLS ativo em todas as tabelas** — cliente nunca acessa dado de outro cliente
- **Edge Function `manage-clients`** — verifica `role = 'admin'` no JWT antes de qualquer operação
- **Service Role Key** — usada apenas nas Edge Functions (nunca exposta no frontend)
- **Anon Key** — usada no frontend (acesso limitado pelas RLS policies)

---

## Variáveis de ambiente

Veja `.env.example` para a lista completa de variáveis necessárias.
