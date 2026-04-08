# 📖 Guia Técnico de Campos e Filtros (Dicionário MongoDB)

Este documento descreve a origem, o cálculo e o potencial de filtro para cada campo presente na coleção `issues_dora_flow`, alinhado à visão estratégica do AI Studio.

---

## 1. Identificação e Metadados Organizacionais

Estes campos são usados principalmente como **Filtros de Segmentação** (Slicing).

| Campo | Origem / Regra de Cálculo | Como Filtrar / Agrupar |
| :--- | :--- | :--- |
| `key` | Chave única da issue no Jira (ex: AW-293). | Busca exata por tarefa. |
| `assignee` | Nome completo do último responsável no Jira. | Filtro por pessoa para análise de carga individual. |
| `squad` | Mapeado via `developers.json` por predominância de board. | **Filtro Principal:** Comparar performance entre times. |
| `tribe` | Unidade de negócio (B2C, GB2B, etc.). | Agrupamento estratégico de alto nível. |
| `function` | Cargo/Função (ex: Dados, QA, Dev). | Analisar gargalos por especialidade técnica. |
| `seniority` | Nível (Senior, Pleno, Junior). | Analisar impacto da experiência na estabilidade do fluxo. |

---

## 2. Métricas de Fluxo e Tempo (Calculadas)

Estes campos são usados para **Agregações Estatísticas** (P50, P75, P85, P95).

| Campo | Lógica do Cálculo | Potencial de Análise (BI) |
| :--- | :--- | :--- |
| `ctDays` | `(Data de Conclusão - Data de Início Ativo)`. | **Cycle Time:** Usar percentis para previsibilidade. |
| `queueTimeDays`| `(Data de Início Ativo - Data de Criação)`. | **Queue Time:** Medir o custo de espera no backlog. |
| `touchTimeDays`| `(Lead Time Total - (Horas Bloqueadas / 24))`. | **Trabalho Real:** Quanto tempo o dev realmente codou. |
| `waitTimeDays` | `(Lead Time Total - Touch Time)`. | **Desperdício:** KPI de redução de burocracia. |
| `flowEfficiency`| `(Touch Time / Cycle Time) * 100`. | **Agregado:** Sempre use soma ponderada macro. |
| `predictabilityIndex` | `(Story Points / Cycle Time)`. | **Guardrail:** Filtrar `sp > 0` e `ctDays > 0`. |

---

## 3. Indicadores de Risco e Complexidade (Brooks & Jocko)

Estes campos antecipam falhas antes que o Cycle Time estoure.

| Campo | Lógica do Cálculo | O que ele antecipa |
| :--- | :--- | :--- |
| `assigneeCount`| Total de pessoas únicas na tarefa. | Se > 1, indica apoio ou troca de contexto. |
| `handoffCount` | Total de trocas de dono registradas. | **Ruído:** Muitas trocas aumentam a chance de bugs. |
| `tooManyCooks` | `true` se `assigneeCount > 3`. | **Brooks:** Excesso de coordenação atrasa a tarefa. |
| `communicationComplexity` | `assigneeCount * handoffCount`. | Índice real de ruído operacional (Não é o mesmo que handoff). |
| `wasReopened`  | Se voltou de `Done` para `Doing`. | **Falha no Done:** Indica validação insuficiente. |
| `isScopeCreep` | Se entrou na sprint após o início. | **Scope Creep:** Mede indisciplina de planejamento. |
| `sprintCount`  | Total de sprints percorridas. | **Carry-over:** Indica tarefas que "vazaram" do ciclo planejado. |

---

## 4. Análise de Status (Time In Status)

Campos dinâmicos baseados no histórico do Jira.

*   **`timeInStatus_lifetime_...`**: Tempo acumulado desde a criação. Útil para ver o tempo total de vida da issue.
*   **`timeInStatus_windowed_...`**: Tempo acumulado apenas durante o Cycle Time. Útil para localizar onde a tarefa parou no fluxo ativo (ex: esperando aprovação de terceiros).

---

## 5. Resumo de Visão Executiva

| Se o dado indicar... | O AI Studio deve sinalizar... | Autor Referência |
| :--- | :--- | :--- |
| **Variabilidade > 1.5** | Instabilidade crítica de processo. | Daniel Vacanti |
| **Scope Creep > 20%** | Fragilidade de planejamento/foco. | John Doerr |
| **Flow Efficiency < 15%**| Gargalo de burocracia/bloqueios. | Eliyahu Goldratt |
| **Ruído (CommComp) > 3** | Risco alto de falha de comunicação. | Fred Brooks |
