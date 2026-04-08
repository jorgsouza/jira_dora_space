# PRD-00 — jiraToMongo: extrator Jira → CSV + MongoDB

**Versão do documento:** 1.0  
**Alinhamento ao código:** pacote autónomo em `/` (Node ≥ 18), entrada `extract.mjs`, serviços em `lib/`.  
**Tipo:** documentação de produto *as-is* (comportamento implementado), não roadmap de novas features.

---

## 1. Resumo executivo

**jiraToMongo** é uma aplicação de linha de comando que extrai issues do **Jira Cloud** atribuídas a uma lista configurável de pessoas (`developers.json`), calcula métricas de **fluxo de trabalho** (tempos por status, cycle time, bloqueios, sprints, handoffs, reopens, dependências) e persiste o resultado em:

- ficheiro **CSV** (UTF-8 com BOM) na pasta `exports/`, e/ou
- coleção **MongoDB** `issues_dora_flow` (upsert por `key`).

O objetivo de negócio é suportar **análise de entrega** (incluindo indicadores no espírito **DORA/Flow**, flow efficiency, lead time/cycle time) sem depender do resto de um monorepo maior.

---

## 2. Problema e objetivos

### 2.1 Problema

- Dados de trabalho vivem no Jira; relatórios nativos nem sempre expõem **histórico de changelog** de forma consumível para BI.
- Equipas precisam cruzar issues com **dimensões organizacionais** (tribo, squad, função, senioridade) que não vêm só do Jira.
- Destinos comuns são **ficheiros** (partilha, Excel) e **bases analíticas** (MongoDB).

### 2.2 Objetivos do produto

1. Extrair issues **concluídas** num **período temporal** definível, por **assignee** (via e-mail / accountId).
2. Calcular métricas de tempo e fluxo de forma **reprodutível** a partir do changelog.
3. Enriquecer com **metadados de sprint** (API Agile) e com dados de **developers.json**.
4. Exportar para **CSV** e/ou **MongoDB** com esquema estável o suficiente para dashboards.

### 2.3 Não objetivos (fora de escopo atual)

- UI web ou API HTTP própria.
- Autenticação OAuth interativa (usa Basic com e-mail + API token).
- Garantir compatibilidade com Jira Server/Data Center (desenvolvido para **Jira Cloud** e endpoints documentados para Cloud).

---

## 3. Utilizadores e casos de uso

| Ator | Caso de uso |
|------|-------------|
| Engenheiro de dados / DevOps | Correr extração agendada (cron/CI) e carregar MongoDB. |
| Líder técnico / Agile | Gerar CSV para análise de cycle time, bloqueios e throughput por squad. |
| Administrador do projeto | Manter `developers.json` e `.env`; opcionalmente sincronizar lista a partir de boards. |

---

## 4. Arquitetura lógica

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ developers.json │────▶│   extract.mjs    │◀────│ .env (Jira/Mongo)│
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Jira REST +     │     │ jiraService.js   │     │ syncDevelopers  │
│ Jira Agile      │     │ (métricas/changelog)     │ FromBoards      │
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ CSV (exports/)   │
                        │ MongoDB upsert   │
                        └──────────────────┘
```

**Componentes principais**

| Componente | Ficheiro | Responsabilidade |
|------------|----------|------------------|
| CLI | `extract.mjs` | Args, período, orquestração, filtro por data de resolução, CSV, Mongo. |
| Jira | `lib/jiraService.js` | JQL, paginação, resolução assignee→accountId, cálculos de métricas. |
| Developers | `lib/DeveloperService.js` | Leitura de `developers.json` (categorias → lista plana). |
| Sync boards | `lib/syncDevelopersFromBoards.js` | Atualizar JSON a partir de assignees nos boards. |
| HTTP | `lib/apiUtils.js` | Axios + Basic auth + erros. |
| UX terminal | `lib/cliSpinner.js` | Spinner durante chamadas longas. |

---

## 5. Requisitos funcionais

### FR-01 — Credenciais e configuração

- Exige `JIRA_BASE_URL`, `JIRA_USER`, `JIRA_TOKEN` no `.env`.
- MongoDB opcional: se `MONGO_URI` ausente e export Mongo ativado, regista aviso e ignora gravação.

### FR-02 — Lista de pessoas

- Carrega desenvolvedores de `developers.json` na raiz do pacote ou caminho em `DEVELOPERS_JSON`.
- Estrutura: objeto `developers` com chaves de categoria (ex.: `frontend`, `jira_boards`) e arrays de objetos com pelo menos `email` (e tipicamente `name`, `username`, `role`, `squad`, `tribe`, opcional `jiraAccountId`).

### FR-03 — Sincronização opcional a partir de boards

- Se `JIRA_BOARD_ID` (IDs separados por vírgula) e sync ativo (não `--no-sync-developers`):
  - Percorre issues dos boards via REST Agile.
  - Assignees **sem e-mail visível** na API são ignorados (contador de skipped).
  - Novos entram em categoria `jira_boards`; existentes podem atualizar nome / `jiraAccountId` / e-mail.

### FR-04 — Resolução de assignee para JQL

- Preferência: `jiraAccountId` no JSON → fragmento JQL `assignee = "<accountId>"`.
- Caso contrário: chamadas a `GET /rest/api/3/user/search` com várias queries derivadas do e-mail, username e nome; resultado cacheado na execução.

### FR-05 — Busca de issues

- Endpoint: `GET /rest/api/3/search/jql` com `expand=changelog` e campos incluindo status, datas, tipo, prioridade, links, comentários, epic, labels, **sprint** (`customfield_10007` / `customfield_10020`), vários custom fields candidatos a **story points**.
- Com **ano** explícito: JQL cobre issues resolvidas no ano ou atualizadas no ano ainda não “Done”.
- **Paginação:** `startAt` incrementado de `maxResults` em `maxResults` (100), até limite de páginas; deduplicação por `key`.
- **Fallback:** se a paginação devolver apenas duplicados no 2.º passo, pode tentar busca **mês a mês** para o mesmo ano.

### FR-06 — Filtro “concluídas no período”

- Após busca, o CLI filtra issues com `resolved` preenchido e data de resolução (string `YYYY-MM-DD`) **inclusivamente** entre os limites do período.
- **Importante:** comparação por string `YYYY-MM-DD` contra limites derivados de `Date` local formatado com `toYmd()`, para evitar exclusões erradas por interpretação UTC de `new Date("YYYY-MM-DD")`.

### FR-07 — Enriquecimento de sprint (dimensão)

- Coleta todos os `sprintId` únicos (issue atual + histórico).
- Consulta `GET .../rest/agile/1.0/sprint/{id}` em lotes (cache global na execução).
- Preenche nomes e datas em issues e no histórico quando faltam.

### FR-08 — Export CSV

- Cabeçalhos fixos + colunas dinâmicas `timeInStatus_lifetime_<Status>` e `timeInStatus_windowed_<Status>` para cada status observado no conjunto.
- Valores numéricos de tempo em CSV com **2 casas decimais** (dias).
- Booleanos exportados como `SIM` / `NÃO` onde aplicável.

### FR-09 — Export MongoDB

- Base: `MONGO_KR_DB` ou `MONGO_DORA_DB` ou default `agent-rag`.
- Coleção: `issues_dora_flow`.
- `updateOne({ key }, { $set: { ...doc, updatedAt } }, { upsert: true })`.
- Opção `--skip-existing`: não escreve documentos cuja `key` já existe (apenas inserts de keys novas).

### FR-10 — CLI

Argumentos implementados:

| Argumento | Comportamento |
|-----------|----------------|
| `--year=AAAA` | Ano alvo; com `--months` ajusta profundidade da janela JQL quando um só ano. |
| `--years=a,b` | Vários anos em sequência. |
| `--months=N` | Número de meses (default derivado do mês corrente quando um ano). |
| *(nenhum ano)* | Modo default: **jan/2026 até hoje** (anos efetivos `[2026]`). |
| `--no-csv` | Não gera CSV. |
| `--no-mongo` | Não grava MongoDB. |
| `--skip-existing` | Mongo: só insere keys novas. |
| `--no-sync-developers` | Não executa sync a partir dos boards. |

---

## 6. Modelo de dados de saída (campos principais)

Documento/linha orientado por **issue** (`key` única no export final após deduplicação).

### 6.1 Identificação e organização

- `key`, `title` (resumo truncado), `assignee`, `email` (fluxo interno), `tribe`, `squad`, `stack` (categoria do papel), `function`, `seniority` (derivado de texto do role), `workType` (bug/feature/suporte/outros).

### 6.2 Issue

- `issueType`, `priority`, `status`, `sp` (story points normalizados, ≥ 0), `epic`, `labels`.

### 6.3 Tempo e fluxo

- `ctDays`: dias entre início e fim do cycle time **no export**, com 1 casa decimal; vazio se inválido.
- `invalidForCT`: `true` se faltam datas ou fim < início.
- `createdAt`, `createdAtTs`, `resolvedAt`, `resolvedAtTs`, `start`, `end` (janela usada para CT no export: preferência por `cycleTimeStartedAt` / `cycleTimeDoneAt` do serviço, com fallback created/resolution).
- `blockedHours` (`totalBlockHours`), `hasDependencies`, `handoffCount`, `assigneeCount`, `statusChanges`, `wasReopened`.
- `statusInitial`, `statusFinal` (primeiro/último do histórico de status quando existir).

### 6.4 Tempos por status (dias)

- **`timeInStatus_lifetime_<Status>`** — tempo acumulado em cada status ao longo da vida da issue, a partir do changelog (último segmento até `resolutiondate` ou “agora”).
- **`timeInStatus_windowed_<Status>`** — interseção dos segmentos de status com o intervalo **[start, end]** usado para cycle time no export (útil para **flow efficiency** e análise só no período “ativo”).

Valores negativos são **corrigidos para 0** (com contagem interna de ocorrências para log).

### 6.5 Sprint

- `sprintNames` (lista), `lastSprintName`, `lastSprintStartDate`, `lastSprintEndDate`, `lastAddedToSprintAt`, `wasRemovedFromSprint`, `lastRemovedFromSprintAt`, `sprintCreated`, `sprintResolved`.

### 6.6 MongoDB — metadados de carga

- `data_export` (data ISO YYYY-MM-DD), `ano_mes` (YYYY-MM), `updatedAt`.

---

## 7. Especificação de cálculos (comportamento implementado)

### 7.1 Cycle time (`calculateCycleTime` no `jiraService`)

**Conceito:** tempo desde o início de trabalho “ativo” até conclusão.

1. **Estados inativos (exemplos):** to do, backlog, aberto, open, new, aguardando, waiting, blocked, bloqueado (match por substring case-insensitive).
2. **Estados ativos:** in progress, doing, em desenvolvimento, working, active, development, em andamento, etc.
3. **Estados done:** done, concluído, resolvido, fechado, closed, completed, merged, released, etc.

**Início (`startedAt`):**

- Primeira transição no changelog de **inativo → ativo**; ou
- Se criada já em ativo: data de criação; ou
- Fallbacks: `lastInactiveStatus`, `created`, conforme histórico.

**Fim (`doneAt`):**

- Primeira transição para status **done** no changelog; ou
- `resolutiondate` se não houver no changelog.

**Duração:** `(doneAt - startedAt) / 86400000` dias. Se sem changelog válido, fallback **created → resolutiondate** quando possível.

### 7.2 `ctDays` no `extract.mjs`

- `startParsed` / `endParsed` a partir de strings de data (ISO ou com hora).
- `daysBetween = (end - start) / (24 * 60 * 60 * 1000)` → exportado com **`toFixed(1)`** (número).

### 7.3 Tempo por status (`analyzeStatusTime`)

- Percorre histórico ordenado; a cada mudança de `status`, acumula no status **de origem** a duração até o instante da mudança: `(changeTime - currentStatusStart) / 86400000` dias.
- Estado inicial assume-se desde `fields.created`.
- Fecho do último segmento: até `resolutiondate` ou data atual.

### 7.4 Janela (`computeTimeInStatusWindowed`)

Para cada segmento `[segStart, segEnd]` em `statusHistory`:

- `overlapStart = max(segStart, windowStart)`
- `overlapEnd = min(segEnd, windowEnd)`
- Se `overlapEnd > overlapStart`, soma `(overlapEnd - overlapStart) / 86400000` ao status.

### 7.5 Workflow por fases (`decomposeWorkflow`)

Mapeia **primeira** ocorrência de transição para categorias: to do, in progress, in review, qa, ready for release, done. Calcula durações em dias entre marcos (dev → review → qa → release → done) com encadeamentos alternativos se faltar review/QA.  
`activeTimeDays = devTimeDays + reviewTimeDays + qaTimeDays`.  
`totalTimeDays = doneAt - toDoAt` quando ambos existem.

### 7.6 Bloqueios (`detectBlockPeriods`)

- Campo `flagged` / `flag`: transição para impedimento → início; saída → fim; `durationHours = (unblock - block) / (1000 * 60 * 60)`.
- Status com substring `block` ou `impediment` tratado de forma análoga.
- Período ainda aberto: `unblockedAt` null, `durationHours` null.
- **`totalBlockHours`:** soma dos `durationHours` dos períodos **fechados**.

### 7.7 Reopens e rework (`detectReopens`)

- **Reopen:** após ter estado em done, transição **de** done **para** estado “reaberto” / to do / in progress (heurística por nomes).
- **Rework:** entrada em status como sub-bug, rework, correção, needs fix, etc. (independente de ciclo done).

### 7.8 Dependências (`extractDependencies`)

- A partir de `issuelinks`: blocked by, blocks, relates to, duplicates; `hasDependencies` se qualquer contagem > 0.

### 7.9 Handoffs (`analyzeAssigneeChanges`)

- Cada mudança do campo `assignee` no changelog incrementa `handoffCount` e acumula tempo por assignee em dias.

### 7.10 Story points (`extractStoryPoints`)

- Itera lista fixa de `customfield_*` típicos de instalações Jira; aceita número, string numérica ou alguns formatos objeto.

### 7.11 Comentários (`analyzeComments`)

- `averageCommentsPerDay = commentCount / ((resolved - created) em dias)` quando > 0.

### 7.12 Senioridade (`extractSeniority` no `extract.mjs`)

- Analisa `role2` ou `role`: senior/sênior → Senior; pleno → Pleno; junior/júnior → Junior; estagiário → Estagiário; senão N/A.

---

## 8. Integrações externas

### 8.1 Jira Cloud

| Uso | Endpoint / notas |
|-----|-------------------|
| Pesquisa de utilizador | `GET /rest/api/3/user/search` |
| Issues + changelog | `GET /rest/api/3/search/jql` + `expand=changelog` |
| Issues do board | `GET /rest/agile/1.0/board/{id}/issue` |
| Metadados sprint | `GET /rest/agile/1.0/sprint/{sprintId}` |

Autenticação: **HTTP Basic** com `JIRA_USER` (e-mail) e `JIRA_TOKEN` (API token).

### 8.2 MongoDB

- Driver oficial Node.js; conexão por `MONGO_URI`.

---

## 9. Requisitos não funcionais

- **Node.js** ≥ 18.
- **Dependências:** axios, chalk, dayjs, dotenv, mongodb.
- Execução **offline** após extração: não aplicável ao Jira (rede obrigatória).
- **Limites de segurança:** paginação capped (ex.: máx. ~2000 issues por combinação de query na implementação atual); timeouts elevados em algumas chamadas (60s search, 90s board).

---

## 10. Riscos e limitações conhecidas

1. **Custom fields:** IDs de story points e sprint (`customfield_10007`, `10020`) podem diferir por instância Jira — a app tenta vários campos mas não é garantia universal.
2. **Privacidade de e-mail no Jira:** assignees sem e-mail na API não entram no sync por board; extração por e-mail pode falhar sem `jiraAccountId` ou permissões (`Browse users and groups`).
3. **Nomes de status:** listas PT/EN hardcoded — status muito customizados podem degradar precisão de cycle time e classificações.
4. **Duplicatas / paginação:** existe lógica de mitigação; volumes extremos podem ainda exigir JQL mais estreito ou anos separados.
5. **Timezone:** filtro de período por resolução usa comparação de datas **sem** componente horário explícito na string `resolved`.

---

## 11. Glossário

| Termo | Significado neste produto |
|-------|---------------------------|
| Cycle time | Do “início ativo” ao “done” (changelog + fallbacks). |
| Lifetime (time in status) | Soma de dias em cada status ao longo da vida da issue. |
| Windowed (time in status) | Soma apenas sobre a janela [start, end] alinhada ao CT do export. |
| DORA/Flow | Uso analítico; o código não implementa fórmulas DORA completas, mas alimenta métricas de lead time, fluxo e estabilidade. |

---

## 12. Referências no repositório

- `README.md` — instruções de uso e variáveis de ambiente.
- `env.example` — lista comentada de variáveis.
- `extract.mjs` — orquestração e export.
- `lib/jiraService.js` — JQL, changelog, métricas.

---

*Fim do PRD-00.*
