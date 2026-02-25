# SDR IA — WhatsApp | Direito Previdenciário
### 100% n8n + Evolution API + Supabase

Agente de IA no WhatsApp que qualifica leads de Direito Previdenciário.
Tudo configurável por formulário, sem precisar editar código.

---

## Como funciona

```
Lead manda mensagem no WhatsApp
        ↓
Agente SDR faz as perguntas de qualificação
        ↓
   Qualificado?
   ├── SIM → envia relatório (nome + celular + resumo) pro advogado
   └── NÃO → encerra a conversa educadamente
```

---

## Os 3 Workflows

| Arquivo | Nome no n8n | Para que serve |
|---|---|---|
| `workflow-1-painel-config.json` | ⚙️ Painel de Configuração | Formulário para editar prompt, tom, instruções e número de destino |
| `workflow-2-upload-pdf.json` | 📄 Upload de PDFs | Processa PDFs e salva como base de conhecimento |
| `workflow-3-agente-sdr.json` | 🤖 Agente SDR WhatsApp | Workflow principal — roda o agente |

---

## Stack

| Componente | Tecnologia | Função |
|---|---|---|
| Automação | n8n | Orquestra tudo |
| WhatsApp | Evolution API | Envia e recebe mensagens |
| IA | OpenAI GPT-4o | Cérebro do agente |
| Busca na web | Tavily API | Valida informações previdenciárias |
| Banco de dados | Supabase | Guarda configs, PDFs e leads |
| PDFs (RAG) | Supabase pgvector | Base de conhecimento consultada pelo agente |

---

## Pré-requisitos

1. **n8n** instalado (self-hosted ou cloud)
2. **Evolution API** com instância WhatsApp conectada
3. **Supabase** — conta gratuita em supabase.com
4. **OpenAI** — chave de API em platform.openai.com
5. **Tavily** — chave gratuita em tavily.com

---

## Configuração do Supabase

Execute este SQL no editor do Supabase (SQL Editor → New Query):

```sql
-- Tabela de configurações do agente
CREATE TABLE agente_config (
  id SERIAL PRIMARY KEY,
  chave TEXT UNIQUE NOT NULL,
  valor TEXT,
  atualizado_em TIMESTAMP DEFAULT NOW()
);

-- Inserir configurações padrão
INSERT INTO agente_config (chave, valor) VALUES
  ('numero_destino', '5511999999999'),
  ('prompt_sistema', 'Você é um assistente de triagem de Direito Previdenciário...'),
  ('tonalidade', 'Empático, claro e objetivo. Use linguagem simples.'),
  ('instrucoes_comunicacao', 'Faça uma pergunta por vez. Nunca prometa resultado.'),
  ('objetivo', 'Qualificar leads previdenciários e encaminhar ao advogado.'),
  ('criterios_qualificacao', 'Vínculo INSS, benefício identificável, tese jurídica possível');

-- Tabela para base de conhecimento (PDFs)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documentos_conhecimento (
  id BIGSERIAL PRIMARY KEY,
  conteudo TEXT,
  metadata JSONB,
  embedding VECTOR(1536)
);

CREATE INDEX ON documentos_conhecimento
  USING ivfflat (embedding vector_cosine_ops);

-- Tabela de leads
CREATE TABLE leads (
  id SERIAL PRIMARY KEY,
  numero_whatsapp TEXT,
  nome TEXT,
  celular TEXT,
  tese TEXT,
  resumo TEXT,
  qualificado BOOLEAN,
  motivo_desqualificacao TEXT,
  criado_em TIMESTAMP DEFAULT NOW()
);
```

---

## Como importar os workflows no n8n

1. No n8n, clique em **Workflows → Import from file**
2. Importe nesta ordem:
   - `workflow-1-painel-config.json`
   - `workflow-2-upload-pdf.json`
   - `workflow-3-agente-sdr.json`
3. Em cada workflow, configure as credenciais (Supabase, OpenAI, Evolution API, Tavily)
4. Ative os workflows

---

## Variáveis de ambiente no n8n

Configure em **Settings → Environment Variables**:

```
EVOLUTION_API_URL=https://sua-evolution-api.com
EVOLUTION_API_KEY=sua-chave
EVOLUTION_INSTANCE=nome-da-instancia
```

---

## Como usar o Painel de Configuração

1. Ative o **Workflow 1**
2. Acesse a URL do formulário (mostrada no node Form Trigger)
3. Preencha e salve — as mudanças valem imediatamente

## Como adicionar PDFs

1. Ative o **Workflow 2**
2. Acesse a URL do formulário de upload
3. Envie o PDF — o sistema processa automaticamente
