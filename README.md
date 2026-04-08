# jiraToMongo

Pacote **autónomo** que extrai issues do **Jira Cloud** (histórico por pessoa), gera um **CSV** rico em métricas de fluxo (DORA/Flow) e grava os mesmos dados no **MongoDB**. Podes copiar só esta pasta para outra máquina — não depende do restante do repositório `agent-rag`.

## O que faz

1. **(Opcional)** Se `JIRA_BOARD_ID` estiver definido, percorre as issues de cada board Agile, recolhe **assignees com e-mail visível** na API e **cria ou atualiza** o ficheiro `developers.json` (novos entram em `developers.jira_boards`; quem já existe noutra categoria só é atualizado se nome ou `jiraAccountId` mudarem).
2. Lê a lista de pessoas em **`developers.json`** (ou no caminho em `DEVELOPERS_JSON`).
3. Para cada pessoa, consulta o Jira (JQL + resolução de assignee → `accountId`) e obtém issues **concluídas** no período escolhido.
4. Enriquece dados de **sprints** (metadados via API Agile).
5. Gera **`exports/issues_dora_flow_*.csv`** e faz **upsert** na coleção **`issues_dora_flow`** do MongoDB.

Durante pedidos longos ao Jira, o script mostra **spinner e texto de progresso** (board N/M, pessoa I/N, fases Sprint/Mongo) para não parecer “travado”.

## Requisitos

- **Node.js** ≥ 18  
- Conta **Jira Cloud** com **API token** ([Atlassian → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens))  
- **`JIRA_USER`** = e-mail da mesma conta Atlassian que criou o token  
- **MongoDB** (opcional se usares `--no-mongo`)

## Instalação rápida

```bash
cd jiraToMongo
npm install
cp env.example .env
# Edite .env com JIRA_* e MONGO_URI
```

Coloca um **`developers.json`** nesta pasta (mesmo formato que `config/developers.json` no monorepo: objeto `developers` com categorias e arrays de pessoas com `name`, `email`, `username`, `role`, `squad`, `tribe`, etc.).

```bash
# Exemplo se ainda tiveres o repo agent-rag ao lado:
# cp ../config/developers.json ./developers.json
```

## Executar

```bash
npm run extract
# ou
node extract.mjs --year=2026
```

### Argumentos úteis

| Argumento | Efeito |
|-----------|--------|
| `--year=2026` | Ano alvo (com `--months` controla profundidade da busca quando um só ano). |
| `--years=2025,2026` | Vários anos. |
| `--months=12` | Meses a considerar na janela de busca (com um único `--year`). |
| *(nenhum ano)* | Padrão: **jan/2026 até hoje**. |
| `--no-csv` | Só MongoDB. |
| `--no-mongo` | Só CSV. |
| `--skip-existing` | Mongo: não altera documentos cuja `key` já existe (só insere novas). |
| `--no-sync-developers` | Não atualiza `developers.json` a partir dos boards (usa só o JSON manual). |

## Variáveis de ambiente (`.env`)

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `JIRA_BASE_URL` | Sim | Ex.: `https://empresa.atlassian.net` |
| `JIRA_USER` | Sim | E-mail Atlassian |
| `JIRA_TOKEN` | Sim | API token |
| `JIRA_BOARD_ID` | Não | IDs separados por vírgula; ativa sincronização da lista a partir dos boards |
| `JIRA_AGILE_BASE_URL` | Não | Por defeito `{JIRA_BASE_URL}/rest/agile/1.0` |
| `MONGO_URI` | Se gravar Mongo | Connection string |
| `MONGO_KR_DB` ou `MONGO_DORA_DB` | Não | Nome da base (por defeito `agent-rag`) |
| `DEVELOPERS_JSON` | Não | Caminho absoluto ou relativo a esta pasta para o `developers.json` |

Lista completa comentada: **`env.example`**.

## Saídas

- **CSV:** pasta **`exports/`** (UTF-8 com BOM), nome tipo `issues_dora_flow_dora_flow_2026_YYYYMMDD_HHMMSS.csv`.  
- **MongoDB:** base definida por `MONGO_KR_DB` / `MONGO_DORA_DB`, coleção **`issues_dora_flow`**, um documento por issue (`key` como identificador lógico).

Colunas incluem tempos por status (`timeInStatus_lifetime_*`, `timeInStatus_windowed_*`), sprint, cycle time, tribo/squad vindos do `developers.json`, etc.

## Sincronização pelos boards

Com **`JIRA_BOARD_ID`**:

- O Jira por vezes **oculta e-mail** do assignee; essas ocorrências são **ignoradas** na lista automática (aparece aviso no log). Para esses utilizadores, mantém entradas manuais no JSON ou usa **`jiraAccountId`** por pessoa.
- A permissão **Browse users and groups** ajuda na resolução assignee → `accountId` na extração principal.

## Uso isolado (sem o projeto agent-rag)

1. Copia a pasta **`jiraToMongo`** inteira (incluindo **`lib/`**).  
2. `npm install` dentro dela.  
3. `.env` + `developers.json` (ou `DEVELOPERS_JSON`).  
4. `npm run extract`

Não é necessário clonar o repositório `agent-rag`.

## Estrutura da pasta

```
jiraToMongo/
├── extract.mjs              # CLI principal
├── package.json
├── env.example
├── README.md
├── lib/
│   ├── apiUtils.js          # HTTP autenticado (axios)
│   ├── jiraService.js       # Jira: JQL, histórico, métricas
│   ├── DeveloperService.js# Leitura de developers.json
│   ├── syncDevelopersFromBoards.js
│   └── cliSpinner.js
├── developers.json          # (criar/copiar — não vem no repo vazio)
├── .env                     # (criar a partir de env.example)
└── exports/                 # CSVs gerados (criado automaticamente)
```

## Manutenção

Se o `jiraService.js` do monorepo `agent-rag` for muito alterado, podes voltar a copiar:

- `src/infrastructure/apiUtils.js` → `lib/apiUtils.js`  
- `src/infrastructure/services/jira/jiraService.js` → `lib/jiraService.js`  

No `jiraService` copiado, mantém o import `from "./apiUtils.js"` e **remove** `dotenv` no topo (o `.env` é carregado só em `extract.mjs`).

## Problemas comuns

- **401 no Jira:** token expirado ou `JIRA_USER` não corresponde à conta do token.  
- **0 issues para todos:** falha em `user/search` ou JQL com assignee; confirma permissões e, se preciso, preenche **`jiraAccountId`** no `developers.json`.  
- **`NODE_TLS_REJECT_UNAUTHORIZED=0`:** aviso do Node se essa variável estiver ativa no ambiente; desativa em produção se possível.

---

**Resumo:** `jiraToMongo` é um extrator **Jira → CSV + Mongo** com lista de pessoas configurável, opcionalmente **alimentada pelos boards**, pensado para correr **em qualquer sítio** com Node e credenciais corretas.
