# Guia de Dashboard: Performance do Time

> **Para usar no AI Studio:** cole este documento inteiro em um prompt e peça para criar o dashboard.
> O AI Studio deve usar a coleção MongoDB `issues_dora_flow` como fonte de dados e seguir exatamente as regras de cálculo descritas abaixo.

---

## Contexto e Fonte de Dados

**Banco**: MongoDB  
**Coleção**: `issues_dora_flow`  
**Extrator**: `jiraToMongo/extract.mjs`

---

## Filtros Globais do Dashboard

O dashboard deve expor os seguintes controles de filtro no topo:

| Filtro | Campo MongoDB | Valores |
|---|---|---|
| Período pré-definido | `resolvedAt` | Últimos 30d / 90d / 180d / Último ano |
| Período por Sprint/Quarter | `lastSprintName` ou `sprintNames` | Q1 2026, Q2 2026... |
| Modo de visualização | — | Geral (squad inteiro) / Por Membro (`assignee`) |
| S/ planejamento | `isScopeCreep` | Exibe somente issues que entraram fora do planejamento |

**Regra de período**: todas as queries filtram por `resolvedAt >= dataInicio AND resolvedAt <= dataFim`.  
Para issues **abertas** (WIP, Backlog), o filtro usa `createdAt` em vez de `resolvedAt`.

---

## Seção 1 — KPIs do Header (4 cards)

### 1.1 Cards Testados

```
Definição: total de issues do tipo Hipótese ou Experimento no período.
Campo: issueType IN ['Hipótese', 'Experimento']
Subtexto: "X concluídos" = COUNT onde statusFinal IN status_concluidos
```

**Query MongoDB:**
```js
db.issues_dora_flow.aggregate([
  { $match: {
      issueType: { $in: ['Hipótese', 'Experimento'] },
      resolvedAt: { $gte: dataInicio, $lte: dataFim }
  }},
  { $group: {
      _id: null,
      total: { $sum: 1 },
      concluidos: { $sum: { $cond: [
        { $in: ['$statusFinal', STATUS_CONCLUIDOS] }, 1, 0
      ]}}
  }}
])
```

### 1.2 Taxa de Validação

```
Definição: % de cards Hipótese/Experimento concluídos com statusFinal = "Card Validado - Aprovado"
Fórmula: (COUNT statusFinal = 'Card Validado - Aprovado') / (COUNT concluídos) * 100
Subtexto: "dos concluídos"
```

**Query MongoDB:**
```js
db.issues_dora_flow.aggregate([
  { $match: {
      issueType: { $in: ['Hipótese', 'Experimento'] },
      statusFinal: { $in: STATUS_CONCLUIDOS },
      resolvedAt: { $gte: dataInicio, $lte: dataFim }
  }},
  { $group: {
      _id: null,
      total_concluidos: { $sum: 1 },
      validados: { $sum: { $cond: [
        { $eq: ['$statusFinal', 'Card Validado - Aprovado'] }, 1, 0
      ]}}
  }},
  { $project: {
      taxa: { $multiply: [
        { $divide: ['$validados', '$total_concluidos'] }, 100
      ]}
  }}
])
```

### 1.3 Ciclo Médio

```
Definição: MEDIANA de ctDays de todas as issues concluídas no período.
Campo: ctDays (number, em dias)
Subtexto: "início → conclusão"
IMPORTANTE: Usar mediana (P50), NÃO média aritmética.
```

**Query MongoDB:**
```js
db.issues_dora_flow.aggregate([
  { $match: {
      ctDays: { $gt: 0 },
      resolvedAt: { $gte: dataInicio, $lte: dataFim }
  }},
  { $sort: { ctDays: 1 } },
  { $group: { _id: null, values: { $push: '$ctDays' } } },
  { $project: {
      mediana: { $arrayElemAt: [
        '$values',
        { $floor: { $divide: [{ $size: '$values' }, 2] } }
      ]}
  }}
])
```

### 1.4 Throughput

```
Definição: número de issues concluídas por semana no período.
Fórmula: COUNT(resolved no período) / número_de_semanas_do_período
Subtexto: "cards/semana"
```

**Cálculo:**
```js
const totalConcluidos = await db.issues_dora_flow.countDocuments({
  resolvedAt: { $gte: dataInicio, $lte: dataFim },
  statusFinal: { $in: STATUS_CONCLUIDOS }
});
const semanas = (dataFim - dataInicio) / (7 * 24 * 60 * 60 * 1000);
const throughput = (totalConcluidos / semanas).toFixed(1);
```

---

## Seção 2 — Distribuição de Lanes

### Layout

Duas barras horizontais com marcadores de target:
- **Lane de Inovação** (azul) — campo `lane = 'inovacao'` — target padrão: **70%**
- **Lane Mágica / Sustentação** (laranja) — campo `lane = 'magica'` — target padrão: **30%**

### Indicador "Fora do target"

```
Se lane_inovacao_pct < TARGET_INOVACAO OU lane_magica_pct > TARGET_MAGICA:
  mostrar badge vermelho "Fora do target"
Caso contrário:
  mostrar badge verde "Dentro do target"
```

### Query MongoDB

```js
db.issues_dora_flow.aggregate([
  { $match: { resolvedAt: { $gte: dataInicio, $lte: dataFim } } },
  { $group: {
      _id: '$lane',
      count: { $sum: 1 }
  }}
])
// Resultado: [{ _id: 'inovacao', count: 43 }, { _id: 'magica', count: 29 }]
// % = count / total * 100
```

---

## Seção 3 — Cards por Tipo (Breakdown por IssueType)

Um card para cada `issueType` relevante (Hipótese, Experimento, Sub-tarefa, Sustentação, etc.).

### Campos de cada card

| Campo | Cálculo |
|---|---|
| Total de cards | `COUNT` por `issueType` |
| Concluídos | `COUNT` onde `statusFinal IN STATUS_CONCLUIDOS` |
| % concluídos | `(concluidos / total) * 100` |
| Ciclo médio | `MEDIAN(ctDays)` onde `ctDays > 0` |
| Progresso (barra) | `concluidos / total` |

### Query MongoDB

```js
db.issues_dora_flow.aggregate([
  { $match: { resolvedAt: { $gte: dataInicio, $lte: dataFim } } },
  { $group: {
      _id: '$issueType',
      total: { $sum: 1 },
      ctValues: { $push: { $cond: [{ $gt: ['$ctDays', 0] }, '$ctDays', '$$REMOVE'] } },
      concluidos: { $sum: { $cond: [{ $in: ['$statusFinal', STATUS_CONCLUIDOS] }, 1, 0] }}
  }},
  { $project: {
      total: 1,
      concluidos: 1,
      pct_concluidos: { $multiply: [{ $divide: ['$concluidos', '$total'] }, 100] },
      ciclo_medio: { $avg: '$ctValues' } // usar percentile no front se possível
  }}
])
```

---

## Seção 4 — Tickets Vinculados do Jira

Painel de métricas agregadas de TODOS os tickets do board no período.

### KPIs de Contagem

| KPI | Campo | Cálculo |
|---|---|---|
| **Total** | — | `COUNT` todas issues no período |
| **Concluídos** | `statusFinal` | `COUNT` onde `statusFinal IN STATUS_CONCLUIDOS` |
| **WIP** | `status` | `COUNT` onde `status IN STATUS_WIP` |
| **Backlog** | `status` | `COUNT` onde `status IN STATUS_BACKLOG` |
| **Vinculados VT** | `parentKey` | `COUNT` onde `parentKey != null` |

### KPIs de Tempo

| KPI | Cálculo |
|---|---|
| **Ciclo Médio** | `AVG(ctDays)` onde `ctDays > 0` (ou MEDIAN — preferir mediana) |
| **Mediana** | `PERCENTILE_50(ctDays)` |
| **P85 Ciclo** | `PERCENTILE_85(ctDays)` — indicador de outliers |
| **Idade Média (Abertos)** | `AVG(today - createdAt)` onde `status NOT IN STATUS_CONCLUIDOS` (em dias) |

### KPIs de Fluxo

| KPI | Fórmula |
|---|---|
| **Throughput/semana** | `COUNT(concluidos) / semanas_periodo` |
| **Taxa de Conclusão** | `COUNT(concluidos) / COUNT(total) * 100` |
| **WIP/Throughput (semanas)** | `COUNT(WIP) / throughput_por_semana` — indica quantas semanas para zerar fila |

### Query Completa

```js
db.issues_dora_flow.aggregate([
  { $match: { createdAt: { $gte: dataInicio, $lte: dataFim } } },
  { $group: {
      _id: null,
      total: { $sum: 1 },
      concluidos: { $sum: { $cond: [{ $in: ['$statusFinal', STATUS_CONCLUIDOS] }, 1, 0] }},
      wip: { $sum: { $cond: [{ $in: ['$status', STATUS_WIP] }, 1, 0] }},
      backlog: { $sum: { $cond: [{ $in: ['$status', STATUS_BACKLOG] }, 1, 0] }},
      vinculados_vt: { $sum: { $cond: [{ $ne: ['$parentKey', null] }, 1, 0] }},
      ct_values: { $push: { $cond: [{ $gt: ['$ctDays', 0] }, '$ctDays', '$$REMOVE'] }},
      ages_abertos: {
        $push: {
          $cond: [
            { $not: [{ $in: ['$status', STATUS_CONCLUIDOS] }] },
            { $divide: [{ $subtract: [new Date(), { $dateFromString: { dateString: '$createdAt' } }] }, 86400000] },
            '$$REMOVE'
          ]
        }
      }
  }}
])
// P50 e P85 calculados no front a partir de ct_values ordenado
```

---

## Seção 5 — Breakdown Detalhado por Tipo

Um card expandido por `issueType` com todos os indicadores.

### Estrutura de cada card

```
[issueType]                             [total]
[barra de progresso: verde=concluído, amarelo=WIP, cinza=backlog]

● Concluídos       [N] ([X]%)
● Em andamento     [N] ([X]%)
  A fazer          [N]

⏱ Ciclo médio     [Xd]
⏱ Mediana         [Xd]
   P85             [Xd]
   Min / Max       [Xd] — [Xd]
⚠ Idade média     [Xd]   ← laranja se > threshold
⇔ Vinculados à VT [N] ([X]%)
```

### Cores de Alerta para Idade Média

```
< 7d  → cinza (normal)
7–14d → amarelo (atenção)
> 14d → laranja/vermelho (crítico)
```

### Query MongoDB

```js
db.issues_dora_flow.aggregate([
  { $match: { createdAt: { $gte: dataInicio, $lte: dataFim } } },
  { $group: {
      _id: '$issueType',
      total: { $sum: 1 },
      concluidos: { $sum: { $cond: [{ $in: ['$statusFinal', STATUS_CONCLUIDOS] }, 1, 0] }},
      em_andamento: { $sum: { $cond: [{ $in: ['$status', STATUS_WIP] }, 1, 0] }},
      ct_values: { $push: { $cond: [{ $gt: ['$ctDays', 0] }, '$ctDays', '$$REMOVE'] }},
      vinculados_vt: { $sum: { $cond: [{ $ne: ['$parentKey', null] }, 1, 0] }},
      age_values: {
        $push: {
          $cond: [
            { $not: [{ $in: ['$status', STATUS_CONCLUIDOS] }] },
            { $divide: [{ $subtract: [new Date(), { $dateFromString: { dateString: '$createdAt' } }] }, 86400000] },
            '$$REMOVE'
          ]
        }
      }
  }},
  { $project: {
      total: 1, concluidos: 1, em_andamento: 1,
      a_fazer: { $subtract: ['$total', { $add: ['$concluidos', '$em_andamento'] }] },
      ct_values: 1, vinculados_vt: 1, age_values: 1,
      ciclo_medio: { $avg: '$ct_values' },
      idade_media_abertos: { $avg: '$age_values' }
  }}
])
// P50, P85, Min, Max: calcular no front ordenando ct_values
```

---

## Seção 6 — Cadeia de Entrega (VT → Tickets)

Seção que mostra hierarquia: cada issue pai (VT) agrupada com seus tickets filhos.

### Estrutura visual de cada VT

```
[issueType badge] [key]   [statusFinal badge]
[título da issue VT]

[N tickets]  [X/N concluídos]  [Xd ciclo médio]  [Xd idade média]  [Xd span parcial]

[barra de progresso] [X%]

⏱ chave1 Xd  ⏱ chave2 Xd  ⏱ chave3 Xd old  ⏱ chave4 Xd old ...
```

### Regras

- **Span Parcial**: `hoje - MIN(createdAt dos filhos)` em dias
- **Ciclo médio da cadeia**: `AVG(ctDays)` dos filhos concluídos
- **Idade média**: `AVG(hoje - createdAt)` dos filhos abertos
- **"X old"**: filhos abertos com idade > 14d recebem o label `Xd old` em laranja/vermelho

### Query MongoDB

```js
// Passo 1: buscar todos os VT (issues que são pai de outras)
const parentKeys = await db.issues_dora_flow.distinct('parentKey', {
  parentKey: { $ne: null },
  createdAt: { $gte: dataInicio, $lte: dataFim }
});

// Passo 2: buscar os dados de cada VT e seus filhos
db.issues_dora_flow.aggregate([
  { $match: { key: { $in: parentKeys } } },
  { $lookup: {
      from: 'issues_dora_flow',
      localField: 'key',
      foreignField: 'parentKey',
      as: 'filhos'
  }},
  { $project: {
      key: 1, title: 1, issueType: 1, statusFinal: 1,
      total_filhos: { $size: '$filhos' },
      concluidos: { $size: { $filter: {
        input: '$filhos',
        cond: { $in: ['$$this.statusFinal', STATUS_CONCLUIDOS] }
      }}},
      ciclo_medio: { $avg: '$filhos.ctDays' },
      span_dias: { $divide: [
        { $subtract: [new Date(), { $min: '$filhos.createdAt' }] },
        86400000
      ]},
      filhos_detalhes: {
        $map: {
          input: '$filhos',
          in: {
            key: '$$this.key',
            age: { $divide: [
              { $subtract: [new Date(), { $dateFromString: { dateString: '$$this.createdAt' } }] },
              86400000
            ]},
            status: '$$this.status'
          }
        }
      }
  }}
])
```

### Filtros de Conexão (chips)

Os chips no topo filtram por tipo de link:

| Chip | Campo `linkedIssues[].linkType` | Descrição |
|---|---|---|
| Direto | — | Issues com `parentKey` direto |
| Hierarquia (pai → filho) | `Hierarchy` | Via campo `parent` do Jira |
| Sub-tarefa | `Sub-task` | `issueType = 'Sub-tarefa'` com `parentKey` |
| Cloners N | `Cloners` | `linkedIssues[].linkType = 'Cloners'` |

---

## Seção 7 — Fluxo de Transições

Diagrama em linha horizontal mostrando o tempo médio em cada status do workflow.

### Ordem dos status no fluxo principal

```
Backlog → To Do → In Progress → Done Dev → Em Validação QA → Em Medição / Em Validação → Done
```

### Campos para cada status

| Campo | Fonte MongoDB |
|---|---|
| Tempo médio no status | `AVG(timeInStatus_lifetime_{NomeDoStatus})` |
| Número de cards que passaram | `COUNT` onde `timeInStatus_lifetime_{NomeDoStatus} > 0` |
| Número de transições (seta) | `SUM(statusTransitions[].count)` onde `to = próximoStatus` |

### Regras de cor dos boxes

```
Verde  : tempo médio <= 2d
Amarelo: tempo médio > 2d e <= 7d
Vermelho/Laranja: tempo médio > 7d
```

### Query MongoDB

```js
db.issues_dora_flow.aggregate([
  { $match: { resolvedAt: { $gte: dataInicio, $lte: dataFim } } },
  { $group: {
      _id: null,
      avg_backlog:       { $avg: '$timeInStatus_lifetime_Backlog' },
      count_backlog:     { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_Backlog', 0] }, 1, 0] }},
      avg_todo:          { $avg: '$timeInStatus_lifetime_To Do' },
      count_todo:        { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_To Do', 0] }, 1, 0] }},
      avg_inprogress:    { $avg: '$timeInStatus_lifetime_In Progress' },
      count_inprogress:  { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_In Progress', 0] }, 1, 0] }},
      avg_donedev:       { $avg: '$timeInStatus_lifetime_Done Dev' },
      count_donedev:     { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_Done Dev', 0] }, 1, 0] }},
      avg_qa:            { $avg: '$timeInStatus_lifetime_Em Validação QA' },
      count_qa:          { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_Em Validação QA', 0] }, 1, 0] }},
      avg_medicao:       { $avg: '$timeInStatus_lifetime_Em Medição / Em Validação' },
      count_medicao:     { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_Em Medição / Em Validação', 0] }, 1, 0] }},
      avg_done:          { $avg: '$timeInStatus_lifetime_Done' },
      count_done:        { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_Done', 0] }, 1, 0] }}
  }}
])
```

### Contagem de transições entre status (setas)

```js
db.issues_dora_flow.aggregate([
  { $match: { resolvedAt: { $gte: dataInicio, $lte: dataFim } } },
  { $unwind: '$statusTransitions' },
  { $group: {
      _id: { from: '$statusTransitions.from', to: '$statusTransitions.to' },
      total: { $sum: '$statusTransitions.count' }
  }},
  { $sort: { total: -1 } }
])
```

---

## Seção 8 — Desfechos Finais

Boxes para cada status terminal de validação:

| Box | Condição | Ícone |
|---|---|---|
| Card Validado - Aprovado | `statusFinal = 'Card Validado - Aprovado'` | ✓ (verde) |
| Card Não Validado - Recusado | `statusFinal = 'Card Não Validado - Recusado'` | ✗ (vermelho) |
| Card Semi-Validado - Pivotado | `statusFinal = 'Card Semi-Validado - Pivotado'` | ↺ (amarelo) |

### Campos de cada box

```
[Xd]  ← AVG(timeInStatus_lifetime_{statusNome}) para issues que chegaram ali
[nome do status]
[N cards]
```

### Query MongoDB

```js
db.issues_dora_flow.aggregate([
  { $match: {
      statusFinal: { $in: [
        'Card Validado - Aprovado',
        'Card Não Validado - Recusado',
        'Card Semi-Validado - Pivotado'
      ]},
      resolvedAt: { $gte: dataInicio, $lte: dataFim }
  }},
  { $group: {
      _id: '$statusFinal',
      count: { $sum: 1 },
      avg_tempo: { $avg: {
        $switch: {
          branches: [
            { case: { $eq: ['$statusFinal', 'Card Validado - Aprovado'] },
              then: '$timeInStatus_lifetime_Card Validado - Aprovado' },
            { case: { $eq: ['$statusFinal', 'Card Não Validado - Recusado'] },
              then: '$timeInStatus_lifetime_Card Não Validado - Recusado' },
            { case: { $eq: ['$statusFinal', 'Card Semi-Validado - Pivotado'] },
              then: '$timeInStatus_lifetime_Card Semi-Validado - Pivotado' }
          ],
          default: 0
        }
      }}
  }}
])
```

---

## Seção 9 — Outros Status

Status que existem fora do fluxo principal (Rascunho, Planejado, etc.):

```js
db.issues_dora_flow.aggregate([
  { $match: { resolvedAt: { $gte: dataInicio, $lte: dataFim } } },
  { $group: {
      _id: null,
      avg_rascunho:  { $avg: '$timeInStatus_lifetime_Rascunho' },
      count_rascunho: { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_Rascunho', 0] }, 1, 0] }},
      avg_planejado:  { $avg: '$timeInStatus_lifetime_Planejado' },
      count_planejado: { $sum: { $cond: [{ $gt: ['$timeInStatus_lifetime_Planejado', 0] }, 1, 0] }}
  }}
])
```

---

## Seção 10 — Transições Fora do Fluxo

Chips que mostram movimentos inesperados/regressivos no workflow (ex: "Done → Backlog").

### Regra de identificação

Comparar o par `(from, to)` contra a ordem esperada do workflow. Se `from` está **depois** de `to` na ordem, é uma transição fora do fluxo (regressiva).

**Ordem do fluxo principal:**
```
Planejado → Rascunho → Backlog → To Do → In Progress → Done Dev → Em Validação QA → Em Medição / Em Validação → Done
```

### Query MongoDB

```js
db.issues_dora_flow.aggregate([
  { $match: { resolvedAt: { $gte: dataInicio, $lte: dataFim } } },
  { $unwind: '$statusTransitions' },
  { $group: {
      _id: {
        from: '$statusTransitions.from',
        to: '$statusTransitions.to'
      },
      total: { $sum: '$statusTransitions.count' }
  }},
  { $sort: { total: -1 } }
])
// Filtrar no front: manter apenas os pares onde índice(from) > índice(to) no array de ordem
// Exibir como chips: "From → To [N]x"
```

---

## Constantes de Status

Configure estas constantes de acordo com os status reais do seu projeto Jira:

```js
const STATUS_CONCLUIDOS = [
  'Done',
  'Card Validado - Aprovado',
  'Card Não Validado - Recusado',
  'Card Semi-Validado - Pivotado'
];

const STATUS_WIP = [
  'In Progress',
  'Done Dev',
  'Em Validação QA',
  'Em Medição / Em Validação',
  'To Do'
];

const STATUS_BACKLOG = [
  'Backlog',
  'Planejado',
  'Rascunho'
];

// Ordem para detectar transições regressivas
const WORKFLOW_ORDER = [
  'Rascunho',
  'Planejado',
  'Backlog',
  'To Do',
  'In Progress',
  'Done Dev',
  'Em Validação QA',
  'Em Medição / Em Validação',
  'Card Validado - Aprovado',
  'Card Não Validado - Recusado',
  'Card Semi-Validado - Pivotado',
  'Done'
];

// Targets de distribuição de lanes
const TARGET_LANE_INOVACAO = 70; // %
const TARGET_LANE_MAGICA = 30;   // %

// Thresholds de alerta de tempo (dias)
const ALERT_CICLO_AMARELO = 7;
const ALERT_CICLO_VERMELHO = 14;
const ALERT_IDADE_MEDIA_VERMELHO = 14;
```

---

## Cálculo de Percentis (P50, P85, P95)

O MongoDB não tem `$percentile` nativo em todas as versões. Calcular no backend/front:

```js
function calcPercentil(valores, p) {
  if (!valores || valores.length === 0) return 0;
  const sorted = [...valores].filter(v => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return parseFloat(sorted[Math.max(0, idx)].toFixed(1));
}

// Uso:
const mediana = calcPercentil(ctValues, 50);  // P50
const p85     = calcPercentil(ctValues, 85);  // P85
const p95     = calcPercentil(ctValues, 95);  // P95
```

---

## Prompt Template para AI Studio

Cole o texto abaixo no AI Studio para solicitar a criação do dashboard:

---

```
Crie um dashboard web chamado "Performance do Time" usando os dados da coleção MongoDB 
`issues_dora_flow`. Siga exatamente as especificações do arquivo DASHBOARD_GUIDE.md.

## Requisitos Técnicos

- Stack: React + TypeScript (ou Next.js)
- Banco: MongoDB (use as queries exatas do guia)
- Gráficos: Recharts ou Chart.js
- UI: Tailwind CSS

## Estrutura do Dashboard

### Header
- Título: "Performance do Time"
- Subtítulo com período selecionado
- Filtros: dropdown de período (Últimos 30d / 90d / 180d / Último ano / por Sprint)
- Toggle: "Geral" / "Por Membro"

### Seção 1: 4 KPI Cards em linha
1. Cards Testados (issueType Hipótese/Experimento) com subtexto "X concluídos"
2. Taxa de Validação (%) com subtexto "dos concluídos"
3. Ciclo Médio (mediana de ctDays) com subtexto "início → conclusão"
4. Throughput (cards/semana)

### Seção 2: Distribuição de Lanes
- Barra horizontal azul: lane = 'inovacao', target 70%, label "Lane de Inovação"
- Barra horizontal laranja: lane = 'magica', target 30%, label "Lane Mágica"
- Badge "Fora do target" (vermelho) ou "Dentro do target" (verde) no canto superior direito
- Marcadores de target nas barras

### Seção 3: Cards por IssueType (grid 4 colunas)
Um card por issueType com: total, concluídos (%), barra de progresso, ciclo médio

### Seção 4: Tickets Vinculados do Jira
- Header: "Tickets vinculados do Jira", total de tickets
- Chips de filtro por issueType (Subtarefa, Experimento, Epic, Tarefa, Bug, História, Sub-Bug)
- Chips de tipo de conexão (Direto, Hierarquia pai→filho, Sub-tarefa, Cloners N)
- Grid de 5 KPIs: Total, Concluídos, WIP, Backlog, Vinculados VT
- Grid de 4 tempos: Ciclo Médio, Mediana, P85, Idade Média (Abertos)
- Grid de 3 fluxos: Throughput/semana, Taxa de Conclusão, WIP/Throughput
- Breakdown por issueType (cards detalhados como na Seção 5 do guia)

### Seção 5: Cadeia de Entrega
- Uma entrada por issue pai (VT)
- Badge issueType + badge statusFinal
- Título da issue
- Métricas: tickets, concluídos, ciclo médio, idade média, span parcial
- Barra de progresso com %
- Lista de filhos com idade (destacar "Xd old" em vermelho se > 14d)

### Seção 6: Fluxo de Transições
- Diagrama horizontal de boxes conectados por setas
- Box de cada status: tempo médio (cor: verde<=2d, amarelo 2-7d, vermelho>7d), nome, N cards
- Setas com contagem de transições
- Seção "Desfechos Finais": 3 boxes para Card Validado/Não Validado/Semi-Validado
- Seção "Outros Status": Rascunho e Planejado
- Seção "Transições Fora do Fluxo": chips "From → To Nx" para movimentos regressivos

## Regras de Cálculo (OBRIGATÓRIO seguir)

Usar as queries MongoDB e fórmulas exatas do arquivo DASHBOARD_GUIDE.md.

Constantes de status:
- Concluídos: Done, Card Validado - Aprovado, Card Não Validado - Recusado, Card Semi-Validado - Pivotado
- WIP: In Progress, Done Dev, Em Validação QA, Em Medição / Em Validação, To Do
- Backlog: Backlog, Planejado, Rascunho
- Targets: Inovação 70%, Mágica 30%
- Usar MEDIANA (não média) para Ciclo Médio principal
- Usar P85 como indicador de outliers
- Calcular Throughput como cards_concluidos / semanas_do_periodo
- WIP/Throughput = COUNT(WIP) / throughput_semanal
- Transições regressivas: pares (from, to) onde from vem depois de to na WORKFLOW_ORDER

## Campos MongoDB disponíveis
key, title, issueType, lane, parentKey, parentType, status, statusFinal, statusInitial,
ctDays, leadTimeDays, resolvedAt, createdAt, squad, tribe, assignee,
timeInStatus_lifetime_*, timeInStatus_windowed_*,
linkedIssues (array: [{key, summary, linkType, direction}]),
statusTransitions (array: [{from, to, count, timestamps}]),
clonesCount, clonedByCount, hasDependencies,
sprintNames, lastSprintName, epic, labels, workType, sp
```

---

## Índices MongoDB Recomendados

Para performance das queries, criar os seguintes índices:

```js
db.issues_dora_flow.createIndex({ resolvedAt: 1 });
db.issues_dora_flow.createIndex({ createdAt: 1 });
db.issues_dora_flow.createIndex({ issueType: 1, resolvedAt: 1 });
db.issues_dora_flow.createIndex({ lane: 1, resolvedAt: 1 });
db.issues_dora_flow.createIndex({ parentKey: 1 });
db.issues_dora_flow.createIndex({ statusFinal: 1, resolvedAt: 1 });
db.issues_dora_flow.createIndex({ squad: 1, resolvedAt: 1 });
db.issues_dora_flow.createIndex({ assignee: 1, resolvedAt: 1 });
db.issues_dora_flow.createIndex({ status: 1 });
```
