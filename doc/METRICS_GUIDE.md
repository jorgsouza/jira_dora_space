# 🚀 Guia de Métricas de Elite para Gestão de Engenharia (Cientificamente Embasado)

Este guia detalha as métricas avançadas extraídas pelo `jiraToMongo` e as fundamentações teóricas que as sustentam, permitindo uma gestão baseada em evidências e previsibilidade.

---

## 1. Saúde do Planejamento (Planning Health)

### 1.1 `sprintCount` (Carry-over / Sprint Slippage)
- **Referência:** **Nicole Forsgren (DORA / Livro *Accelerate*)**.
- **O que é:** O número de sprints que uma issue visitou até ser concluída.
- **A Ciência:** Issues que pulam de sprint indicam falha no "Batch Size" (tamanho do lote). Segundo o DORA, times de elite trabalham com lotes pequenos que cabem em um ciclo.
- **Limiar de Alerta:** Se a média for > 1.5, o time está sofrendo do **Efeito Neve**, onde a sprint atual é consumida por dívidas da anterior.

### 1.2 `isScopeCreep` (Unplanned Work)
- **Referência:** **John Doerr (OKRs / *Measure What Matters*)**.
- **O que é:** Identifica se a tarefa foi adicionada à Sprint após o início.
- **A Ciência:** Trabalho não planejado compete diretamente com os OKRs.
- **Limiar de Saúde:** Abaixo de **20%**. Se ultrapassar este valor, o "Compromisso de Planejamento" torna-se estatisticamente irrelevante.

---

## 2. Eficiência de Engenharia (Engineering Flow)

### 2.1 `reviewLatencyDays` (Feedback Loop Latency)
- **Referência:** **Martin Fowler (Continuous Integration / *Refactoring*)**.
- **O que é:** Tempo que a tarefa passou em status de revisão de código.
- **A Ciência:** Fowler defende que o feedback deve ser o mais rápido possível. 
- **Indicador de Elite:** Mediana próxima de **0**. Se o P75 subir acima de 1 dia, o QA receberá um volume acumulado no fim do ciclo, gerando o "Tsunami de Fim de Sprint".

### 2.2 `predictabilityIndex` (Slicing Health)
- **Referência:** **Daniel Vacanti (Actionable Agile Metrics)**.
- **O que é:** A relação entre Story Points e Cycle Time (`sp / ctDays`).
- **A Ciência:** Vacanti prova que a variabilidade é o maior inimigo da previsibilidade. Se tarefas com a mesma pontuação levam tempos drasticamente diferentes, o fatiamento (slicing) é ineficaz.
- **Ação:** Monitorar a variabilidade `(P95 - P50) / P50`. Se > 1.5, o processo está instável.

---

## 3. Dinâmica de Time & Carga Cognitiva

### 3.1 `tooManyCooks` & `communicationComplexity`
- **Referência:** **Fred Brooks (The Mythical Man-Month)** e **Jocko Willink (Extreme Ownership)**.
- **O que é:** Excesso de pessoas (`assigneeCount > 3`) e o ruído gerado por trocas de dono (`handoffCount`).
- **A Ciência:** A **Lei de Brooks** afirma que o esforço de comunicação cresce exponencialmente. Jocko defende a **Clareza de Propriedade**.
- **Antecipação:** Se `communicationComplexity` sobe, a qualidade cai. Você prevê bugs causados por "falhas de entendimento" entre os envolvidos.

---

## 4. Eficiência de Fluxo (Lean Manufacturing)

### 4.1 `flowEfficiency`
- **Referência:** **Eliyahu Goldratt (Theory of Constraints / *A Meta*)**.
- **O que é:** `(Touch Time / Cycle Time) * 100`.
- **A Ciência:** O Lean foca em eliminar o desperdício (*Muda*). Goldratt ensina que ganhar tempo fora do gargalo é uma ilusão.
- **Cálculo Macro:** Sempre usar a soma ponderada `sum(touchTimeDays) / sum(ctDays) * 100`.
- **Referência de Mercado:** ~ 47% é uma média saudável observada em times de alta colaboração.

---

### Como agir com esses dados no MongoDB?
Use estas métricas para criar **Alertas Precoces**:
1.  **Gargalo de Engenharia:** Review Latency P75 > 1 dia.
2.  **Risco de Roadmap:** Variabilidade do Cycle Time > 1.5.
3.  **Indisciplina Operacional:** Scope Creep > 20% em 2 sprints consecutivas.
