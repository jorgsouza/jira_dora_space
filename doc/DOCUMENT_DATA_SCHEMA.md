# 📖 Dicionário de Dados e Guia de Métricas (MongoDB Schema)

Este documento detalha cada campo presente na coleção `issues_dora_flow`, como o valor é calculado e como utilizá-lo para filtrar e agrupar dados em relatórios do AI Studio.

---

## 1. Identificação e Metadados


| Campo         | Descrição / Cálculo                         | Uso como Filtro / BI                                     |
| ------------- | ------------------------------------------- | -------------------------------------------------------- |
| `key`         | Chave única da issue no Jira (ex: AW-293).  | Busca direta por uma tarefa específica.                  |
| `title`       | Resumo/Título da tarefa.                    | Pesquisa textual por palavras-chave.                     |
| `data_export` | Data em que a extração foi realizada.       | Comparar "fotos" do banco em diferentes momentos.        |
| `ano_mes`     | Ano e Mês da **resolução** da tarefa.       | **Eixo X:** Gráficos de Throughput e Performance mensal. |
| `updatedAt`   | Timestamp da última atualização no MongoDB. | Auditoria de integridade da base.                        |


---

## 2. Dimensões Organizacionais e Perfil


| Campo             | Descrição / Cálculo                            | Uso como Filtro                                       |
| ----------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `assignee`        | Nome da última pessoa responsável pela tarefa. | Filtrar carga individual por sprint.                  |
| `function`        | Cargo/Papel extraído do `developers.json`.     | Comparar eficiência entre especialidades.             |
| `seniority`       | Senior, Pleno, Junior ou Estagiário.           | Analisar se a experiência reduz a variabilidade.      |
| `squad` / `tribe` | Time e Tribo do desenvolvedor.                 | **Filtro Principal:** Comparar squads e tribos no BI. |
| `stack`           | Categoria técnica (Back-end, Front-end, etc.). | Identificar gargalos técnicos específicos.            |


---

## 3. Classificação do Trabalho


| Campo               | Descrição / Cálculo                                                                                               | Uso como Filtro                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `issueType`         | Tipo de item no Jira (Story, Bug, Task, Hipótese, Experimento…).                                                  | Filtrar por natureza da demanda.                                                     |
| `workType`          | Categoria: `bug`, `feature`, `suporte`, `outros`.                                                                 | **KPI de Investimento:** Distribuição de esforço.                                    |
| `lane`              | Lane de trabalho: `inovacao`, `magica`, `outros`. Derivado de `issueType` via `JIRA_LANE_MAP` (env) ou mapa padrão. | **KPI Estratégico:** Distribuição Inovação × Sustentação. Alvo típico: 70% × 30%.   |
| `priority`          | Urgência definida no Jira.                                                                                        | Validar correlação entre prioridade e velocidade.                                    |
| `sp` (Story Points) | Pontuação de esforço.                                                                                             | **Guardrail:** Usar somente `sp > 0` para Slicing.                                   |
| `epic`              | Nome do Épico associado.                                                                                          | Agrupar por grandes iniciativas de negócio.                                          |
| `parentKey`         | Chave da issue pai no Jira (ex: `CNS-78`). `null` se não houver pai.                                              | Reconstruir **Cadeia de Entrega** (VT → tickets filhos).                             |
| `parentType`        | Tipo de issue da issue pai (ex: `Experimento`, `Epic`). `null` se não houver pai.                                 | Filtrar subtarefas por contexto de inovação ou sustentação.


---

## 4. Métricas de Fluxo (DORA & Lean)


| Campo                 | Descrição / Cálculo                             | Uso em Gráficos (AI Studio)                               |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `ctDays` (Cycle Time) | **(End - Start)** em dias.                      | **Prioridade:** Usar Percentis (P50, P75, P85, P95).      |
| `queueTimeDays`       | Tempo em fila (Criado -> Início).               | Medir demora para o time puxar a tarefa.                  |
| `touchTimeDays`       | Tempo real de mão na massa (Ativo - Bloqueios). | Base para a Eficiência de Fluxo.                          |
| `waitTimeDays`        | Desperdício total (Lead Time - Touch Time).     | KPI de redução de desperdício (*Muda*).                   |
| `flowEfficiency`      | **(Touch Time / Cycle Time) * 100**.            | **Macro:** Usar `sum(touchTimeDays) / sum(ctDays) * 100`. |
| `predictabilityIndex` | **(sp / ctDays)**. Índice de fatiamento.        | **BI:** Analisar Mediana por faixa de SP.                 |


---

## 5. Indicadores de Risco e Complexidade


| Campo                     | Descrição / Cálculo                                                                                              | O que ele antecipa (Insights)                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `assigneeCount`           | Total de pessoas que foram donas da tarefa.                                                                      | Se > 1, indica troca de dono ou apoio.                |
| `handoffCount`            | Número de vezes que a tarefa trocou de dono.                                                                     | Medir ruído operacional.                              |
| `tooManyCooks`            | `true` se `assigneeCount > 3`.                                                                                   | **Brooks:** Alerta de excesso de coordenação.         |
| `communicationComplexity` | `assigneeCount * handoffCount`.                                                                                  | Índice composto de ruído (Não confundir com handoff). |
| `wasReopened`             | Se voltou de "Done" para aberto.                                                                                 | **Reopen Rate:** KPI de Qualidade e Retrabalho.       |
| `isScopeCreep`            | Se entrou na sprint após o início.                                                                               | **Scope Creep %:** KPI de Higiene de Planejamento.    |
| `sprintCount`             | Total de sprints que a tarefa percorreu.                                                                         | **Carry-over:** KPI de falha de estimativa/foco.      |
| `hasDependencies`         | `true` se a issue possui qualquer tipo de link (blocks, relates, clones…).                                       | Identificar issues com dependências externas.         |
| `clonesCount`             | Número de issues que esta issue clona.                                                                           | **Cloners:** Rastrear reutilização/cópia de cards.    |
| `clonedByCount`           | Número de issues que clonaram esta issue.                                                                        | Identificar templates ou cards raiz de clonagem.      |
| `linkedIssues`            | Array de todos os vínculos: `[{ key, summary, linkType, direction }]`. Inclui blocks, relates, clones e outros. | **Cadeia de Entrega:** Reconstruir grafos de dependência e cadeias VT → tickets. |


---

## 6. Histórico de Status (Time in Status)

Os campos `timeInStatus_lifetime_<Status>` e `timeInStatus_windowed_<Status>` permitem uma análise granular:

- **Lifetime:** Ver quanto tempo uma tarefa "esperou na prateleira" antes de nascer.
- **Windowed:** Entender em qual status a tarefa ficou estacionada **durante** a execução (ex: esperando Review ou QA).

### Campo `statusTransitions`

Array com todos os pares de transição registrados no changelog:

```json
[
  { "from": "Backlog", "to": "To Do", "count": 3, "timestamps": ["2026-01-10T09:00:00.000Z", ...] },
  { "from": "Done Dev", "to": "Em Medição / Em Validação", "count": 1, "timestamps": [...] }
]
```

| Subcampo      | Descrição                                                          |
| ------------- | ------------------------------------------------------------------ |
| `from`        | Status de origem da transição.                                     |
| `to`          | Status de destino da transição.                                    |
| `count`       | Quantas vezes essa transição ocorreu na issue.                     |
| `timestamps`  | Lista ISO dos momentos exatos de cada transição.                   |

**Uso principal:** Agregar `sum(count)` por par `(from, to)` no nível de squad/período para obter o gráfico **"Transições fora do fluxo"** — identificando retrocessos no workflow (ex: Done → Backlog) e gargalos recorrentes.

---

### Resumo Executivo para BI

1. **Visão de Previsibilidade:** Gráfico de linha `ano_mes` vs `P75(ctDays)`.
2. **Visão de Desperdício:** Gráfico de barras `squad` vs `sum(waitTimeDays)`.
3. **Visão de Planejamento:** Gráfico de pizza `squad` vs `% isScopeCreep`.
4. **Guardrail Obrigatório:** Nunca mostrar a média simples de `ctDays` ou `flowEfficiency` como KPI principal.

