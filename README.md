# SDR IA - Qualificador de Leads | Direito Previdenciário

Agente de IA no WhatsApp que atua como SDR (Sales Development Representative) para qualificar leads de Direito Previdenciário via n8n.

## Como funciona

1. Lead envia mensagem no WhatsApp
2. Agente conduz entrevista de qualificação (critérios customizados para Previdenciário)
3. **Se qualificado**: extrai nome, celular e tese, envia relatório para número do advogado
4. **Se não qualificado**: encerra a conversa educadamente

## Stack

| Componente | Tecnologia |
|---|---|
| Automação | n8n (self-hosted ou cloud) |
| WhatsApp | Evolution API |
| IA | OpenAI GPT-4o ou Claude 3.5 Sonnet |
| Busca na web | Tavily API |
| Memória de sessão | Redis |
| Arquivos | Supabase Storage ou S3 |

## Arquivos do projeto

```
├── README.md                  # Este arquivo
├── agent-prompt.md            # Prompt/instruções do agente SDR
└── workflow.json              # Workflow n8n (importar diretamente)
```

## Como importar o workflow no n8n

1. Abra seu n8n
2. Clique em **Workflows > Import from file**
3. Selecione o arquivo `workflow.json`
4. Configure as credenciais (veja seção abaixo)

## Credenciais necessárias

- `EVOLUTION_API_URL` — URL da sua instância Evolution API
- `EVOLUTION_API_KEY` — Chave da Evolution API
- `OPENAI_API_KEY` — Chave da OpenAI (ou Anthropic)
- `TAVILY_API_KEY` — Chave da Tavily (busca na web)
- `NUMERO_ADVOGADO` — Número do WhatsApp que recebe leads qualificados (ex: `5511999999999`)
- `REDIS_URL` — URL do Redis para memória de sessão

## Critérios de qualificação (Direito Previdenciário)

Veja detalhes em [`agent-prompt.md`](./agent-prompt.md).

Resumo dos critérios:
- Possui vínculo com o INSS (contribuiu ou é dependente)
- Tem benefício negado, cancelado ou a requerer
- Identifica a tese jurídica aplicável ao caso
- É o titular ou familiar direto do segurado
