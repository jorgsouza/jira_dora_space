# 📈 Guia de Análise Estatística e Predição (Elite Data Cube)

Este documento descreve como extrair inteligência dos dados ingeridos no MongoDB, utilizando filtros e agregações pautadas em ciência de dados e engenharia de software (DORA, Vacanti, Brooks).

---

## 1. Dimensões Disponíveis (Filtros e Segmentação)

Cada registro no MongoDB possui metadados ricos que permitem segmentar a visão por:

*   **Identidade e Perfil:** 
    *   `assignee`: Nome do responsável.
    *   `function`: Cargo/Papel (ex: Desenvolvedor, QA, Designer, Líder).
    *   `seniority`: Nível (Senior, Pleno, Junior, Estagiário).
    *   `stack`: Categoria técnica (Back-end, Front-end, Mobile, DevOps).
*   **Estrutura Organizacional:** 
    *   `tribe`: Tribo/Unidade de negócio.
    *   `squad`: Time específico.
*   **Processo e Fluxo:** 
    *   `workType`: Classificação do trabalho (Bug, Feature, Support, Technical Debt).
    *   `issueType`: Tipo original no Jira (Task, Story, Bug).
    *   `priority`: Urgência (Highest, High, Medium, Low).
    *   `sprintNames`: Lista de sprints que a tarefa percorreu.
*   **Indicadores de Risco (Booleano):** 
    *   `isScopeCreep`: Entrou na sprint após o início?
    *   `tooManyCooks`: Mais de 3 pessoas tocaram na tarefa?
    *   `wasReopened`: Teve retrabalho após ser considerada "Done"?
    *   `hasDependencies`: Possui links de bloqueio ou relação?

---

## 2. DORA & Previsibilidade (Lead Time / Cycle Time)

Para uma gestão de elite, **ignore as médias**. Médias escondem os atrasos críticos. Utilize **Percentis** sobre o `ctDays` (Cycle Time):

| Métrica | O que ela te diz (A Ciência de Daniel Vacanti) |
| :--- | :--- |
| **Mediana (P50)** | O "tempo típico". 50% das tarefas levam menos que isso. |
| **P75 (75%)** | **Compromisso de Entrega Seguro.** Use para SLAs e prazos confiáveis. |
| **P85 (85%)** | **Limite de Alerta.** Bom para identificar o início da cauda de risco. |
| **P95 (95%)** | **Cenário de Risco Extremo.** Mostra o peso das tarefas "Zumbis". |

**💡 Antecipação:** Calcule a variabilidade `(P95 - P50) / P50`. Se o resultado for alto (ex: > 1.5), seu processo está instável e as datas prometidas são fictícias.

---

## 3. Agregações Estratégicas (Exemplos de Insights)

### A. Saúde do Fluxo (Goldratt - TOC)
*   **Fórmula Obrigatória:** `sum(touchTimeDays) / sum(ctDays) * 100`.
*   **Guardrails:** Considerar apenas registros com `ctDays > 0` e `touchTimeDays >= 0`.
*   **Insight:** Squads com eficiência agregada < 15% estão sofrendo de bloqueios externos, não falta de código.

### B. O Índice de Slicing (Vacanti)
*   **Guardrails:** Filtrar sempre `sp > 0` e `ctDays > 0`.
*   **Agregação:** Agrupar por `sp` (Story Points) e calcular a Mediana de `ctDays`.
*   **Insight:** Se tarefas de 1 SP e 5 SP levam o mesmo tempo, o fatiamento do time é ineficaz.

### C. Latência de Feedback (Fowler)
*   **Agregação:** Média e P75 de `reviewLatencyDays` por Squad ou Stack.
*   **Insight:** Identifica gargalos na revisão de código (ex: Backend demorando mais que Frontend).

### D. Carga Cognitiva e Ruído (Brooks & Jocko)
*   **Agregação:** Média de `handoffCount` e `communicationComplexity`.
*   **Importante:** `communicationComplexity` (`assigneeCount * handoffCount`) mede o ruído operacional real.

---

## 4. Exemplos de Consultas MongoDB (Aggregation Pipeline)

### Visão de Previsibilidade por Squad (Março/2026)
```javascript
db.issues_dora_flow.aggregate([
  { $match: { isDone: true, ano_mes: "2026-03" } },
  { $group: {
      _id: "$squad",
      medianaCT: { $percentile: { input: "$ctDays", p: [0.5], method: "approximate" } },
      p75CT: { $percentile: { input: "$ctDays", p: [0.75], method: "approximate" } },
      p85CT: { $percentile: { input: "$ctDays", p: [0.85], method: "approximate" } },
      p95CT: { $percentile: { input: "$ctDays", p: [0.95], method: "approximate" } },
      eficienciaMacro: { 
        $multiply: [
          { $divide: [ { $sum: "$touchTimeDays" }, { $sum: "$ctDays" } ] },
          100
        ]
      },
      taxaScopeCreep: { $avg: { $cond: ["$isScopeCreep", 1, 0] } }
  }},
  { $sort: { p85CT: 1 } }
])
```

---

## 5. Painéis e Gráficos Recomendados (BI Contract)

Para construir o dashboard no AI Studio ou Ferramentas de BI, siga estes modelos obrigatórios:

1.  **Distribuição de Cycle Time (Histograma/Boxplot):** Exibir `ctDays` com linhas verticais para P50, P75, P85 e P95.
2.  **Variabilidade por Squad:** Gráfico de barras comparando `P85 vs P50`. Squads com grande diferença são instáveis.
3.  **Saúde do Slicing:** Boxplot de `ctDays` agrupado por `sp`. Tasks maiores **devem** levar mais tempo; se a mediana for igual para 1SP e 8SP, o fatiamento faliu.
4.  **Mapa de Ruído Operacional:** Scatter plot com `X = handoffCount` e `Y = communicationComplexity`. Identifica times com "muito cacique para pouco índio".
5.  **Flow Efficiency por Squad:** Barras ordenadas usando a **Eficiência Agregada Ponderada** (Soma Touch / Soma CT).
6.  **Throughput Mensal:** Gráfico de linha ou barras empilhadas por `ano_mes` mostrando contagem de issues e soma de story points.

---

## 6. Resumo Executivo para Antecipação

*   **Variabilidade > 1.5?** O processo está em caos estatístico. Foque em estabilizar antes de prometer datas.
*   **Scope Creep > 20%?** A sprint é um "balde furado". O time está sendo interrompido demais.
*   **Flow Efficiency < 15%?** O time está pronto para trabalhar, mas o processo (bloqueios/burocracia) não deixa.
*   **Review Latency P75 > 1 dia?** Gargalo de feedback. Implemente revisões síncronas.
