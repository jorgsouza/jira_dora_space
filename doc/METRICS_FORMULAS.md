# 🧪 Fórmulas e Lógica de Cálculo das Métricas de Elite

Este documento contém as fórmulas exatas (pseudo-código e lógica MongoDB) para calcular os indicadores mencionados nos guias de análise, utilizando os campos reais da coleção `issues_dora_flow`.

---

## 1. Métricas de Previsibilidade (Vacanti & DORA)

Estas métricas devem ser calculadas sobre o campo `ctDays` (Cycle Time).

### 1.1 Percentis de Entrega (P50, P75, P85, P95)
*   **Lógica:** Ordenar todas as tarefas concluídas pelo `ctDays` e encontrar o valor que representa X% da amostra.
*   **Fórmula MongoDB:**
```javascript
{ $percentile: { input: "$ctDays", p: [0.5, 0.75, 0.85, 0.95], method: "approximate" } }
```
*   **Uso:** 
    *   **P50 (Mediana):** Tempo típico de entrega.
    *   **P75:** Seu **compromisso de entrega seguro (SLA)**.
    *   **P95:** O peso da cauda longa (risco extremo de tarefas "Zumbis").

### 1.2 Estabilidade do Fluxo (Variabilidade)
*   **Fórmula:** `Variabilidade = (P95 - P50) / P50`
*   **Interpretação:** Se o resultado for > 1.5, seu processo é altamente instável e as previsões são pouco confiáveis.

---

## 2. Eficiência de Fluxo (Goldratt - TOC)

Mede quanto do tempo total foi realmente gasto gerando valor técnico.

### 2.1 Flow Efficiency Agregada (%)
*   **Guardrails:** Considerar apenas registros com `ctDays > 0` e `touchTimeDays >= 0`.
*   **Fórmula Macro (Squad/Tribo):** `sum(touchTimeDays) / sum(ctDays) * 100`
*   **Nota:** Nunca utilize a média simples da coluna `flowEfficiency` para visões macro, pois ela é distorcida por outliers.

---

## 3. Qualidade e Saúde Técnica (Fowler & DORA)

### 3.1 Taxa de Falha de Mudança (Change Failure Rate)
*   **Fórmula:** `(count(wasReopened: true) / count(total_issues)) * 100`
*   **Limiar de Alerta:** Acima de **5%** indica instabilidade no "Done" ou validação tardia.

### 3.2 Latência de Engenharia (Review Latency)
*   **Fórmula:** `Média de Review = avg(reviewLatencyDays)`
*   **Gargalo de Feedback:** `Review Impact = sum(reviewLatencyDays) / sum(ctDays) * 100`

---

## 4. Dinâmica Social e Comunicação (Brooks & Jocko)

### 4.1 Índice de Ruído de Comunicação
*   **Campo Base:** `communicationComplexity` (calculado como `assigneeCount * handoffCount`).
*   **Fórmula:** `Média por Squad = avg(communicationComplexity)`
*   **Diferença:** Não confunda com `handoffCount`. O `communicationComplexity` considera o peso das pessoas envolvidas.

### 4.2 Diluição de Responsabilidade (Too Many Cooks)
*   **Fórmula:** `% de Tarefas Inchadas = (count(tooManyCooks: true) / count(total_issues)) * 100`

---

## 5. Alinhamento e Planejamento (Doerr - OKRs)

### 5.1 Sprint Slippage (Carry-over)
*   **Fórmula:** `Média de Sprints por Issue = avg(sprintCount)`
*   **Alerta:** Se a média for > 1.5, o time está falhando sistematicamente no planejamento da sprint.

### 5.2 Índice de Indisciplina (Scope Creep)
*   **Fórmula:** `% Scope Creep = (count(isScopeCreep: true) / count(total_issues)) * 100`
*   **Limiar Crítico:** Acima de **20%** o foco nos OKRs está seriamente comprometido.

---

## 6. Saúde do Fatiamento (Vacanti - Slicing)

### 6.1 Predictability Index (SP vs. Time)
*   **Guardrails:** **FILTRAR SEMPRE** `sp > 0` e `ctDays > 0`.
*   **Fórmula Recomendada:** Agrupar por `sp` e calcular a **Mediana** de `ctDays`.
*   **Predictability Index Macro:** `avg(sp / ctDays)` (Apenas com registros filtrados).
