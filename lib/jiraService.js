import axios from "axios";
import chalk from "chalk";
import { makeApiRequest } from "./apiUtils.js";
import dayjs from "dayjs"; // Biblioteca para manipulação de datas

/* dotenv: carregado por extract.mjs antes de importar este módulo */

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_AGILE_BASE_URL = process.env.JIRA_AGILE_BASE_URL || `${process.env.JIRA_BASE_URL}/rest/agile/1.0`;
const JIRA_USER = process.env.JIRA_USER;
const JIRA_TOKEN = process.env.JIRA_TOKEN;

// ✅ Cache global de metadados de sprint (id → {name, startDate, endDate, state})
// Evita múltiplas chamadas à API para o mesmo sprint
const sprintMetadataCache = new Map();

/**
 * Busca metadados de um sprint via API do Jira Agile
 * @param {string|number} sprintId - ID do sprint
 * @returns {Promise<{id: string, name: string, startDate: string|null, endDate: string|null, state: string|null}|null>}
 */
async function fetchSprintMetadata(sprintId) {
  if (!sprintId || sprintId === 'none' || sprintId === 'unknown') return null;
  
  // Verificar cache primeiro
  if (sprintMetadataCache.has(String(sprintId))) {
    return sprintMetadataCache.get(String(sprintId));
  }
  
  try {
    const url = `${JIRA_AGILE_BASE_URL}/sprint/${sprintId}`;
    const auth = { username: JIRA_USER, password: JIRA_TOKEN };
    
    const response = await axios.get(url, { auth });
    const sprint = response.data;
    
    const metadata = {
      id: String(sprint.id),
      name: sprint.name || 'Unknown Sprint',
      startDate: sprint.startDate || null,
      endDate: sprint.endDate || sprint.completeDate || null,
      state: sprint.state || null
    };
    
    // Salvar no cache
    sprintMetadataCache.set(String(sprintId), metadata);
    
    return metadata;
  } catch (error) {
    // Sprint não encontrado ou erro de API - não logar para não poluir console
    // Salvar null no cache para evitar tentativas repetidas
    sprintMetadataCache.set(String(sprintId), null);
    return null;
  }
}

/**
 * Busca metadados de múltiplos sprints em batch
 * @param {string[]} sprintIds - Array de IDs de sprint
 * @returns {Promise<Map<string, {name: string, startDate: string|null, endDate: string|null, state: string|null}>>}
 */
async function fetchSprintMetadataBatch(sprintIds) {
  const results = new Map();
  const idsToFetch = [];
  
  // Verificar cache primeiro
  for (const id of sprintIds) {
    const strId = String(id);
    if (sprintMetadataCache.has(strId)) {
      const cached = sprintMetadataCache.get(strId);
      if (cached) results.set(strId, cached);
    } else if (strId !== 'none' && strId !== 'unknown' && /^\d+$/.test(strId)) {
      idsToFetch.push(strId);
    }
  }
  
  // Buscar os que não estão em cache (em paralelo, máximo 10 por vez)
  const batchSize = 10;
  for (let i = 0; i < idsToFetch.length; i += batchSize) {
    const batch = idsToFetch.slice(i, i + batchSize);
    const promises = batch.map(id => fetchSprintMetadata(id));
    const batchResults = await Promise.all(promises);
    
    batch.forEach((id, idx) => {
      if (batchResults[idx]) {
        results.set(id, batchResults[idx]);
      }
    });
  }
  
  return results;
}

/**
 * Verifica se as credenciais do Jira estão configuradas corretamente.
 * @returns {boolean} true se as credenciais estiverem presentes, false caso contrário.
 */
function validarCredenciais() {
  if (!JIRA_USER || !JIRA_TOKEN) {
    console.error("❌ Credenciais do Jira não configuradas. Verifique seu arquivo .env.");
    return false;
  }
  return true;
}

/** Normaliza resposta de GET /rest/api/3/user/search (array ou envelope). */
function normalizeUserSearchList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.users)) return data.users;
  if (data && Array.isArray(data.values)) return data.values;
  return [];
}

/**
 * Escolhe o usuário mais provável para o e-mail alvo.
 * @param {object[]} list
 * @param {string} emailLower e-mail em minúsculas
 * @param {{ username?: string, name?: string }} hints
 */
function pickUserFromSearchList(list, emailLower, hints = {}) {
  if (!list || list.length === 0) return null;
  const exact = list.find((u) => (u.emailAddress || '').toLowerCase() === emailLower);
  if (exact?.accountId) return exact;
  const local = emailLower.includes('@') ? emailLower.split('@')[0] : '';
  const uname = (hints.username || '').toLowerCase().trim();
  if (uname) {
    const byLocal = list.find(
      (u) => (u.emailAddress || '').split('@')[0]?.toLowerCase() === uname
    );
    if (byLocal?.accountId) return byLocal;
    const byDn = list.find((u) =>
      (u.displayName || '').toLowerCase().includes(uname.replace(/\./g, ' '))
    );
    if (byDn?.accountId) return byDn;
  }
  if (hints.name) {
    const nm = hints.name.toLowerCase().trim();
    const words = nm.split(/\s+/).filter(Boolean);
    const byName = list.find((u) => {
      const dn = (u.displayName || '').toLowerCase();
      return words.length > 0 && words.every((w) => dn.includes(w));
    });
    if (byName?.accountId) return byName;
  }
  if (local) {
    const loose = list.find(
      (u) =>
        u.emailAddress &&
        ((u.emailAddress || '').toLowerCase().includes(local) ||
          local.includes((u.emailAddress || '').split('@')[0]?.toLowerCase() || ''))
    );
    if (loose?.accountId) return loose;
  }
  if (list.length === 1 && list[0]?.accountId) return list[0];
  return null;
}

/**
 * Monta lista de strings para tentar em /user/search (Jira Cloud costuma indexar displayName e parte do e-mail).
 * @param {string} email
 * @param {{ jiraAccountId?: string, username?: string, name?: string }} hints
 */
function buildUserSearchQueries(email, hints = {}) {
  const raw = (email || '').trim();
  const queries = [];
  if (hints.jiraAccountId) return queries;
  if (raw) queries.push(raw);
  if (raw.includes('@')) {
    const local = raw.split('@')[0];
    queries.push(local);
    queries.push(local.replace(/\./g, ' '));
    queries.push(local.replace(/\./g, ''));
  }
  if (hints.username && String(hints.username).trim()) {
    queries.push(String(hints.username).trim());
    queries.push(String(hints.username).trim().replace(/\./g, ' '));
  }
  if (hints.name && String(hints.name).trim()) {
    const n = String(hints.name).trim();
    queries.push(n);
    const parts = n.split(/\s+/).filter((p) => p.length > 2);
    if (parts.length >= 2) queries.push(`${parts[0]} ${parts[parts.length - 1]}`);
    if (parts[0]) queries.push(parts[0]);
  }
  const seen = new Set();
  return queries.filter((q) => {
    const k = q.toLowerCase();
    // Jira Cloud costuma exigir query com pelo menos 3 caracteres (GDPR / indexação).
    if (!k || k.length < 3 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function assigneeHintsCacheKey(emailLower, hints) {
  if (!hints || typeof hints !== 'object') return emailLower;
  const id = hints.jiraAccountId || '';
  const u = hints.username || '';
  const n = hints.name || '';
  return `${emailLower}::${id}::${u}::${n}`;
}

/**
 * Jira Cloud: JQL com assignee = "email" frequentemente não encontra usuário.
 * Resolve via GET /rest/api/3/user/search e usa assignee = "accountId".
 * Resultado é cacheado por e-mail (+ hints) na execução (menos chamadas na extração em lote).
 * @param {string} email
 * @param {{ jiraAccountId?: string, username?: string, name?: string }} [hints] opcional (ex.: de developers.json)
 * @returns {Promise<string>} fragmento JQL, ex.: assignee = "5b10a..."
 */
async function resolveAssigneeJqlClause(email, hints = {}) {
  const raw = (email || '').trim();
  const key = raw.toLowerCase();
  if (!key) return 'assignee = empty';

  const cacheKey = assigneeHintsCacheKey(key, hints);
  if (!resolveAssigneeJqlClause._cache) resolveAssigneeJqlClause._cache = new Map();
  if (resolveAssigneeJqlClause._cache.has(cacheKey)) {
    return resolveAssigneeJqlClause._cache.get(cacheKey);
  }

  const escapeJqlUser = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const fallback = `assignee = "${escapeJqlUser(raw)}"`;

  if (hints.jiraAccountId && String(hints.jiraAccountId).trim()) {
    const clause = `assignee = "${escapeJqlUser(String(hints.jiraAccountId).trim())}"`;
    resolveAssigneeJqlClause._cache.set(cacheKey, clause);
    return clause;
  }

  if (!JIRA_BASE_URL) {
    resolveAssigneeJqlClause._cache.set(cacheKey, fallback);
    return fallback;
  }

  const auth = { username: JIRA_USER, password: JIRA_TOKEN };
  const searchUrl = `${JIRA_BASE_URL}/rest/api/3/user/search`;
  const queries = buildUserSearchQueries(raw, hints);

  for (const query of queries) {
    try {
      const users = await makeApiRequest(searchUrl, auth, {
        params: { query, maxResults: 50 },
        timeout: 25000,
      });
      const list = normalizeUserSearchList(users);
      const match = pickUserFromSearchList(list, key, hints);
      if (match?.accountId) {
        const clause = `assignee = "${escapeJqlUser(match.accountId)}"`;
        resolveAssigneeJqlClause._cache.set(cacheKey, clause);
        return clause;
      }
    } catch {
      /* makeApiRequest já registrou; tenta próxima query */
    }
  }

  resolveAssigneeJqlClause._cache.set(cacheKey, fallback);
  return fallback;
}

/**
 * Busca detalhes de um ticket no Jira usando autenticação via API Token.
 * @param {string} ticketId
 * @returns {Promise<{ title: string, description: string } | null>}
 */
export async function fetchTicketDetails(ticketId) {
  if (!validarCredenciais()) return null;

  const url = `${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}?expand=changelog`;
  const auth = { username: JIRA_USER, password: JIRA_TOKEN };

  try {
    const ticket = await makeApiRequest(url, auth);
    const title = ticket.fields.summary;
    const description = ticket.fields.description?.content
      ?.map(block => block.content?.map(text => text.text).join(" "))
      .join("\n") || "Sem descrição."; // Fallback to "Sem descrição." if undefined

    return { title, description, changelog: ticket.changelog };
  } catch (error) {
    console.error("❌ Erro ao buscar o ticket:", error.message);
    return null;
  }
}

/**
 * Busca todas as tasks abertas atribuídas a um email específico.
 * @param {string} email - Email do colaborador.
 * @returns {Promise<Array<{ key: string, summary: string, description: string, startDate: string, endDate: string, daysOpen: number }>>}
 */
export async function buscarTasksPorEmail(email) {
  if (!validarCredenciais()) return [];

  const assigneeCl = await resolveAssigneeJqlClause(email);

  // ✅ NOVA API: /rest/api/3/search/jql
  const url = `${JIRA_BASE_URL}/rest/api/3/search/jql`;
  const auth = { username: JIRA_USER, password: JIRA_TOKEN };

  try {
    const jql = `${assigneeCl} AND statusCategory != Done ORDER BY priority DESC`;
    const response = await makeApiRequest(url, auth, {
      params: { 
        jql, 
        fields: "key,summary,description,created,resolutiondate,customfield_10002,status,changelog,aggregatetimeoriginalestimate",
        expand: "changelog" 
      }
    });

    return response.issues.map((issue) => {
      const { startDate, daysOpen } = calcularTempoAberto(issue.fields.created);
      const endDate = issue.fields.resolutiondate
        ? dayjs(issue.fields.resolutiondate).format("DD/MM/YYYY")
        : "Em aberto";
      
      const storyPoints = issue.fields.customfield_10002 || 0;
      const cycleTimeData = calculateCycleTime(issue);
      const cycleTime = typeof cycleTimeData === 'object' ? cycleTimeData.cycleTimeDays : cycleTimeData;
      const cycleTimePerStoryPoint = storyPoints > 0 ? cycleTime / storyPoints : 0;
      
      return {
        key: issue.key,
        summary: issue.fields.summary,
        description: issue.fields.description?.content
          ?.map((block) => block.content?.map((text) => text.text).join(" "))
          .join("\n") || "Sem descrição.",
        startDate,
        endDate,
        daysOpen,
        storyPoints,
        cycleTime,
        cycleTimePerStoryPoint
      };
    });
  } catch (error) {
    console.error("❌ Erro ao buscar tasks por email:", error.message);
    return [];
  }
}

/**
 * 🆕 BUSCAR ISSUES POR DESENVOLVEDOR ATRAVÉS DE BOARDS → SPRINTS
 * Abordagem otimizada: descobre o board do dev primeiro, depois busca apenas aquele
 * Garante que issues vêm com sprint correto associado
 */
export async function buscarHistoricoTasksPorEmailComSprints(email, months = 6) {
  if (!validarCredenciais()) return [];

  const assigneeCl = await resolveAssigneeJqlClause(email);

  console.log(chalk.gray(`🔍 Buscando issues de ${email} através de Boards → Sprints...`));
  
  const auth = { username: JIRA_USER, password: JIRA_TOKEN };
  const allIssues = [];
  const processedIssueKeys = new Set(); // Evitar duplicatas
  
  try {
    // 1. OTIMIZAÇÃO: Descobrir qual é o board do desenvolvedor
    console.log(chalk.gray(`   🔍 Descobrindo board do desenvolvedor...`));
    
    const recentIssueUrl = `${JIRA_BASE_URL}/rest/api/3/search/jql`;
    const recentIssueResponse = await makeApiRequest(recentIssueUrl, auth, {
      params: {
        jql: `${assigneeCl} AND updated >= -180d ORDER BY updated DESC`,
        maxResults: 1,
        fields: "key"
      },
      timeout: 10000
    });
    
    if (!recentIssueResponse.issues || recentIssueResponse.issues.length === 0) {
      console.log(chalk.yellow(`   ⚠️  Nenhuma issue recente encontrada para ${email}`));
      return [];
    }
    
    const issueKey = recentIssueResponse.issues[0].key;
    console.log(chalk.gray(`   📝 Issue recente encontrada: ${issueKey}`));
    
    // 2. Buscar o board desta issue usando a API Agile
    let userBoardId = null;
    const allBoardIds = process.env.JIRA_BOARD_ID ? process.env.JIRA_BOARD_ID.split(',').map(id => id.trim()) : [];
    
    // Tentar encontrar o board desta issue
    for (const boardId of allBoardIds) {
      try {
        const boardIssuesUrl = `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/issue`;
        const boardIssuesResponse = await makeApiRequest(boardIssuesUrl, auth, {
          params: {
            jql: `key = "${issueKey}"`,
            maxResults: 1
          },
          timeout: 10000
        });
        
        if (boardIssuesResponse.issues && boardIssuesResponse.issues.length > 0) {
          userBoardId = boardId;
          console.log(chalk.green(`   ✓ Board encontrado: ${boardId} (issue ${issueKey} está neste board)`));
          break;
        } else {
          console.log(chalk.gray(`   ⏭️  Board ${boardId}: issue ${issueKey} não está aqui`));
        }
      } catch (boardCheckError) {
        console.log(chalk.red(`   ❌ Erro ao verificar board ${boardId}: ${boardCheckError.message}`));
      }
    }
    
    // 3. Usar apenas o board do desenvolvedor (ou todos como fallback)
    const boardIds = userBoardId ? [userBoardId] : allBoardIds;
    
    if (boardIds.length === 0) {
      console.log(chalk.yellow('   ⚠️  Nenhum board configurado em JIRA_BOARD_ID'));
      return [];
    }
    
    if (userBoardId) {
      console.log(chalk.green(`   🎯 Usando apenas o board ${userBoardId} do desenvolvedor`));
    } else {
      console.log(chalk.gray(`   📋 Analisando ${boardIds.length} boards...`));
    }
    
    // 4. Para cada board, buscar sprints
    for (const boardId of boardIds) {
      try {
        // Buscar sprints do board (últimas 50 sprints para pegar as mais recentes de 2025)
        console.log(chalk.cyan(`\n   📋 Buscando sprints do Board ${boardId}...`));
        const sprintsUrl = `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/sprint?maxResults=50`;
        console.log(chalk.gray(`   🔗 URL: ${sprintsUrl}`));
        const sprintsResponse = await makeApiRequest(sprintsUrl, auth, { timeout: 15000 });
        
        if (!sprintsResponse.values || sprintsResponse.values.length === 0) {
          console.log(chalk.gray(`   ⏭️  Board ${boardId}: sem sprints`));
          continue;
        }
        
        // Filtrar sprints dos últimos 12 meses (para pegar sprints de 2024 e 2025)
        const twelveMonthsAgo = dayjs().subtract(12, 'months');
        const recentSprints = sprintsResponse.values.filter(sprint => {
          // Incluir sprints ativas, futuras ou dos últimos 12 meses
          if (sprint.state === 'active' || sprint.state === 'future') return true;
          if (!sprint.startDate) return false;
          const sprintStart = dayjs(sprint.startDate);
          return sprintStart.isAfter(twelveMonthsAgo);
        });
        
        // Ordenar sprints por data (mais recentes primeiro)
        const sortedSprints = recentSprints.sort((a, b) => {
          const dateA = a.startDate ? dayjs(a.startDate) : dayjs(0);
          const dateB = b.startDate ? dayjs(b.startDate) : dayjs(0);
          return dateB.diff(dateA);
        });
        
        console.log(chalk.gray(`   🏃 Board ${boardId}: ${sprintsResponse.values.length} sprints totais, ${sortedSprints.length} dos últimos 12 meses`));
        
        if (sortedSprints.length === 0) {
          console.log(chalk.yellow(`   ⚠️  Nenhuma sprint dos últimos 12 meses no board ${boardId}`));
          continue;
        }
        
        console.log(chalk.cyan(`\n   📅 PRIMEIRAS 5 SPRINTS (mais recentes de 2024/2025):`));
        sortedSprints.slice(0, 5).forEach(s => {
          const startDate = s.startDate ? dayjs(s.startDate).format('DD/MM/YYYY') : 'N/A';
          const endDate = s.endDate ? dayjs(s.endDate).format('DD/MM/YYYY') : 'N/A';
          console.log(chalk.gray(`      • Sprint "${s.name}" (ID: ${s.id})`));
          console.log(chalk.gray(`        Estado: ${s.state} | Início: ${startDate} | Fim: ${endDate}`));
        });
        
        // 3. Para cada sprint, buscar issues do desenvolvedor
        for (const sprint of sortedSprints) {
          try {
            const startDate = sprint.startDate ? dayjs(sprint.startDate).format('DD/MM/YYYY') : 'N/A';
            const endDate = sprint.endDate ? dayjs(sprint.endDate).format('DD/MM/YYYY') : 'N/A';
            
            // Buscar issues do desenvolvedor nesta sprint
            const issuesUrl = `${JIRA_BASE_URL}/rest/agile/1.0/sprint/${sprint.id}/issue`;
            const issuesResponse = await makeApiRequest(issuesUrl, auth, {
              params: {
                jql: `${assigneeCl}`,
                maxResults: 100,
                fields: "key,summary,created,resolutiondate,status,issuetype,project,customfield_10002,customfield_10004,customfield_10005,customfield_10006,customfield_10007,customfield_10008,customfield_10016,customfield_10020,changelog,timetracking,aggregatetimespent",
                expand: "changelog"
              },
              timeout: 15000
            });
            
            if (issuesResponse.issues && issuesResponse.issues.length > 0) {
              console.log(chalk.gray(`      ✓ Sprint "${sprint.name}" (${startDate} → ${endDate}): ${issuesResponse.issues.length} issues`));
              
              // Processar issues desta sprint
              issuesResponse.issues.forEach(issue => {
                if (!processedIssueKeys.has(issue.key)) {
                  processedIssueKeys.add(issue.key);
                  
                  const storyPoints = extractStoryPoints(issue.fields);
                  const cycleTimeData = calculateCycleTime(issue);
                  const cycleTime = typeof cycleTimeData === 'object' ? cycleTimeData.cycleTimeDays : cycleTimeData;
                  const cycleTimePerStoryPoint = storyPoints > 0 ? cycleTime / storyPoints : 0;
                  
                  const isDone = issue.fields.status?.statusCategory?.key === 'done';
                  const created = dayjs(issue.fields.created);
                  const resolved = issue.fields.resolutiondate ? dayjs(issue.fields.resolutiondate) : null;
                  
                  allIssues.push({
                    key: issue.key,
                    summary: issue.fields.summary,
                    type: issue.fields.issuetype?.name || 'Task',
                    status: issue.fields.status?.name || 'Unknown',
                    statusCategory: issue.fields.status?.statusCategory?.name || 'Unknown',
                    isDone,
                    created: created.format("YYYY-MM-DD"),
                    createdMonth: created.format("YYYY-MM"),
                    resolved: resolved ? resolved.format("YYYY-MM-DD") : null,
                    resolvedMonth: resolved ? resolved.format("YYYY-MM") : null,
                    sprintName: sprint.name,
                    sprintId: sprint.id.toString(),
                    sprintState: sprint.state,
                    storyPoints,
                    cycleTime,
                    cycleTimePerStoryPoint,
                    daysOpen: resolved ? resolved.diff(created, 'days') : dayjs().diff(created, 'days'),
                    timeSpent: issue.fields.aggregatetimespent ? issue.fields.aggregatetimespent / 3600 : 0
                  });
                }
              });
            }
          } catch (sprintError) {
            console.error(chalk.red(`      ❌ Erro na sprint ${sprint.id}: ${sprintError.message}`));
          }
        }
      } catch (boardError) {
        console.error(chalk.red(`   ❌ Erro no board ${boardId}: ${boardError.message}`));
      }
    }
    
    console.log(chalk.green(`   ✅ Total: ${allIssues.length} issues encontradas com sprints!`));
    return allIssues;
    
  } catch (error) {
    console.error("❌ Erro ao buscar histórico via boards/sprints:", error.message);
    return [];
  }
}

/**
 * Extrai story points de uma issue tentando múltiplos campos possíveis
 * @param {Object} fields - Campos da issue do Jira
 * @returns {number} Story points encontrados (0 se nenhum encontrado)
 */
function extractStoryPoints(fields) {
  if (!fields) return 0;
  
  // Lista de possíveis campos de story points (em ordem de prioridade)
  const storyPointFields = [
    "customfield_10002", "customfield_10004", "customfield_10005", "customfield_10006",
    "customfield_10007", "customfield_10008", "customfield_10016", "customfield_10020",
    "storyPoints", "storypoints", "story_points"
  ];
  
  // Tentar cada campo na ordem de prioridade
  for (const fieldName of storyPointFields) {
    const spField = fields[fieldName];
    
    if (spField !== null && spField !== undefined) {
      // Caso número
      if (typeof spField === 'number') {
        if (!isNaN(spField) && isFinite(spField) && spField > 0) {
          return Math.max(0, spField);
        }
      }
      // Caso string
      else if (typeof spField === 'string') {
        const cleaned = spField.trim();
        if (cleaned !== '' && cleaned !== 'null' && cleaned !== 'undefined') {
          const parsed = parseFloat(cleaned);
          if (!isNaN(parsed) && isFinite(parsed) && parsed > 0) {
            return Math.max(0, parsed);
          }
        }
      }
      // Caso objeto
      else if (typeof spField === 'object') {
        // Se for array, pegar primeiro elemento
        if (Array.isArray(spField)) {
          if (spField.length > 0) {
            const firstValue = spField[0];
            if (typeof firstValue === 'number' && !isNaN(firstValue) && isFinite(firstValue)) {
              return Math.max(0, firstValue);
            }
          }
        }
        // Tentar propriedades comuns
        else {
          const possibleKeys = ['value', 'points', 'estimate', 'storyPoints', 'sp', 'size'];
          for (const key of possibleKeys) {
            if (spField[key] !== undefined && spField[key] !== null) {
              const value = spField[key];
              if (typeof value === 'number' && !isNaN(value) && isFinite(value) && value > 0) {
                return Math.max(0, value);
              } else if (typeof value === 'string') {
                const parsed = parseFloat(value);
                if (!isNaN(parsed) && isFinite(parsed) && parsed > 0) {
                  return Math.max(0, parsed);
                }
              }
            }
          }
        }
      }
    }
  }
  
  return 0;
}

/**
 * 🎯 Busca TODAS as tasks (concluídas e em andamento) dos últimos X meses para um email
 * FOCADO EM ANÁLISE DE PERFORMANCE INDIVIDUAL
 * @param {string} email - Email do desenvolvedor
 * @param {number} months - Número de meses para buscar (default: 6)
 * @param {number} year - Ano específico para filtrar (opcional, se fornecido filtra apenas issues concluídas neste ano)
 * @param {{ jiraAccountId?: string, username?: string, name?: string }} [assigneeHints] opcional — melhora resolução assignee→accountId quando user/search por e-mail falha
 * @returns {Promise<Array>} Issues com métricas completas
 */
export async function buscarHistoricoTasksPorEmail(email, months = 6, year = null, assigneeHints = null) {
  if (!validarCredenciais()) return [];

  const assigneeCl = await resolveAssigneeJqlClause(email, assigneeHints || {});

  // ✅ API obrigatória: /rest/api/3/search/jql (a /rest/api/3/search foi removida)
  // Nota: Esta API pode ter problemas de paginação em alguns casos, então adicionamos detecção de duplicatas
  const url = `${JIRA_BASE_URL}/rest/api/3/search/jql`;
  const auth = { username: JIRA_USER, password: JIRA_TOKEN };

  try {
    let jql;
    
    // Se ano específico fornecido, buscar issues do ano (concluídas E não concluídas)
    if (year) {
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;
      // Para relatório anual, buscar:
      // 1. Issues concluídas no ano especificado
      // 2. Issues criadas/atualizadas no ano que ainda não foram concluídas (para análise de sprint)
      jql = `${assigneeCl} AND ((resolutiondate >= "${startDate}" AND resolutiondate <= "${endDate}") OR (updated >= "${startDate}" AND updated <= "${endDate}" AND statusCategory != Done)) ORDER BY updated DESC`;
    } else {
      // Buscar issues dos últimos X meses (concluídas OU em andamento)
      // JQL em uma linha única para evitar erros 410
      const daysBack = months * 30;
      jql = `${assigneeCl} AND (resolutiondate >= -${daysBack}d OR (created >= -${daysBack}d AND statusCategory != Done)) ORDER BY resolutiondate DESC, created DESC`;
    }
    
    let allIssues = [];
    let startAt = 0;
    const maxResults = 100;
    const maxPages = 20; // Limite de segurança: máximo 2000 issues
    let currentPage = 0;
    let hasMore = true;
    let detectedStoryPointField = null;

    // Paginação para buscar todas as issues (com limite de segurança)
    while (hasMore && currentPage < maxPages) {
      currentPage++;
        // Remover log detalhado de paginação - spinner já mostra progresso
      
      try {
        // Solicitar múltiplos campos possíveis de story points
        // A API /rest/api/3/search/jql usa GET com parâmetros
        const response = await makeApiRequest(url, auth, {
          params: {
            jql,
            startAt,
            maxResults,
            fields: "key,summary,created,resolutiondate,status,issuetype,project,customfield_10002,customfield_10004,customfield_10005,customfield_10006,customfield_10007,customfield_10008,customfield_10016,customfield_10020,changelog,timetracking,aggregatetimespent,issuelinks,parent,priority,epic,labels,components,fixVersions,comment",
            expand: "changelog"
          },
          timeout: 60000 // 60 segundos de timeout por requisição (aumentado para evitar timeout em queries grandes)
        });
        
        // Debug: verificar estrutura da resposta e total disponível
        if (response.total !== undefined && currentPage === 1) {
          // Remover log detalhado - spinner já mostra progresso
        }
        
        if (!response.issues) {
          // Remover logs de resposta inesperada - spinner já mostra progresso
          if (response.values) {
            response.issues = response.values;
          } else {
            // Remover log de erro - spinner já mostra progresso
            hasMore = false;
            break;
          }
        }
        
        // Debug: verificar se estamos recebendo issues diferentes
        if (currentPage > 1 && response.issues.length > 0) {
          const firstIssueKey = response.issues[0].key;
          const lastIssueKey = response.issues[response.issues.length - 1].key;
          const alreadyHaveFirst = allIssues.some(i => i.key === firstIssueKey);
          const alreadyHaveLast = allIssues.some(i => i.key === lastIssueKey);
          
          if (alreadyHaveFirst && alreadyHaveLast) {
            // Remover log de warning de paginação - não é crítico
          }
        }

        if (!response.issues || response.issues.length === 0) {
          hasMore = false;
          break;
        }

        // Detectar campo de story points na primeira página
        if (!detectedStoryPointField && response.issues.length > 0) {
          const storyPointFields = [
            "customfield_10002", "customfield_10004", "customfield_10005", "customfield_10006",
            "customfield_10007", "customfield_10008", "customfield_10016", "customfield_10020"
          ];
          
          for (const issue of response.issues) {
            for (const fieldName of storyPointFields) {
              const spField = issue.fields[fieldName];
              if (spField !== null && spField !== undefined) {
                // Verificar se tem valor válido
                let hasValue = false;
                if (typeof spField === 'number' && !isNaN(spField) && spField > 0) {
                  hasValue = true;
                } else if (typeof spField === 'string' && parseFloat(spField) > 0) {
                  hasValue = true;
                } else if (typeof spField === 'object') {
                  if (Array.isArray(spField) && spField.length > 0) {
                    hasValue = true;
                  } else if (spField.value !== undefined || spField.points !== undefined) {
                    hasValue = true;
                  }
                }
                
                if (hasValue) {
                  detectedStoryPointField = fieldName;
                  // Remover log detalhado - informação não crítica durante processamento
                  break;
                }
              }
            }
            if (detectedStoryPointField) break;
          }
        }

        // Remover duplicatas durante a paginação para evitar acumular muitas issues duplicadas
        const existingKeys = new Set(allIssues.map(issue => issue.key));
        const newIssues = response.issues.filter(issue => !existingKeys.has(issue.key));
        
        if (newIssues.length !== response.issues.length) {
          const duplicatesInPage = response.issues.length - newIssues.length;
          // Remover log de duplicatas - spinner já mostra progresso
        }
        
        allIssues = allIssues.concat(newIssues);
        
        // ✅ CRÍTICO: Sempre incrementar startAt por maxResults (não por response.issues.length)
        // Isso garante que avançamos corretamente na paginação
        // Se incrementarmos por response.issues.length e houver duplicatas, ficaremos presos
        startAt += maxResults;
        
        // Continuar apenas se:
        // 1. Retornou exatamente maxResults (indica que pode haver mais páginas)
        // 2. E há issues novas (não são todas duplicatas)
        hasMore = response.issues.length === maxResults && newIssues.length > 0;
        
        // Se não há issues novas mas retornou issues, pode ser problema na API
        if (newIssues.length === 0 && response.issues.length > 0) {
          // Remover logs de duplicatas - spinner já mostra progresso
          
          // Solução alternativa: buscar por meses individuais quando detectamos problema de paginação
          // Isso evita o problema de paginação da API quando há muitas issues
          if (year && currentPage === 2 && allIssues.length >= 100) {
            // Remover log detalhado - spinner já mostra progresso
            
            const monthlyIssues = [];
            const existingKeysSet = new Set(allIssues.map(issue => issue.key));
            
            // Buscar por cada mês do ano (mais confiável que paginação global)
            // Buscar sequencialmente para evitar sobrecarregar a API (mas mais rápido que paginação com duplicatas)
            for (let month = 1; month <= 12; month++) {
              const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
              const monthEnd = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');
              
              try {
                const monthJql = `${assigneeCl} AND resolutiondate >= "${monthStart}" AND resolutiondate <= "${monthEnd}" AND statusCategory = Done ORDER BY resolutiondate DESC`;
                
                const monthResponse = await makeApiRequest(url, auth, {
                  params: {
                    jql: monthJql,
                    maxResults: 1000, // Buscar todas do mês de uma vez
                    fields: "key,summary,created,resolutiondate,status,issuetype,project,customfield_10002,customfield_10004,customfield_10005,customfield_10006,customfield_10007,customfield_10008,customfield_10016,customfield_10020,changelog,timetracking,aggregatetimespent",
                    expand: "changelog"
                  },
                  timeout: 20000 // Timeout menor para meses individuais (mais rápido)
                });
                
                if (monthResponse.issues && monthResponse.issues.length > 0) {
                  const monthNewIssues = monthResponse.issues.filter(issue => !existingKeysSet.has(issue.key));
                  if (monthNewIssues.length > 0) {
                    monthlyIssues.push(...monthNewIssues);
                    // Adicionar keys ao set para evitar duplicatas entre meses
                    monthNewIssues.forEach(issue => existingKeysSet.add(issue.key));
                    // Remover log detalhado - spinner já mostra progresso
                  }
                }
              } catch (monthError) {
                // Não mostrar erro para meses sem issues (timeout pode ser normal se não há issues)
                if (!monthError.message.includes('timeout')) {
                  // Remover log de erro detalhado - spinner já mostra progresso
                }
              }
            }
            
            if (monthlyIssues.length > 0) {
              // Remover log detalhado - spinner já mostra progresso
              allIssues = allIssues.concat(monthlyIssues);
              // Não continuar paginação normal, já temos todas as issues dos meses
              hasMore = false;
              break;
            } else {
              // Remover log detalhado - spinner já mostra progresso
            }
          }
          
          hasMore = false; // Parar para evitar loop infinito
        }
        
        // Debug adicional: mostrar progresso real
        if (currentPage % 5 === 0 || newIssues.length === 0) {
          // Remover log de progresso detalhado - spinner já mostra progresso
        }
      } catch (pageError) {
        // Remover log de erro detalhado - spinner já mostra progresso
        // Se der erro, continua com o que já foi buscado
        hasMore = false;
      }
    }
    
    // Remover logs de limite e total - spinner já mostra progresso

    // Remover duplicatas por issue key antes de processar
    const uniqueIssuesMap = new Map();
    for (const issue of allIssues) {
      if (!uniqueIssuesMap.has(issue.key)) {
        uniqueIssuesMap.set(issue.key, issue);
      }
    }
    const uniqueAllIssues = Array.from(uniqueIssuesMap.values());
    
    if (uniqueAllIssues.length !== allIssues.length) {
      const duplicatesRemoved = allIssues.length - uniqueAllIssues.length;
      // Remover log de duplicatas - spinner já mostra progresso
    }

    // Processar cada issue com métricas detalhadas
    return uniqueAllIssues.map((issue) => {
      // Extrair story points usando função auxiliar que tenta múltiplos campos
      const storyPoints = extractStoryPoints(issue.fields);
      const cycleTimeData = calculateCycleTime(issue);
      const cycleTime = typeof cycleTimeData === 'object' ? cycleTimeData.cycleTimeDays : cycleTimeData;
      const cycleTimePerStoryPoint = storyPoints > 0 ? cycleTime / storyPoints : 0;
      
      const isDone = issue.fields.status?.statusCategory?.key === 'done';
      const created = dayjs(issue.fields.created);
      const resolved = issue.fields.resolutiondate ? dayjs(issue.fields.resolutiondate) : null;
      
      // Extrair informação de sprint
      // CORREÇÃO: O campo correto é customfield_10007, não customfield_10020
      // Verificado através de inspeção da API: Field ID no changelog é customfield_10007
      const sprints = issue.fields.customfield_10007 || issue.fields.customfield_10020 || [];
      let sprintName = 'Sem Sprint';
      let sprintId = 'none';
      let sprintStartDate = null;
      let sprintEndDate = null;
      let sprintState = null;
      
      // Sprint onde foi criada (primeira sprint)
      let sprintCreatedName = 'Sem Sprint';
      let sprintCreatedId = 'none';
      
      // Sprint onde foi finalizada (última sprint - onde está agora)
      let sprintResolvedName = 'Sem Sprint';
      let sprintResolvedId = 'none';
      
      /**
       * Função auxiliar para extrair informações completas de um sprint
       * Inclui: nome, id, startDate, endDate, state
       */
      const extractSprintInfo = (sprint) => {
        let name = 'Sem Sprint';
        let id = 'none';
        let startDate = null;
        let endDate = null;
        let state = null;
        
        if (typeof sprint === 'object' && sprint !== null) {
          name = sprint.name || name;
          id = sprint.id?.toString() || id;
          startDate = sprint.startDate || null;
          endDate = sprint.endDate || sprint.completeDate || null;
          state = sprint.state || null;
          
          if (name === 'Sem Sprint' && sprint.value) {
            name = sprint.value;
          }
          if (id === 'none' && sprint.key) {
            id = sprint.key;
          }
        } else if (typeof sprint === 'string') {
          // Parse string format: "com.atlassian.greenhopper.service.sprint.Sprint@xxx[id=123,name=Sprint 1,startDate=2025-01-01,endDate=2025-01-14]"
          const nameMatch = sprint.match(/name=([^,\]]+)/);
          const idMatch = sprint.match(/id=(\d+)/);
          const startDateMatch = sprint.match(/startDate=([^,\]]+)/);
          const endDateMatch = sprint.match(/endDate=([^,\]]+)/);
          const stateMatch = sprint.match(/state=([^,\]]+)/);
          
          if (nameMatch) name = nameMatch[1].trim();
          if (idMatch) id = idMatch[1];
          if (startDateMatch) startDate = startDateMatch[1].trim();
          if (endDateMatch) endDate = endDateMatch[1].trim();
          if (stateMatch) state = stateMatch[1].trim();
        }
        
        return { name, id, startDate, endDate, state };
      };
      
      if (sprints.length > 0) {
        // Sprint atual (última) - para compatibilidade
        const currentSprintInfo = extractSprintInfo(sprints[sprints.length - 1]);
        sprintName = currentSprintInfo.name;
        sprintId = currentSprintInfo.id;
        sprintStartDate = currentSprintInfo.startDate;
        sprintEndDate = currentSprintInfo.endDate;
        sprintState = currentSprintInfo.state;
        
        // Sprint onde foi criada (primeira do array)
        const firstSprintInfo = extractSprintInfo(sprints[0]);
        sprintCreatedName = firstSprintInfo.name;
        sprintCreatedId = firstSprintInfo.id;
        
        // Sprint onde foi finalizada (última do array)
        sprintResolvedName = currentSprintInfo.name;
        sprintResolvedId = currentSprintInfo.id;
      }
      
      // Detectar quando foi adicionada à sprint através do changelog
      const addedToSprintAt = detectAddedToSprintDate(issue);
      
      // Extrair histórico completo de sprints (para análise de planejamento)
      const sprintHistory = extractSprintHistory(issue);
      
      // Detectar períodos de bloqueio
      const blockPeriods = detectBlockPeriods(issue);
      const totalBlockHours = blockPeriods.reduce((sum, period) => {
        return sum + (period.durationHours || 0);
      }, 0);
      const firstBlockDate = blockPeriods.length > 0 ? blockPeriods[0].blockedAt : null;
      const lastUnblockDate = blockPeriods.length > 0 && blockPeriods[blockPeriods.length - 1].unblockedAt 
        ? blockPeriods[blockPeriods.length - 1].unblockedAt 
        : null;
      const isCurrentlyBlocked = blockPeriods.length > 0 && blockPeriods[blockPeriods.length - 1].unblockedAt === null;
      
      // Decompor workflow em etapas
      const workflow = decomposeWorkflow(issue);
      if (typeof cycleTimeData === 'object' && cycleTimeData.startedAt && !workflow.inProgressAt) {
        applyExecutionProxyToWorkflow(workflow, new Date(cycleTimeData.startedAt));
      }
      
      // Detectar reaberturas
      const reopens = detectReopens(issue);
      
      // Extrair dependências
      const dependencies = extractDependencies(issue);
      
      // Classificar tipo de trabalho
      const workType = classifyWorkType(issue.fields.issuetype?.name || 'Task');
      
      // Extrair prioridade
      const priority = issue.fields.priority?.name || 'N/A';
      
      // Analisar tempo em cada status
      const statusAnalysis = analyzeStatusTime(issue);
      
      // Analisar mudanças de assignee
      const assigneeAnalysis = analyzeAssigneeChanges(issue);
      
      // Extrair informações temporais detalhadas
      // Criar objeto temporário com cycleTimeStartedAt para extractTemporalInfo
      const issueWithCycleTime = {
        fields: issue.fields,
        cycleTimeStartedAt: (typeof cycleTimeData === 'object' && cycleTimeData.startedAt) 
          ? cycleTimeData.startedAt 
          : null
      };
      const temporalInfo = extractTemporalInfo(issueWithCycleTime);
      
      // Analisar comentários
      const commentsAnalysis = analyzeComments(issue);
      
      // Extrair Epic, Labels, Components
      const epic = issue.fields.epic?.name || issue.fields.epic?.key || null;
      const labels = (issue.fields.labels || []).map(l => typeof l === 'string' ? l : l.name || l);
      const components = (issue.fields.components || []).map(c => c.name || c);
      const fixVersions = (issue.fields.fixVersions || []).map(v => v.name || v);
      
      const createdRaw = issue.fields.created;
      const resolvedRaw = issue.fields.resolutiondate;
      const cycleStartRaw =
        typeof cycleTimeData === 'object' && cycleTimeData.startedAt ? cycleTimeData.startedAt : null;
      let leadTimeDays = null;
      if (createdRaw && resolvedRaw) {
        const c0 = new Date(createdRaw);
        const c1 = new Date(resolvedRaw);
        if (c1 > c0) {
          leadTimeDays = parseFloat((((c1 - c0) / (1000 * 60 * 60 * 24))).toFixed(2));
        }
      }
      let idleBeforeWorkDays = null;
      if (createdRaw && cycleStartRaw) {
        const c0 = new Date(createdRaw);
        const cs = cycleStartRaw instanceof Date ? cycleStartRaw : new Date(cycleStartRaw);
        if (cs >= c0) {
          idleBeforeWorkDays = parseFloat((((cs - c0) / (1000 * 60 * 60 * 24))).toFixed(2));
        }
      }
      
      return {
        key: issue.key,
        projectKey: issue.fields.project?.key || '',
        projectName: issue.fields.project?.name || '',
        summary: issue.fields.summary,
        type: issue.fields.issuetype?.name || 'Task',
        status: issue.fields.status?.name || 'Unknown',
        statusCategory: issue.fields.status?.statusCategory?.name || 'Unknown',
        isDone,
        created: created.format("YYYY-MM-DD"),
        createdMonth: created.format("YYYY-MM"),
        resolved: resolved ? resolved.format("YYYY-MM-DD") : null,
        resolvedMonth: resolved ? resolved.format("YYYY-MM") : null,
        sprintName,
        sprintId,
        sprintStartDate: sprintStartDate ? dayjs(sprintStartDate).format("YYYY-MM-DD") : null,
        sprintEndDate: sprintEndDate ? dayjs(sprintEndDate).format("YYYY-MM-DD") : null,
        sprintState,
        // Sprint onde foi criada (primeira sprint)
        sprintCreatedName,
        sprintCreatedId,
        // Sprint onde foi finalizada (última sprint)
        sprintResolvedName,
        sprintResolvedId,
        storyPoints,
        cycleTime: typeof cycleTimeData === 'object' ? cycleTimeData.cycleTimeDays : cycleTimeData, // em dias (será convertido para horas depois)
        cycleTimePerStoryPoint,
        daysOpen: resolved ? resolved.diff(created, 'days') : dayjs().diff(created, 'days'),
        timeSpent: issue.fields.aggregatetimespent ? issue.fields.aggregatetimespent / 3600 : 0, // converter segundos para horas
        addedToSprintAt: addedToSprintAt ? dayjs(addedToSprintAt).format("YYYY-MM-DD") : null, // Data em que foi adicionada à sprint
        cycleTimeStartedAt: (typeof cycleTimeData === 'object' && cycleTimeData.startedAt) ? dayjs(cycleTimeData.startedAt).format("YYYY-MM-DD HH:mm") : null, // Quando começou o trabalho
        cycleTimeDoneAt: (typeof cycleTimeData === 'object' && cycleTimeData.doneAt) ? dayjs(cycleTimeData.doneAt).format("YYYY-MM-DD HH:mm") : null, // Quando foi concluído
        cycleTimeSource: typeof cycleTimeData === 'object' ? (cycleTimeData.source || '') : '',
        ctHadActiveTransition: typeof cycleTimeData === 'object' ? !!cycleTimeData.hadActiveTransition : false,
        ctProxyKind: typeof cycleTimeData === 'object' ? (cycleTimeData.proxyKind || null) : null,
        /** Tempo de vida até conclusão (criado → resolvido), dias. */
        leadTimeDays,
        /** Tempo parado antes do início do CT (criado → cycleTimeStartedAt), dias. */
        idleBeforeWorkDays,
        // Informações de bloqueio
        blockPeriods: blockPeriods.map(period => ({
          blockedAt: dayjs(period.blockedAt).format("YYYY-MM-DD HH:mm"),
          unblockedAt: period.unblockedAt ? dayjs(period.unblockedAt).format("YYYY-MM-DD HH:mm") : null,
          durationHours: period.durationHours
        })),
        totalBlockHours: totalBlockHours,
        firstBlockDate: firstBlockDate ? dayjs(firstBlockDate).format("YYYY-MM-DD HH:mm") : null,
        lastUnblockDate: lastUnblockDate ? dayjs(lastUnblockDate).format("YYYY-MM-DD HH:mm") : null,
        isCurrentlyBlocked: isCurrentlyBlocked,
        blockedCount: blockPeriods.length,
        // Workflow decomposition
        workflow: {
          toDoAt: workflow.toDoAt ? dayjs(workflow.toDoAt).format("YYYY-MM-DD HH:mm") : null,
          inProgressAt: workflow.inProgressAt ? dayjs(workflow.inProgressAt).format("YYYY-MM-DD HH:mm") : null,
          inReviewAt: workflow.inReviewAt ? dayjs(workflow.inReviewAt).format("YYYY-MM-DD HH:mm") : null,
          qaAt: workflow.qaAt ? dayjs(workflow.qaAt).format("YYYY-MM-DD HH:mm") : null,
          readyForReleaseAt: workflow.readyForReleaseAt ? dayjs(workflow.readyForReleaseAt).format("YYYY-MM-DD HH:mm") : null,
          doneAt: workflow.doneAt ? dayjs(workflow.doneAt).format("YYYY-MM-DD HH:mm") : null,
          devTimeDays: workflow.devTimeDays,
          reviewTimeDays: workflow.reviewTimeDays,
          qaTimeDays: workflow.qaTimeDays,
          waitForReleaseDays: workflow.waitForReleaseDays,
          activeTimeDays: workflow.activeTimeDays,
          totalTimeDays: workflow.totalTimeDays,
          queueTimeDays: workflow.queueTimeDays,
          touchTimeDays: Math.max(0, workflow.activeTimeDays - (totalBlockHours / 24)),
          get waitTimeDays() { return Math.max(0, this.totalTimeDays - this.touchTimeDays); },
          get flowEfficiency() { return this.totalTimeDays > 0 ? (this.touchTimeDays / this.totalTimeDays) * 100 : 0; }
        },
        // Brooks (Mythical Man-Month) & Jocko (Extreme Ownership) metrics
        tooManyCooks: assigneeAnalysis.assigneeCount > 3,
        communicationComplexity: assigneeAnalysis.assigneeCount * assigneeAnalysis.handoffCount,
        // Elite planning & engineering metrics
        // sprintCount: Nicole Forsgren (DORA/Accelerate) - Sprint Slippage
        sprintCount: sprintHistory.length,
        // isScopeCreep: John Doerr (Measure What Matters) - Unplanned Work
        isScopeCreep: (addedToSprintAt && sprintStartDate) ? dayjs(addedToSprintAt).isAfter(dayjs(sprintStartDate)) : false,
        // predictabilityIndex: Daniel Vacanti (Actionable Agile Metrics) - Slicing Health
        get predictabilityIndex() { 
          const ct = typeof cycleTimeData === 'object' ? cycleTimeData.cycleTimeDays : cycleTimeData;
          return (storyPoints > 0 && ct > 0) ? storyPoints / ct : 0; 
        },
        // reviewLatencyDays: Martin Fowler (Continuous Integration) - Feedback Loop Latency
        reviewLatencyDays: workflow.reviewTimeDays,
        // Reopens (reabertura após Done)
        reopens: {
          reopenCount: reopens.reopenCount,
          wasReopened: reopens.wasReopened,
          reopenDates: reopens.reopenDates.map(d => dayjs(d).format("YYYY-MM-DD HH:mm")),
          lastReopenDate: reopens.lastReopenDate ? dayjs(reopens.lastReopenDate).format("YYYY-MM-DD HH:mm") : null,
          // Rework (sub-bug/correção - retrabalho interno)
          reworkCount: reopens.reworkCount,
          hadRework: reopens.hadRework,
          reworkDates: reopens.reworkDates.map(d => dayjs(d).format("YYYY-MM-DD HH:mm")),
          lastReworkDate: reopens.lastReworkDate ? dayjs(reopens.lastReworkDate).format("YYYY-MM-DD HH:mm") : null
        },
        // Dependencies
        dependencies: {
          hasDependencies: dependencies.hasDependencies,
          blocksCount: dependencies.blocksCount,
          blockedByCount: dependencies.blockedByCount,
          relatesToCount: dependencies.relatesToCount,
          duplicatesCount: dependencies.duplicatesCount,
          clonesCount: dependencies.clonesCount,
          clonedByCount: dependencies.clonedByCount,
          isBlocked: dependencies.isBlocked,
          blocks: dependencies.blocks,
          blockedBy: dependencies.blockedBy,
          relatesTo: dependencies.relatesTo,
          duplicates: dependencies.duplicates,
          clones: dependencies.clones,
          clonedBy: dependencies.clonedBy,
          linkedIssues: dependencies.linkedIssues
        },
        // Work type classification
        workType: workType,
        lane: classifyLane(issue.fields.issuetype?.name || 'Task', issue.fields.parent?.fields?.issuetype?.name || null),
        priority: priority,
        // Parent (hierarchy)
        parentKey: issue.fields.parent?.key || null,
        parentType: issue.fields.parent?.fields?.issuetype?.name || null,
        // Status analysis
        statusTime: statusAnalysis.statusTime,
        statusHistory: statusAnalysis.statusHistory.map(s => ({
          status: s.status,
          start: dayjs(s.start).format("YYYY-MM-DD HH:mm"),
          end: s.end ? dayjs(s.end).format("YYYY-MM-DD HH:mm") : null,
          durationDays: s.durationDays || 0
        })),
        totalStatusChanges: statusAnalysis.totalStatusChanges,
        statusTransitions: statusAnalysis.statusTransitions,
        // Assignee analysis
        assigneeCount: assigneeAnalysis.assigneeCount,
        assigneeHistory: assigneeAnalysis.assigneeHistory,
        assigneeTime: assigneeAnalysis.assigneeTime,
        handoffCount: assigneeAnalysis.handoffCount,
        // Temporal information
        temporalInfo: temporalInfo,
        // Comments analysis
        comments: commentsAnalysis,
        // Context information
        epic: epic,
        labels: labels,
        components: components,
        fixVersions: fixVersions,
        // Sprint history (para análise de planejamento - uma linha por sprint)
        sprintHistory: sprintHistory.map(sh => ({
          sprintId: sh.sprintId,
          sprintName: sh.sprintName,
          sprintStartDate: sh.sprintStartDate ? dayjs(sh.sprintStartDate).format("YYYY-MM-DD") : null,
          sprintEndDate: sh.sprintEndDate ? dayjs(sh.sprintEndDate).format("YYYY-MM-DD") : null,
          sprintState: sh.sprintState,
          addedAt: sh.addedAt ? dayjs(sh.addedAt).format("YYYY-MM-DD") : null,
          removedAt: sh.removedAt ? dayjs(sh.removedAt).format("YYYY-MM-DD") : null,
          wasRemoved: sh.wasRemoved || false
        }))
      };
    });
  } catch (error) {
    console.error("❌ Erro ao buscar histórico de tasks:", error.message);
    
    // Se for erro 410, pode ser JQL inválido. Tentar uma query mais simples
    if (error.response?.status === 410) {
      // Remover log detalhado - spinner já mostra progresso
      try {
        // Query mais simples sem resolutiondate
        // ✅ Usando nova API: /rest/api/3/search/jql
        const simpleJql = `${assigneeCl} AND created >= -${months * 30}d ORDER BY created DESC`;
        const fallbackUrl = `${JIRA_BASE_URL}/rest/api/3/search/jql`;
        const response = await makeApiRequest(fallbackUrl, auth, {
          params: { 
            jql: simpleJql,
            maxResults: 100,
            fields: "key,summary,created,resolutiondate,status,issuetype,customfield_10002,customfield_10020"
          }
        });
        
        if (response.issues && response.issues.length > 0) {
          // Remover log detalhado - spinner já mostra progresso
          // Processar com dados básicos
          return response.issues.map((issue) => {
            const storyPoints = extractStoryPoints(issue.fields);
            const isDone = issue.fields.status?.statusCategory?.key === 'done';
            const created = dayjs(issue.fields.created);
            const resolved = issue.fields.resolutiondate ? dayjs(issue.fields.resolutiondate) : null;
            
            // Extrair sprint
            const sprints = issue.fields.customfield_10020 || [];
            let sprintName = 'Sem Sprint';
            let sprintId = 'none';
            
            if (sprints.length > 0) {
              const currentSprint = sprints[sprints.length - 1];
              
              if (typeof currentSprint === 'object' && currentSprint?.name) {
                sprintName = currentSprint.name;
                sprintId = currentSprint.id || 'none';
              } else if (typeof currentSprint === 'string') {
                const nameMatch = currentSprint.match(/name=([^,\]]+)/);
                const idMatch = currentSprint.match(/id=(\d+)/);
                if (nameMatch) sprintName = nameMatch[1];
                if (idMatch) sprintId = idMatch[1];
              }
            }
            
            return {
              key: issue.key,
              summary: issue.fields.summary,
              type: issue.fields.issuetype?.name || 'Task',
              status: issue.fields.status?.name || 'Unknown',
              statusCategory: issue.fields.status?.statusCategory?.name || 'Unknown',
              isDone,
              created: created.format("YYYY-MM-DD"),
              createdMonth: created.format("YYYY-MM"),
              resolved: resolved ? resolved.format("YYYY-MM-DD") : null,
              resolvedMonth: resolved ? resolved.format("YYYY-MM") : null,
              sprintName,
              sprintId,
              storyPoints,
              cycleTime: 0, // sem changelog, não podemos calcular
              cycleTimePerStoryPoint: 0,
              daysOpen: resolved ? resolved.diff(created, 'days') : dayjs().diff(created, 'days'),
              timeSpent: 0
            };
          });
        }
      } catch (fallbackError) {
        console.error("❌ Query simplificada também falhou:", fallbackError.message);
      }
    }
    
    return [];
  }
}

/**
 * Formata a data e calcula o tempo em dias.
 * @param {string} createdDate - Data de criação no formato ISO.
 * @returns {{ startDate: string, daysOpen: number }}
 */
function calcularTempoAberto(createdDate) {
  const startDate = dayjs(createdDate).format("DD/MM/YYYY");
  const daysOpen = dayjs().diff(dayjs(createdDate), "day");
  return { startDate, daysOpen };
}

/**
 * Busca todas as tasks abertas em um sprint específico.
 * @param {string} sprintName - Nome do sprint.
 * @returns {Promise<Array<{ key: string, summary: string, description: string, assignee: string, startDate: string, endDate: string, daysOpen: number, storyPoints: number, cycleTime: number, cycleTimePerStoryPoint: number }>>}
 */
export async function buscarTasksPorSprint(sprintName) {
  if (!validarCredenciais()) return [];

  // ✅ NOVA API: /rest/api/3/search/jql
  const url = `${JIRA_BASE_URL}/rest/api/3/search/jql`;
  const auth = { username: JIRA_USER, password: JIRA_TOKEN };

  try {
    console.log(`🔍 Fetching tasks for sprint: "${sprintName}"`);
    
    // We're requesting all issues in the sprint, including completed ones
    const jql = `sprint = "${sprintName}"`;
    
    // Request all fields to ensure we get all necessary data
    const response = await makeApiRequest(url, auth, {
      params: { 
        jql,
        expand: "changelog",
        fields: "*all" // Request all fields
      }
    });

    console.log(`✅ Found ${response.issues?.length || 0} issues in sprint "${sprintName}"`);
    
    // Process and return with guaranteed summary fields
    return response.issues.map((issue) => {
      const { startDate, daysOpen } = calcularTempoAberto(issue.fields.created);
      const endDate = issue.fields.resolutiondate
        ? dayjs(issue.fields.resolutiondate).format("DD/MM/YYYY")
        : "Em aberto";
      
      // Get story points with fallback options
      let storyPoints = issue.fields.customfield_10002 || 0;
      if (storyPointsField && issue.fields[storyPointsField] !== undefined) {
        storyPoints = parseFloat(issue.fields[storyPointsField]) || 0;
      } else {
        // Attempt to find story points in different fields
        for (const [key, value] of Object.entries(issue.fields)) {
          if (
            typeof value === 'number' && 
            !isNaN(value) && 
            (key.includes('story') || key.includes('point') || 
             key.includes('customfield_100') || key.includes('estimate'))
          ) {
            storyPoints = value;
            break;
          }
        }
      }

      const cycleTimeData = calculateCycleTime(issue);
      const cycleTime = typeof cycleTimeData === 'object' ? cycleTimeData.cycleTimeDays : cycleTimeData;
      const cycleTimePerStoryPoint = storyPoints > 0 ? cycleTime / storyPoints : 0;
      
      return {
        key: issue.key,
        summary: issue.fields.summary || "No title available", // Ensure summary is always present
        description: issue.fields.description?.content
          ?.map((block) => block.content?.map((text) => text.text).join(" "))
          .join("\n") || "Sem descrição.",
        assignee: issue.fields.assignee?.displayName || "Unassigned",
        startDate,
        endDate,
        daysOpen,
        status: issue.fields.status?.name || "Unknown",
        storyPoints,
        cycleTime,
        cycleTimePerStoryPoint,
        priority: issue.fields.priority?.name || "None",
        issueType: issue.fields.issuetype?.name || "Unknown"
      };
    });
  } catch (error) {
    console.error("❌ Erro ao buscar tasks por sprint:", error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
    }
    return [];
  }
}

/**
 * Detecta status "Done" (inclui PT: Solicitação Concluída, Concluída, etc.).
 */
function statusLooksDone(statusName) {
  const s = (statusName || '').toLowerCase();
  if (!s) return false;
  const markers = [
    'done', 'conclu', 'resolvido', 'fechado', 'closed', 'completed',
    'finaliz', 'entregue', 'merged', 'released', 'feito'
  ];
  return markers.some((m) => s.includes(m));
}

/** Normaliza nome de status para casar "To-Do" / "to do" / "IN PROGRESS (QA)". */
function normalizeWorkflowStatus(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Primeiro instante em que a issue ganhou assignee não vazio (changelog).
 */
function getFirstAssigneeAt(issue) {
  if (!issue.changelog?.histories?.length) {
    const name = issue.fields.assignee?.displayName || issue.fields.assignee?.name;
    if (name && String(name).trim() && name !== 'Unassigned') {
      return issue.fields.created ? new Date(issue.fields.created) : null;
    }
    return null;
  }
  const histories = [...issue.changelog.histories].sort(
    (a, b) => new Date(a.created) - new Date(b.created)
  );
  for (const history of histories) {
    if (!history.items) continue;
    for (const item of history.items) {
      if (item.field !== 'assignee') continue;
      const to = String(item.toString || item.to || '').trim();
      if (to && to !== 'Unassigned' && to !== 'null') {
        return new Date(history.created);
      }
    }
  }
  const name = issue.fields.assignee?.displayName || issue.fields.assignee?.name;
  if (name && String(name).trim() && name !== 'Unassigned') {
    return issue.fields.created ? new Date(issue.fields.created) : null;
  }
  return null;
}

/**
 * Proxy auditável quando não há transição explícita para status ativo: max(assignee, sprint) se ambos existem.
 * @returns {{ at: Date, source: string } | null}
 */
function getExecutionStartProxy(issue) {
  const tAssignee = getFirstAssigneeAt(issue);
  const tSprint = detectAddedToSprintDate(issue);
  if (tAssignee && tSprint) {
    const at = tAssignee > tSprint ? tAssignee : tSprint;
    return { at, source: 'proxy_assignee_sprint' };
  }
  if (tAssignee) {
    return { at: tAssignee, source: 'proxy_assignee_only' };
  }
  if (tSprint) {
    return { at: tSprint, source: 'proxy_sprint_only' };
  }
  return null;
}

/**
 * Recalcula fila/dev quando há proxy de início (ex.: Backlog → Concluído sem "In Progress").
 */
function applyExecutionProxyToWorkflow(workflow, inProgressAtDate) {
  if (!inProgressAtDate || !workflow.doneAt) return;
  workflow.inProgressAt = inProgressAtDate;
  if (workflow.toDoAt && workflow.inProgressAt) {
    workflow.queueTimeDays = (workflow.inProgressAt - workflow.toDoAt) / (1000 * 60 * 60 * 24);
  }
  if (workflow.inProgressAt && workflow.inReviewAt) {
    workflow.devTimeDays = (workflow.inReviewAt - workflow.inProgressAt) / (1000 * 60 * 60 * 24);
  } else if (workflow.inProgressAt && workflow.qaAt) {
    workflow.devTimeDays = (workflow.qaAt - workflow.inProgressAt) / (1000 * 60 * 60 * 24);
  } else if (workflow.inProgressAt && workflow.doneAt) {
    workflow.devTimeDays = (workflow.doneAt - workflow.inProgressAt) / (1000 * 60 * 60 * 24);
  }
  workflow.activeTimeDays = workflow.devTimeDays + workflow.reviewTimeDays + workflow.qaTimeDays;
  if (workflow.toDoAt && workflow.doneAt) {
    workflow.totalTimeDays = (workflow.doneAt - workflow.toDoAt) / (1000 * 60 * 60 * 24);
  }
}

/**
 * Calcula o cycle time de uma issue com base nas mudanças de status.
 * Cycle Time = tempo entre primeira transição de status "não ativo" → status "ativo" até Done
 * Início: primeira transição de "To Do"/"Backlog"/"Aberto" para "In Progress"/"Doing"/etc
 * Fim: momento em que entra em "Done"/"Concluído"/etc
 * @param {Object} issue - O objeto issue com changelog expandido.
 * @returns {Object} - { cycleTimeDays, startedAt, doneAt, source, hadActiveTransition, proxyKind }
 */
function calculateCycleTime(issue) {
  // Lista configurável de status não ativos (inicial)
  const INACTIVE_STATUSES = [
    'to do', 'backlog', 'aberto', 'open', 'new', 'novo',
    'aguardando', 'waiting', 'blocked', 'bloqueado'
  ];
  
  // Lista configurável de status ativos (trabalho em progresso)
  const ACTIVE_STATUSES = [
    'in progress', 'em progresso', 'doing', 'em desenvolvimento', 
    'desenvolvendo', 'working', 'active', 'development',
    'em andamento', 'andamento', 'em trabalho', 'trabalhando'
  ];
  
  // Lista configurável de status finais (concluído)
  const DONE_STATUSES = [
    'done', 'concluído', 'concluido', 'resolvido', 'fechado', 
    'closed', 'completed', 'finalizado', 'entregue', 'merged', 
    'released', 'feito', 'resolved'
  ];
  
  if (!issue.changelog || !issue.changelog.histories || issue.changelog.histories.length === 0) {
    // Se não tem changelog, tentar usar fallback baseado em created e resolutiondate
    const doneDate = issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate) : null;
    const createdDate = issue.fields.created ? new Date(issue.fields.created) : null;
    
    // Fallback: usar created → resolutiondate como cycle time aproximado
    // Isso é menos preciso mas melhor que zero quando não há changelog
    if (doneDate && createdDate && doneDate > createdDate) {
      const proxy = getExecutionStartProxy(issue);
      if (proxy && proxy.at >= createdDate && doneDate > proxy.at) {
        const cycleDays = (doneDate - proxy.at) / (1000 * 60 * 60 * 24);
        if (cycleDays > 0) {
          return {
            cycleTimeDays: cycleDays,
            startedAt: proxy.at,
            doneAt: doneDate,
            source: proxy.source,
            hadActiveTransition: false,
            proxyKind: proxy.source.replace(/^proxy_/, '')
          };
        }
      }
      const cycleDays = (doneDate - createdDate) / (1000 * 60 * 60 * 24);
      if (cycleDays > 0) {
        return {
          cycleTimeDays: cycleDays,
          startedAt: createdDate,
          doneAt: doneDate,
          source: 'fallback_no_changelog_created',
          hadActiveTransition: false,
          proxyKind: null
        };
      }
    }
    
    return { cycleTimeDays: 0, startedAt: null, doneAt: null, source: 'none', hadActiveTransition: false, proxyKind: null };
  }
  
  let firstActiveStatusDate = null;
  let doneDate = null;
  let lastInactiveStatus = null;

  // Ordenar históricos por data (mais antigo primeiro)
  const histories = [...issue.changelog.histories].sort((a, b) => 
    new Date(a.created) - new Date(b.created)
  );
  
  // Verificar status inicial da issue
  const initialStatusNorm = normalizeWorkflowStatus(issue.fields.status?.name);
  const isInitialActive = ACTIVE_STATUSES.some((status) => initialStatusNorm.includes(status));
  const isInitialDone = statusLooksDone(issue.fields.status?.name);
  
  // Se foi criada já em status ativo, usar created como início
  if (isInitialActive && !isInitialDone && issue.fields.created) {
    firstActiveStatusDate = new Date(issue.fields.created);
  }
  
  // Procurar transições de status no changelog
  for (const history of histories) {
    const statusChanges = history.items.filter(item => item.field === 'status');
    
    for (const change of statusChanges) {
      const fromNorm = normalizeWorkflowStatus(change.fromString);
      const toNorm = normalizeWorkflowStatus(change.toString);
      const changeTime = new Date(history.created);
      
      // Detectar primeira transição de status não ativo → status ativo
      if (!firstActiveStatusDate) {
        const fromIsInactive = INACTIVE_STATUSES.some((status) => fromNorm.includes(status)) ||
                              fromNorm === '' || fromNorm === 'null';
        const toIsActive = ACTIVE_STATUSES.some((status) => toNorm.includes(status));
        
        if (fromIsInactive && toIsActive) {
          firstActiveStatusDate = changeTime;
        }
      }
      
      // Detectar transição para Done (inclui "Solicitação Concluída", "Concluída", etc.)
      if (!doneDate && statusLooksDone(change.toString)) {
        doneDate = changeTime;
      }
      
      // Rastrear último status não ativo (para fallback)
      if (INACTIVE_STATUSES.some((status) => toNorm.includes(status))) {
        lastInactiveStatus = changeTime;
      }
    }
  }
  
  // Fallback: se não encontrou transição explícita mas tem changelog
  if (!firstActiveStatusDate && issue.fields.created) {
    // Se foi criada em status ativo, usar created
    if (isInitialActive) {
      firstActiveStatusDate = new Date(issue.fields.created);
    } else if (lastInactiveStatus) {
      // Se encontrou um status não ativo no histórico, usar ele como referência
      // Mas só se não encontramos transição explícita
      firstActiveStatusDate = lastInactiveStatus;
    }
  }
  
  // Fallback: usar resolutiondate se não encontrou done date no changelog
  if (!doneDate && issue.fields.resolutiondate) {
    doneDate = new Date(issue.fields.resolutiondate);
  }
  
  // Calcular cycle time apenas se temos ambas as datas válidas
  if (firstActiveStatusDate && doneDate && doneDate > firstActiveStatusDate) {
    const cycleDays = (doneDate - firstActiveStatusDate) / (1000 * 60 * 60 * 24);
    // Retornar qualquer valor positivo (mesmo que pequeno)
    if (cycleDays > 0) {
      return {
        cycleTimeDays: cycleDays,
        startedAt: firstActiveStatusDate,
        doneAt: doneDate,
        source: 'status_active',
        hadActiveTransition: true,
        proxyKind: null
      };
    }
  }
  
  // Sem transição In Progress → Concluído: proxy auditável (assignee/sprint) antes de created→done
  if (!firstActiveStatusDate && doneDate && issue.fields.created) {
    const createdDate = new Date(issue.fields.created);
    const proxy = doneDate > createdDate  ? getExecutionStartProxy(issue) : null;
    if (proxy && proxy.at >= createdDate && doneDate > proxy.at) {
      const cycleDays = (doneDate - proxy.at) / (1000 * 60 * 60 * 24);
      if (cycleDays > 0) {
        return {
          cycleTimeDays: cycleDays,
          startedAt: proxy.at,
          doneAt: doneDate,
          source: proxy.source,
          hadActiveTransition: false,
          proxyKind: proxy.source.replace(/^proxy_/, '')
        };
      }
    }
    if (doneDate > createdDate) {
      const cycleDays = (doneDate - createdDate) / (1000 * 60 * 60 * 24);
      if (cycleDays > 0) {
        return {
          cycleTimeDays: cycleDays,
          startedAt: createdDate,
          doneAt: doneDate,
          source: 'fallback_created_to_resolved',
          hadActiveTransition: false,
          proxyKind: null
        };
      }
    }
  }
  
  return {
    cycleTimeDays: 0,
    startedAt: firstActiveStatusDate || null,
    doneAt: doneDate || null,
    source: 'none',
    hadActiveTransition: false,
    proxyKind: null
  };
}

/**
 * Extrai histórico completo de todas as sprints de uma issue via changelog
 * Retorna lista de sprints com addedAt, removedAt, sprintId, sprintName
 * @param {Object} issue - Issue com changelog expandido
 * @returns {Array<{sprintId: string, sprintName: string, addedAt: Date|null, removedAt: Date|null}>}
 */
function extractSprintHistory(issue) {
  const sprintHistory = new Map(); // Map<sprintId, {sprintName, addedAt, removedAt}>
  
  if (!issue.changelog || !issue.changelog.histories) {
    // Se não tem changelog, usar sprints atuais sem datas
    const currentSprints = issue.fields.customfield_10007 || issue.fields.customfield_10020 || [];
    currentSprints.forEach(sprint => {
      const id = sprint.id?.toString() || 'unknown';
      sprintHistory.set(id, {
        sprintId: id,
        sprintName: sprint.name || 'Unknown Sprint',
        sprintStartDate: sprint.startDate || null,
        sprintEndDate: sprint.endDate || sprint.completeDate || null,
        sprintState: sprint.state || null,
        addedAt: null,
        removedAt: null,
        wasRemoved: false
      });
    });
    return Array.from(sprintHistory.values());
  }
  
  // Ordenar históricos por data (mais antigo primeiro)
  const histories = [...issue.changelog.histories].sort((a, b) => 
    new Date(a.created) - new Date(b.created)
  );
  
  // ✅ CORRIGIDO: Extrair IDs diretamente do campo "from"/"to" do changelog
  // O Jira retorna IDs numéricos separados por vírgula em from/to: "5126, 5658"
  // Não usar fromString/toString que contém apenas nomes!
  const extractSprintIdsFromField = (field) => {
    if (!field) return [];
    // Campo "from"/"to" já contém IDs numéricos separados por vírgula
    const ids = String(field)
      .split(',')
      .map(id => id.trim())
      .filter(id => /^\d+$/.test(id)); // Apenas IDs numéricos válidos
    return ids;
  };
  
  // Função para extrair nome do sprint do fromString/toString
  // O formato é: "Sprint 16. 2025 - BP, Sprint 17. 2025 - BP"
  const extractSprintNameFromString = (str, position = 0) => {
    if (!str) return 'Unknown Sprint';
    const names = str.split(',').map(n => n.trim());
    return names[position] || names[0] || 'Unknown Sprint';
  };
  
  // Mapa de ID → Nome para associar IDs com seus nomes
  const sprintIdToName = new Map();
  
  // Processar cada entrada do changelog
  for (const history of histories) {
    if (!history.items || !Array.isArray(history.items)) continue;
    
    const sprintChanges = history.items.filter(item => {
      const fieldLower = (item.field || '').toLowerCase();
      const fieldId = item.fieldId || '';
      return fieldLower === 'sprint' ||
             fieldId.includes('10007') ||
             fieldId.includes('10020') ||
             fieldId === 'customfield_10007' ||
             fieldId === 'customfield_10020';
    });
    
    for (const change of sprintChanges) {
      // ✅ CORRIGIDO: Usar from/to para IDs (numéricos), fromString/toString para nomes
      const fromField = change.from || '';
      const toField = change.to || '';
      const fromString = change.fromString || '';
      const toString = change.toString || '';
      const changeDate = new Date(history.created);
      
      const fromIds = extractSprintIdsFromField(fromField);
      const toIds = extractSprintIdsFromField(toField);
      
      // Mapear IDs para nomes (baseado na posição, assumindo ordem correspondente)
      const fromNames = fromString.split(',').map(n => n.trim());
      const toNames = toString.split(',').map(n => n.trim());
      
      fromIds.forEach((id, idx) => {
        if (!sprintIdToName.has(id) && fromNames[idx]) {
          sprintIdToName.set(id, fromNames[idx]);
        }
      });
      toIds.forEach((id, idx) => {
        if (!sprintIdToName.has(id) && toNames[idx]) {
          sprintIdToName.set(id, toNames[idx]);
        }
      });
      
      // Sprints removidos (estavam em from mas não em to)
      for (const sprintId of fromIds) {
        if (!toIds.includes(sprintId)) {
          if (sprintHistory.has(sprintId)) {
            const existing = sprintHistory.get(sprintId);
            if (!existing.removedAt) {
              existing.removedAt = changeDate;
              existing.wasRemoved = true;
            }
          } else {
            // ✅ CORRIGIDO: Usar mapa de ID → Nome
            sprintHistory.set(sprintId, {
              sprintId,
              sprintName: sprintIdToName.get(sprintId) || 'Unknown Sprint',
              sprintStartDate: null,
              sprintEndDate: null,
              sprintState: null,
              addedAt: null,
              removedAt: changeDate,
              wasRemoved: true
            });
          }
        }
      }
      
      // Sprints adicionados (estão em to mas não em from)
      for (const sprintId of toIds) {
        if (!fromIds.includes(sprintId)) {
          if (!sprintHistory.has(sprintId)) {
            // ✅ CORRIGIDO: Usar mapa de ID → Nome
            sprintHistory.set(sprintId, {
              sprintId,
              sprintName: sprintIdToName.get(sprintId) || 'Unknown Sprint',
              sprintStartDate: null,
              sprintEndDate: null,
              sprintState: null,
              addedAt: changeDate,
              removedAt: null,
              wasRemoved: false
            });
          } else {
            const existing = sprintHistory.get(sprintId);
            if (!existing.addedAt) {
              existing.addedAt = changeDate;
            }
          }
        }
      }
    }
  }
  
  // Enriquecer com dados atuais das sprints (startDate, endDate, state)
  const currentSprints = issue.fields.customfield_10007 || issue.fields.customfield_10020 || [];
  for (const sprint of currentSprints) {
    const id = sprint.id?.toString();
    if (id && sprintHistory.has(id)) {
      const existing = sprintHistory.get(id);
      existing.sprintStartDate = sprint.startDate || existing.sprintStartDate;
      existing.sprintEndDate = sprint.endDate || sprint.completeDate || existing.sprintEndDate;
      existing.sprintState = sprint.state || existing.sprintState;
      if (!existing.sprintName || existing.sprintName === 'Unknown Sprint') {
        existing.sprintName = sprint.name || existing.sprintName;
      }
    } else if (id) {
      // Sprint atual que não apareceu no changelog (foi criada na sprint)
      sprintHistory.set(id, {
        sprintId: id,
        sprintName: sprint.name || 'Unknown Sprint',
        sprintStartDate: sprint.startDate || null,
        sprintEndDate: sprint.endDate || sprint.completeDate || null,
        sprintState: sprint.state || null,
        addedAt: issue.fields.created ? new Date(issue.fields.created) : null,
        removedAt: null,
        wasRemoved: false
      });
    }
  }
  
  return Array.from(sprintHistory.values());
}

/**
 * Versão async de extractSprintHistory que faz lookup de metadados para sprints sem datas
 * @param {Object} issue - Issue com changelog expandido
 * @returns {Promise<Array>}
 */
async function extractSprintHistoryWithMetadata(issue) {
  // Primeiro extrair histórico básico
  const history = extractSprintHistory(issue);
  
  // Identificar sprints sem datas
  const sprintsWithoutDates = history.filter(
    s => s.sprintId && s.sprintId !== 'none' && !s.sprintStartDate
  );
  
  if (sprintsWithoutDates.length === 0) {
    return history; // Todos têm datas, retornar direto
  }
  
  // Fazer lookup em batch para sprints sem datas
  const idsToLookup = sprintsWithoutDates.map(s => s.sprintId);
  const metadata = await fetchSprintMetadataBatch(idsToLookup);
  
  // Enriquecer com metadados
  for (const sprint of history) {
    if (!sprint.sprintStartDate && metadata.has(sprint.sprintId)) {
      const meta = metadata.get(sprint.sprintId);
      sprint.sprintStartDate = meta.startDate;
      sprint.sprintEndDate = meta.endDate;
      sprint.sprintState = meta.state;
      if (!sprint.sprintName || sprint.sprintName === 'Unknown Sprint') {
        sprint.sprintName = meta.name;
      }
    }
  }
  
  return history;
}

/**
 * ✅ SPRINT DIMENSION: Cria tabela de dimensão de sprint e enriquece todas as issues
 * Coleta todos os sprintIds únicos e faz lookup em batch para garantir 100% de cobertura
 * @param {Array<Object>} issues - Array de issues formatadas
 * @returns {Promise<Map<string, {name: string, startDate: string|null, endDate: string|null, state: string|null}>>}
 */
export async function enrichSprintDimension(issues) {
  // Coletar todos os sprintIds únicos (incluindo sprints do histórico)
  const sprintIds = new Set();
  
  for (const issue of issues) {
    // Sprint atual
    if (issue.sprintId && issue.sprintId !== 'none' && issue.sprintId !== 'unknown') {
      sprintIds.add(String(issue.sprintId));
    }
    
    // Sprints do histórico
    if (issue.sprintHistory && Array.isArray(issue.sprintHistory)) {
      for (const sprint of issue.sprintHistory) {
        if (sprint.sprintId && sprint.sprintId !== 'none' && sprint.sprintId !== 'unknown') {
          sprintIds.add(String(sprint.sprintId));
        }
      }
    }
  }
  
  if (sprintIds.size === 0) {
    return new Map();
  }
  
  console.log(chalk.gray(`   📊 Enriquecendo Sprint Dimension: ${sprintIds.size} sprints únicos...`));
  
  // Fazer lookup em batch (máximo 50 por vez para não sobrecarregar API)
  const sprintDimension = new Map();
  const idsArray = Array.from(sprintIds);
  const batchSize = 50;
  
  for (let i = 0; i < idsArray.length; i += batchSize) {
    const batch = idsArray.slice(i, i + batchSize);
    const batchMetadata = await fetchSprintMetadataBatch(batch);
    
    // Adicionar ao dimension
    for (const [id, meta] of batchMetadata) {
      sprintDimension.set(id, meta);
    }
    
    // Log progresso
    if ((i + batchSize) % 200 === 0 || i + batchSize >= idsArray.length) {
      console.log(chalk.gray(`      ✅ Processados ${Math.min(i + batchSize, idsArray.length)}/${idsArray.length} sprints`));
    }
  }
  
  console.log(chalk.green(`   ✅ Sprint Dimension criada: ${sprintDimension.size} sprints com metadados`));
  
  return sprintDimension;
}

/**
 * Aplica Sprint Dimension a uma issue, preenchendo metadados faltantes
 * @param {Object} issue - Issue formatada
 * @param {Map} sprintDimension - Mapa de sprintId -> metadados
 * @returns {Object} - Issue enriquecida
 */
export function applySprintDimension(issue, sprintDimension) {
  // Enriquecer sprint atual
  if (issue.sprintId && issue.sprintId !== 'none' && sprintDimension.has(String(issue.sprintId))) {
    const meta = sprintDimension.get(String(issue.sprintId));
    if (!issue.sprintStartDate) issue.sprintStartDate = meta.startDate;
    if (!issue.sprintEndDate) issue.sprintEndDate = meta.endDate;
    if (!issue.sprintState) issue.sprintState = meta.state;
    if (!issue.sprintName || issue.sprintName === 'Sem Sprint' || issue.sprintName === 'Unknown Sprint') {
      issue.sprintName = meta.name;
    }
  }
  
  // Enriquecer sprints do histórico
  if (issue.sprintHistory && Array.isArray(issue.sprintHistory)) {
    for (const sprint of issue.sprintHistory) {
      if (sprint.sprintId && sprint.sprintId !== 'none' && sprintDimension.has(String(sprint.sprintId))) {
        const meta = sprintDimension.get(String(sprint.sprintId));
        if (!sprint.sprintStartDate) sprint.sprintStartDate = meta.startDate;
        if (!sprint.sprintEndDate) sprint.sprintEndDate = meta.endDate;
        if (!sprint.sprintState) sprint.sprintState = meta.state;
        if (!sprint.sprintName || sprint.sprintName === 'Unknown Sprint') {
          sprint.sprintName = meta.name;
        }
      }
    }
  }
  
  return issue;
}

/**
 * Detecta quando uma issue foi adicionada à sprint através do changelog
 * O campo Sprint pode aparecer no changelog como "Sprint" ou "customfield_10020"
 * Referência: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/#about
 * @param {Object} issue - Issue com changelog expandido
 * @returns {Date|null} - Data em que foi adicionada à sprint, ou null se não encontrado
 */
function detectAddedToSprintDate(issue) {
  if (!issue.changelog || !issue.changelog.histories) {
    return null;
  }
  
  // Ordenar históricos por data (mais antigo primeiro)
  const histories = [...issue.changelog.histories].sort((a, b) => 
    new Date(a.created) - new Date(b.created)
  );
  
  // Procurar mudanças no campo Sprint de diferentes formas
  for (const history of histories) {
    if (!history.items || !Array.isArray(history.items)) continue;
    
    // Tentar diferentes formas de identificar mudanças no campo Sprint
    // O campo pode aparecer como "Sprint", "customfield_10020", ou com fieldId
    // Referência: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/#about
    const sprintChanges = history.items.filter(item => {
      if (!item.field && !item.fieldId) return false;
      
      const fieldLower = (item.field || '').toLowerCase();
      const fieldId = item.fieldId || '';
      const fieldName = item.field || '';
      const toString = (item.toString || '').toString().toLowerCase();
      
      // Verificar se é o campo Sprint de diferentes formas
      // CORREÇÃO: O campo correto é customfield_10007 (verificado via inspeção da API)
      // Pode ser "Sprint", "Sprint Link", ou o ID do custom field (10007 ou 10020)
      return fieldLower === 'sprint' ||
             (fieldLower.includes('sprint') && !fieldLower.includes('goal') && !fieldLower.includes('link')) ||
             fieldId.includes('10007') ||
             fieldId.includes('10020') ||
             fieldId === 'customfield_10007' ||
             fieldId === 'customfield_10020' ||
             fieldName === 'customfield_10007' ||
             fieldName === 'customfield_10020' ||
             (item.fieldId && (item.fieldId === 'customfield_10007' || item.fieldId === 'customfield_10020')) ||
             // Também verificar se o toString contém informações de sprint (pode ter formato "Sprint 123" ou "id=123")
             (toString && (toString.includes('sprint') || toString.match(/id=\d+/)));
    });
    
    if (sprintChanges.length > 0) {
      // Primeira vez que sprint foi adicionado (de null/vazio para algum valor)
      // O changelog mostra: field: "Sprint", fromString: null/empty, toString: "Sprint XYZ"
      for (const change of sprintChanges) {
        const fromValue = change.fromString || change.from || '';
        const toValue = change.toString || change.to || '';
        
        // Sprint foi adicionado se: from está vazio/null e to tem valor
        const isEmpty = !fromValue || fromValue === '' || fromValue === 'null' || 
                       fromValue === 'None' || fromValue === null || fromValue === undefined ||
                       fromValue === '[]' || fromValue === 'null';
        const hasValue = toValue && toValue !== '' && toValue !== 'null' && 
                        toValue !== 'None' && toValue !== null && toValue !== undefined &&
                        toValue !== '[]';
        
        if (isEmpty && hasValue) {
          // Encontrou primeira adição de sprint
          return new Date(history.created);
        }
      }
      
      // Alternativa: se from não existe mas to existe, pode ser primeira adição
      for (const change of sprintChanges) {
        const hasFrom = (change.fromString !== undefined && change.fromString !== null && change.fromString !== '') || 
                       (change.from !== undefined && change.from !== null && change.from !== '');
        const hasTo = (change.toString || change.to) && 
                     (change.toString || change.to) !== '' && 
                     (change.toString || change.to) !== null &&
                     (change.toString || change.to) !== '[]';
        if (!hasFrom && hasTo) {
          // Primeira adição sem valor "from"
          return new Date(history.created);
        }
      }
    }
  }
  
  // Se não encontrou no changelog, retornar null
  // A heurística em identifyIssuePlanningStatus vai usar a data de criação como fallback
  return null;
}

/**
 * Decompõe o workflow de uma issue em etapas (Dev → Review → QA → Release)
 * Analisa o changelog para identificar timestamps de cada etapa
 * @param {Object} issue - Issue com changelog expandido
 * @returns {Object} - Objeto com timestamps e durações de cada etapa
 */
function decomposeWorkflow(issue) {
  const workflow = {
    toDoAt: null,
    inProgressAt: null,
    inReviewAt: null,
    qaAt: null,
    readyForReleaseAt: null,
    doneAt: null,
    // Durações em dias
    queueTimeDays: 0,
    devTimeDays: 0,
    reviewTimeDays: 0,
    qaTimeDays: 0,
    waitForReleaseDays: 0,
    // Total de tempo ativo
    activeTimeDays: 0,
    // Total de tempo (created → done)
    totalTimeDays: 0
  };

  if (!issue.changelog || !issue.changelog.histories) {
    // Fallback: usar created e resolutiondate se disponível
    if (issue.fields.created && issue.fields.resolutiondate) {
      const created = new Date(issue.fields.created);
      const resolved = new Date(issue.fields.resolutiondate);
      workflow.toDoAt = created;
      workflow.doneAt = resolved;
      workflow.totalTimeDays = (resolved - created) / (1000 * 60 * 60 * 24);
      workflow.activeTimeDays = workflow.totalTimeDays; // Aproximação
    }
    return workflow;
  }

  // Mapeamento de status para etapas do workflow
  const STATUS_MAPPING = {
    toDo: ['to do', 'backlog', 'aberto', 'open', 'new', 'novo', 'aguardando'],
    inProgress: ['in progress', 'em progresso', 'doing', 'em desenvolvimento', 'desenvolvendo', 'working', 'active', 'development', 'em andamento'],
    inReview: ['in review', 'code review', 'review', 'em revisão', 'revisão', 'pr review', 'pull request'],
    qa: ['qa', 'quality assurance', 'test', 'testing', 'em teste', 'teste', 'aguardando qa', 'aguardando teste'],
    readyForRelease: ['ready for release', 'pronto para release', 'ready to deploy', 'pronto para deploy', 'aguardando release', 'aguardando deploy'],
    done: ['done', 'concluído', 'concluido', 'resolvido', 'fechado', 'closed', 'completed', 'finalizado', 'entregue', 'merged', 'released']
  };

  // Ordenar históricos por data (mais antigo primeiro)
  const histories = [...issue.changelog.histories].sort((a, b) => 
    new Date(a.created) - new Date(b.created)
  );

  // Processar cada mudança de status
  for (const history of histories) {
    if (!history.items || !Array.isArray(history.items)) continue;
    
    const changeTime = new Date(history.created);
    
    for (const item of history.items) {
      if (item.field !== 'status') continue;
      
      const toNorm = normalizeWorkflowStatus(item.toString);
      
      // Identificar etapa baseado no status de destino
      if (!workflow.toDoAt && STATUS_MAPPING.toDo.some((s) => toNorm.includes(s))) {
        workflow.toDoAt = changeTime;
      }
      if (!workflow.inProgressAt && STATUS_MAPPING.inProgress.some((s) => toNorm.includes(s))) {
        workflow.inProgressAt = changeTime;
      }
      if (!workflow.inReviewAt && STATUS_MAPPING.inReview.some((s) => toNorm.includes(s))) {
        workflow.inReviewAt = changeTime;
      }
      if (!workflow.qaAt && STATUS_MAPPING.qa.some((s) => toNorm.includes(s))) {
        workflow.qaAt = changeTime;
      }
      if (!workflow.readyForReleaseAt && STATUS_MAPPING.readyForRelease.some((s) => toNorm.includes(s))) {
        workflow.readyForReleaseAt = changeTime;
      }
      if (!workflow.doneAt && statusLooksDone(item.toString)) {
        workflow.doneAt = changeTime;
      }
    }
  }

  // Fallback: usar created como toDoAt se não encontrado
  if (!workflow.toDoAt && issue.fields.created) {
    workflow.toDoAt = new Date(issue.fields.created);
  }

  // Fallback: usar resolutiondate como doneAt se não encontrado
  if (!workflow.doneAt && issue.fields.resolutiondate) {
    workflow.doneAt = new Date(issue.fields.resolutiondate);
  }

  // Calcular durações de cada etapa
  if (workflow.toDoAt && workflow.inProgressAt) {
    workflow.queueTimeDays = (workflow.inProgressAt - workflow.toDoAt) / (1000 * 60 * 60 * 24);
  }

  if (workflow.inProgressAt && workflow.inReviewAt) {
    workflow.devTimeDays = (workflow.inReviewAt - workflow.inProgressAt) / (1000 * 60 * 60 * 24);
  } else if (workflow.inProgressAt && workflow.qaAt) {
    // Se não tem review, dev vai até QA
    workflow.devTimeDays = (workflow.qaAt - workflow.inProgressAt) / (1000 * 60 * 60 * 24);
  } else if (workflow.inProgressAt && workflow.doneAt) {
    // Se não tem review nem QA, dev vai até done
    workflow.devTimeDays = (workflow.doneAt - workflow.inProgressAt) / (1000 * 60 * 60 * 24);
  }

  if (workflow.inReviewAt && workflow.qaAt) {
    workflow.reviewTimeDays = (workflow.qaAt - workflow.inReviewAt) / (1000 * 60 * 60 * 24);
  } else if (workflow.inReviewAt && workflow.readyForReleaseAt) {
    workflow.reviewTimeDays = (workflow.readyForReleaseAt - workflow.inReviewAt) / (1000 * 60 * 60 * 24);
  } else if (workflow.inReviewAt && workflow.doneAt) {
    workflow.reviewTimeDays = (workflow.doneAt - workflow.inReviewAt) / (1000 * 60 * 60 * 24);
  }

  if (workflow.qaAt && workflow.readyForReleaseAt) {
    workflow.qaTimeDays = (workflow.readyForReleaseAt - workflow.qaAt) / (1000 * 60 * 60 * 24);
  } else if (workflow.qaAt && workflow.doneAt) {
    workflow.qaTimeDays = (workflow.doneAt - workflow.qaAt) / (1000 * 60 * 60 * 24);
  }

  if (workflow.readyForReleaseAt && workflow.doneAt) {
    workflow.waitForReleaseDays = (workflow.doneAt - workflow.readyForReleaseAt) / (1000 * 60 * 60 * 24);
  }

  // Calcular tempo ativo (soma das etapas de trabalho)
  workflow.activeTimeDays = workflow.devTimeDays + workflow.reviewTimeDays + workflow.qaTimeDays;

  // Calcular tempo total
  if (workflow.toDoAt && workflow.doneAt) {
    workflow.totalTimeDays = (workflow.doneAt - workflow.toDoAt) / (1000 * 60 * 60 * 24);
  }

  return workflow;
}

/**
 * Detecta reaberturas e retrabalho de issues através do changelog
 * 
 * Conceitos separados (10/10 best practice):
 * 1. wasReopened = voltou depois de finalizado (Done → status aberto)
 *    - Mede instabilidade do "Done" (falha do processo)
 * 
 * 2. hadRework = foi para status de correção/sub-bug em qualquer ponto
 *    - Mede retrabalho interno (antes de produção)
 *    - Perfeito para atacar causas de qualidade (slicing, testes, DoR/DoD)
 * 
 * @param {Object} issue - Issue com changelog expandido
 * @returns {Object} - Objeto com informações de reabertura e retrabalho
 */
function detectReopens(issue) {
  const result = {
    // Reabertura clássica (voltou após Done)
    reopenCount: 0,
    wasReopened: false,
    reopenDates: [],
    lastReopenDate: null,
    // Retrabalho interno (sub-bug, correção - qualquer ponto do fluxo)
    reworkCount: 0,
    hadRework: false,
    reworkDates: [],
    lastReworkDate: null
  };

  if (!issue.changelog || !issue.changelog.histories) {
    return result;
  }

  // Status que indicam "finalizado"
  const DONE_STATUSES = ['done', 'concluído', 'concluido', 'resolvido', 'fechado', 'closed', 'completed', 'finalizado', 'entregue'];
  
  // Status que indicam "reaberto" (saiu de Done para)
  const REOPEN_STATUSES = ['reopen', 'reaberto', 'reaberta', 'reopened', 'to do', 'in progress', 'em progresso'];
  
  // Status que indicam retrabalho/sub-bug (independente de Done)
  // Quando o QA encontra problema e devolve para o dev
  const REWORK_STATUSES = [
    'sub-bug', 'sub bug', 'subbug',
    'rework', 'retrabalho',
    'correção', 'correcao', 'correction',
    'waiting bugfix', 'aguardando correção', 'aguardando correcao',
    'volta para dev', 'devolvido', 'returned',
    'needs fix', 'precisa correção', 'precisa correcao'
  ];

  // Ordenar históricos por data (mais antigo primeiro)
  const histories = [...issue.changelog.histories].sort((a, b) => 
    new Date(a.created) - new Date(b.created)
  );

  let wasDone = false;

  for (const history of histories) {
    if (!history.items || !Array.isArray(history.items)) continue;
    
    for (const item of history.items) {
      if (item.field !== 'status') continue;
      
      const fromStatus = (item.fromString || '').toLowerCase();
      const toStatus = (item.toString || '').toLowerCase();
      
      // ========================================
      // 1. DETECÇÃO DE REABERTURA (wasReopened)
      // Critério: saiu de Done para status aberto
      // ========================================
      
      // Verificar se entrou em Done
      if (DONE_STATUSES.some(s => toStatus.includes(s))) {
        wasDone = true;
      }
      
      // Verificar se foi reaberta (Done → Reopen/To Do/In Progress)
      if (wasDone && DONE_STATUSES.some(s => fromStatus.includes(s))) {
        if (REOPEN_STATUSES.some(s => toStatus.includes(s)) || 
            toStatus.includes('to do') || 
            toStatus.includes('in progress')) {
          result.reopenCount++;
          result.wasReopened = true;
          const reopenDate = new Date(history.created);
          result.reopenDates.push(reopenDate);
          result.lastReopenDate = reopenDate;
          wasDone = false; // Reset para detectar próximo ciclo
        }
      }
      
      // ========================================
      // 2. DETECÇÃO DE RETRABALHO (hadRework)
      // Critério: foi para status de sub-bug/rework
      // Independente de ter passado por Done ou não
      // ========================================
      
      // Verificar se foi para um status de retrabalho/sub-bug
      if (REWORK_STATUSES.some(s => toStatus.includes(s))) {
        result.reworkCount++;
        result.hadRework = true;
        const reworkDate = new Date(history.created);
        result.reworkDates.push(reworkDate);
        result.lastReworkDate = reworkDate;
      }
    }
  }

  return result;
}

/**
 * Extrai dependências de uma issue através dos issuelinks
 * @param {Object} issue - Issue do Jira
 * @returns {Object} - Objeto com informações de dependências
 */
function extractDependencies(issue) {
  const result = {
    hasDependencies: false,
    blocksCount: 0,
    blockedByCount: 0,
    relatesToCount: 0,
    duplicatesCount: 0,
    clonesCount: 0,
    clonedByCount: 0,
    isBlocked: false,
    blocks: [],
    blockedBy: [],
    relatesTo: [],
    duplicates: [],
    clones: [],
    clonedBy: [],
    linkedIssues: []
  };

  if (!issue.fields || !issue.fields.issuelinks) {
    return result;
  }

  const links = issue.fields.issuelinks || [];

  for (const link of links) {
    const type = link.type || {};
    const inwardIssue = link.inwardIssue;
    const outwardIssue = link.outwardIssue;
    const linkedIssue = inwardIssue || outwardIssue;
    const direction = inwardIssue ? 'inward' : 'outward';
    const linkTypeName = type.name || 'Unknown';

    if (type.inward === 'is blocked by' && inwardIssue) {
      result.blockedByCount++;
      result.isBlocked = true;
      result.blockedBy.push({
        key: inwardIssue.key,
        summary: inwardIssue.fields?.summary || 'N/A'
      });
    } else if (type.outward === 'blocks' && outwardIssue) {
      result.blocksCount++;
      result.blocks.push({
        key: outwardIssue.key,
        summary: outwardIssue.fields?.summary || 'N/A'
      });
    } else if (type.inward === 'relates to' || type.outward === 'relates to') {
      result.relatesToCount++;
      if (linkedIssue) {
        result.relatesTo.push({
          key: linkedIssue.key,
          summary: linkedIssue.fields?.summary || 'N/A'
        });
      }
    } else if (type.inward === 'is duplicated by' || type.outward === 'duplicates') {
      result.duplicatesCount++;
      if (linkedIssue) {
        result.duplicates.push({
          key: linkedIssue.key,
          summary: linkedIssue.fields?.summary || 'N/A'
        });
      }
    } else if (type.inward === 'is cloned by' && inwardIssue) {
      result.clonedByCount++;
      result.clonedBy.push({
        key: inwardIssue.key,
        summary: inwardIssue.fields?.summary || 'N/A'
      });
    } else if (type.outward === 'clones' && outwardIssue) {
      result.clonesCount++;
      result.clones.push({
        key: outwardIssue.key,
        summary: outwardIssue.fields?.summary || 'N/A'
      });
    }

    // Array unificado com TODOS os links independente do tipo
    if (linkedIssue) {
      result.linkedIssues.push({
        key: linkedIssue.key,
        summary: linkedIssue.fields?.summary || 'N/A',
        linkType: linkTypeName,
        direction
      });
    }
  }

  result.hasDependencies = result.blocksCount > 0 ||
                           result.blockedByCount > 0 ||
                           result.relatesToCount > 0 ||
                           result.duplicatesCount > 0 ||
                           result.clonesCount > 0 ||
                           result.clonedByCount > 0;

  return result;
}

/**
 * Classifica tipo de trabalho baseado no issueType
 * @param {string} issueType - Tipo da issue
 * @returns {string} - 'bug', 'feature', 'suporte', 'outros'
 */
function classifyWorkType(issueType) {
  if (!issueType) return 'outros';
  
  const typeLower = issueType.toLowerCase();
  
  if (typeLower.includes('bug') || typeLower.includes('defect') || typeLower.includes('erro')) {
    return 'bug';
  }
  
  if (typeLower.includes('story') || typeLower.includes('task') || typeLower.includes('feature') || typeLower.includes('epic')) {
    return 'feature';
  }
  
  if (typeLower.includes('support') || typeLower.includes('suporte') || typeLower.includes('incident') || typeLower.includes('incidente')) {
    return 'suporte';
  }
  
  return 'outros';
}

/**
 * Mapa padrão de lane por tipo de issue (fallback quando JIRA_LANE_MAP não está definido)
 */
const DEFAULT_LANE_MAP = {
  'hipótese': 'inovacao',
  'hipotese': 'inovacao',
  'experimento': 'inovacao',
  'experiment': 'inovacao',
  'sub-tarefa': 'inovacao',
  'subtarefa': 'inovacao',
  'subtask': 'inovacao',
  'sub-task': 'inovacao',
  'sustentação': 'magica',
  'sustentacao': 'magica',
  'sustentation': 'magica',
  'bug': 'magica',
  'defect': 'magica',
  'sub-bug': 'magica',
  'subbug': 'magica',
};

let _laneMap = null;

function getLaneMap() {
  if (_laneMap) return _laneMap;
  try {
    const envMap = process.env.JIRA_LANE_MAP;
    if (envMap) {
      const parsed = JSON.parse(envMap);
      _laneMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        _laneMap[k.toLowerCase().trim()] = v;
      }
      return _laneMap;
    }
  } catch (_) {
    // fallback silencioso ao mapa padrão
  }
  _laneMap = DEFAULT_LANE_MAP;
  return _laneMap;
}

/**
 * Classifica a lane de trabalho com base no tipo de issue.
 * Para subtarefas sem mapeamento direto, herda a lane do tipo do parent.
 * @param {string} issueType - Tipo da issue
 * @param {string|null} parentType - Tipo da issue pai (opcional)
 * @returns {string} - 'inovacao', 'magica' ou 'outros'
 */
function classifyLane(issueType, parentType = null) {
  const map = getLaneMap();
  const typeKey = (issueType || '').toLowerCase().trim();
  if (map[typeKey]) return map[typeKey];
  // Para subtarefas/sub-tasks sem mapeamento direto, herdar do parent
  if ((typeKey.includes('sub') || typeKey.includes('task') || typeKey.includes('tarefa')) && parentType) {
    const parentKey = parentType.toLowerCase().trim();
    if (map[parentKey]) return map[parentKey];
  }
  return 'outros';
}

/**
 * Analisa tempo gasto em cada status através do changelog
 * @param {Object} issue - Issue com changelog expandido
 * @returns {Object} - Objeto com tempo em cada status e histórico de status
 */
function analyzeStatusTime(issue) {
  const statusTime = {};
  const statusHistory = [];
  const transitionMap = new Map(); // chave: "from||to" → { from, to, count, timestamps[] }

  if (!issue.changelog || !issue.changelog.histories) {
    return { statusTime, statusHistory, totalStatusChanges: 0, statusTransitions: [] };
  }

  const histories = [...issue.changelog.histories].sort((a, b) =>
    new Date(a.created) - new Date(b.created)
  );

  let currentStatus = issue.fields.status?.name || 'Unknown';
  let currentStatusStart = issue.fields.created ? new Date(issue.fields.created) : new Date();
  let totalStatusChanges = 0;

  // Inicializar status inicial
  statusHistory.push({
    status: currentStatus,
    start: currentStatusStart,
    end: null
  });

  for (const history of histories) {
    if (!history.items || !Array.isArray(history.items)) continue;

    const changeTime = new Date(history.created);

    for (const item of history.items) {
      if (item.field === 'status') {
        const fromStatus = item.fromString || currentStatus;
        const toStatus = item.toString || currentStatus;

        if (fromStatus !== toStatus) {
          // Finalizar tempo no status anterior
          const duration = (changeTime - currentStatusStart) / (1000 * 60 * 60 * 24);

          if (!statusTime[fromStatus]) statusTime[fromStatus] = 0;
          statusTime[fromStatus] += duration;

          // Atualizar histórico
          if (statusHistory.length > 0) {
            statusHistory[statusHistory.length - 1].end = changeTime;
            statusHistory[statusHistory.length - 1].durationDays = duration;
          }

          // Registrar par de transição
          const transKey = `${fromStatus}||${toStatus}`;
          if (!transitionMap.has(transKey)) {
            transitionMap.set(transKey, { from: fromStatus, to: toStatus, count: 0, timestamps: [] });
          }
          const trans = transitionMap.get(transKey);
          trans.count++;
          trans.timestamps.push(changeTime.toISOString());

          // Iniciar novo status
          currentStatus = toStatus;
          currentStatusStart = changeTime;
          totalStatusChanges++;

          statusHistory.push({
            status: toStatus,
            start: changeTime,
            end: null
          });
        }
      }
    }
  }

  // Finalizar último status (se ainda não foi concluído)
  if (statusHistory.length > 0 && !statusHistory[statusHistory.length - 1].end) {
    const lastStatus = statusHistory[statusHistory.length - 1];
    const endTime = issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate) : new Date();
    const duration = (endTime - lastStatus.start) / (1000 * 60 * 60 * 24);

    if (!statusTime[lastStatus.status]) statusTime[lastStatus.status] = 0;
    statusTime[lastStatus.status] += duration;

    lastStatus.end = endTime;
    lastStatus.durationDays = duration;
  }

  const statusTransitions = Array.from(transitionMap.values());

  return { statusTime, statusHistory, totalStatusChanges, statusTransitions };
}

/**
 * Analisa mudanças de assignee através do changelog
 * @param {Object} issue - Issue com changelog expandido
 * @returns {Object} - Objeto com informações de assignees
 */
function analyzeAssigneeChanges(issue) {
  const assigneeHistory = [];
  const assigneeTime = {};
  
  if (!issue.changelog || !issue.changelog.histories) {
    const currentAssignee = issue.fields.assignee?.displayName || issue.fields.assignee?.name || 'Unassigned';
    return {
      assigneeCount: currentAssignee !== 'Unassigned' ? 1 : 0,
      assigneeHistory: [{ assignee: currentAssignee, start: issue.fields.created, end: null }],
      assigneeTime: {},
      handoffCount: 0
    };
  }

  const histories = [...issue.changelog.histories].sort((a, b) => 
    new Date(a.created) - new Date(b.created)
  );

  let currentAssignee = issue.fields.assignee?.displayName || issue.fields.assignee?.name || 'Unassigned';
  let currentAssigneeStart = issue.fields.created ? new Date(issue.fields.created) : new Date();
  let handoffCount = 0;

  assigneeHistory.push({
    assignee: currentAssignee,
    start: currentAssigneeStart,
    end: null
  });

  for (const history of histories) {
    if (!history.items || !Array.isArray(history.items)) continue;
    
    const changeTime = new Date(history.created);
    
    for (const item of history.items) {
      if (item.field === 'assignee') {
        const fromAssignee = item.fromString || item.from || 'Unassigned';
        const toAssignee = item.toString || item.to || 'Unassigned';
        
        if (fromAssignee !== toAssignee) {
          // Finalizar tempo do assignee anterior
          const duration = (changeTime - currentAssigneeStart) / (1000 * 60 * 60 * 24); // em dias
          
          if (!assigneeTime[fromAssignee]) {
            assigneeTime[fromAssignee] = 0;
          }
          assigneeTime[fromAssignee] += duration;
          
          // Atualizar histórico
          if (assigneeHistory.length > 0) {
            assigneeHistory[assigneeHistory.length - 1].end = changeTime;
            assigneeHistory[assigneeHistory.length - 1].durationDays = duration;
          }
          
          // Iniciar novo assignee
          currentAssignee = toAssignee;
          currentAssigneeStart = changeTime;
          handoffCount++;
          
          assigneeHistory.push({
            assignee: toAssignee,
            start: changeTime,
            end: null
          });
        }
      }
    }
  }

  // Finalizar último assignee
  if (assigneeHistory.length > 0 && !assigneeHistory[assigneeHistory.length - 1].end) {
    const lastAssignee = assigneeHistory[assigneeHistory.length - 1];
    const endTime = issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate) : new Date();
    const duration = (endTime - lastAssignee.start) / (1000 * 60 * 60 * 24);
    
    if (!assigneeTime[lastAssignee.assignee]) {
      assigneeTime[lastAssignee.assignee] = 0;
    }
    assigneeTime[lastAssignee.assignee] += duration;
    
    lastAssignee.end = endTime;
    lastAssignee.durationDays = duration;
  }

  const uniqueAssignees = new Set(assigneeHistory.map(a => a.assignee).filter(a => a !== 'Unassigned'));

  return {
    assigneeCount: uniqueAssignees.size,
    assigneeHistory: assigneeHistory.map(a => ({
      assignee: a.assignee,
      start: dayjs(a.start).format("YYYY-MM-DD HH:mm"),
      end: a.end ? dayjs(a.end).format("YYYY-MM-DD HH:mm") : null,
      durationDays: a.durationDays || 0
    })),
    assigneeTime: Object.keys(assigneeTime).reduce((acc, key) => {
      acc[key] = parseFloat(assigneeTime[key].toFixed(2));
      return acc;
    }, {}),
    handoffCount: handoffCount
  };
}

/**
 * Extrai informações temporais detalhadas de uma issue
 * @param {Object} issue - Issue do Jira
 * @returns {Object} - Objeto com informações temporais
 */
function extractTemporalInfo(issue) {
  const created = issue.fields.created ? new Date(issue.fields.created) : null;
  const resolved = issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate) : null;
  const started = issue.cycleTimeStartedAt ? new Date(issue.cycleTimeStartedAt) : created;
  
  if (!created) {
    return {
      createdHour: null,
      createdDayOfWeek: null,
      createdDayOfMonth: null,
      createdMonth: null,
      createdQuarter: null,
      createdWeekOfYear: null,
      startedHour: null,
      startedDayOfWeek: null,
      resolvedHour: null,
      resolvedDayOfWeek: null,
      resolvedMonth: null
    };
  }

  const createdDate = dayjs(created);
  const startedDate = started ? dayjs(started) : createdDate;
  const resolvedDate = resolved ? dayjs(resolved) : null;

  // Calcular semana do ano manualmente (sem plugin do dayjs)
  const getWeekOfYear = (dayjsDate) => {
    const d = dayjsDate.toDate();
    const dayNum = d.getDay() || 7;
    d.setDate(d.getDate() + 4 - dayNum);
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  };

  return {
    createdHour: createdDate.hour(),
    createdDayOfWeek: createdDate.day(), // 0 = Domingo, 6 = Sábado
    createdDayOfWeekName: createdDate.format('dddd'),
    createdDayOfMonth: createdDate.date(),
    createdMonth: createdDate.month() + 1, // 1-12
    createdMonthName: createdDate.format('MMMM'),
    createdQuarter: Math.floor((createdDate.month() + 1) / 3) + 1, // 1-4
    createdWeekOfYear: getWeekOfYear(createdDate),
    createdYear: createdDate.year(),
    startedHour: startedDate.hour(),
    startedDayOfWeek: startedDate.day(),
    startedDayOfWeekName: startedDate.format('dddd'),
    resolvedHour: resolvedDate ? resolvedDate.hour() : null,
    resolvedDayOfWeek: resolvedDate ? resolvedDate.day() : null,
    resolvedDayOfWeekName: resolvedDate ? resolvedDate.format('dddd') : null,
    resolvedMonth: resolvedDate ? resolvedDate.month() + 1 : null,
    resolvedMonthName: resolvedDate ? resolvedDate.format('MMMM') : null,
    resolvedQuarter: resolvedDate ? Math.floor((resolvedDate.month() + 1) / 3) + 1 : null,
    resolvedYear: resolvedDate ? resolvedDate.year() : null,
    resolvedWeekOfYear: resolvedDate ? getWeekOfYear(resolvedDate) : null
  };
}

/**
 * Analisa comentários de uma issue
 * @param {Object} issue - Issue do Jira
 * @returns {Object} - Objeto com informações de comentários
 */
function analyzeComments(issue) {
  if (!issue.fields.comment || !issue.fields.comment.comments) {
    return {
      commentCount: 0,
      commentAuthors: [],
      firstCommentDate: null,
      lastCommentDate: null,
      averageCommentsPerDay: 0
    };
  }

  const comments = issue.fields.comment.comments || [];
  const authors = new Set();
  let firstCommentDate = null;
  let lastCommentDate = null;

  comments.forEach(comment => {
    if (comment.author?.displayName) {
      authors.add(comment.author.displayName);
    }
    
    const commentDate = new Date(comment.created);
    if (!firstCommentDate || commentDate < firstCommentDate) {
      firstCommentDate = commentDate;
    }
    if (!lastCommentDate || commentDate > lastCommentDate) {
      lastCommentDate = commentDate;
    }
  });

  const created = issue.fields.created ? new Date(issue.fields.created) : null;
  const resolved = issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate) : new Date();
  const totalDays = created ? (resolved - created) / (1000 * 60 * 60 * 24) : 0;
  const avgCommentsPerDay = totalDays > 0 ? comments.length / totalDays : 0;

  return {
    commentCount: comments.length,
    commentAuthors: Array.from(authors),
    uniqueAuthorsCount: authors.size,
    firstCommentDate: firstCommentDate ? dayjs(firstCommentDate).format("YYYY-MM-DD HH:mm") : null,
    lastCommentDate: lastCommentDate ? dayjs(lastCommentDate).format("YYYY-MM-DD HH:mm") : null,
    averageCommentsPerDay: parseFloat(avgCommentsPerDay.toFixed(2))
  };
}

/**
 * Detecta períodos de bloqueio de uma issue através do changelog
 * Procura por mudanças no campo "flagged" ou status que contenha "block"
 * @param {Object} issue - Issue com changelog expandido
 * @returns {Array<{blockedAt: Date, unblockedAt: Date|null, durationHours: number|null}>} - Array de períodos de bloqueio
 */
function detectBlockPeriods(issue) {
  const blockPeriods = [];
  
  if (!issue.changelog || !issue.changelog.histories) {
    return blockPeriods;
  }
  
  // Ordenar históricos por data (mais antigo primeiro)
  const histories = [...issue.changelog.histories].sort((a, b) => 
    new Date(a.created) - new Date(b.created)
  );
  
  let currentBlockStart = null;
  
  // Procurar mudanças no campo "flagged" ou status que contenha "block"
  for (const history of histories) {
    if (!history.items || !Array.isArray(history.items)) continue;
    
    const changeTime = new Date(history.created);
    
    for (const item of history.items) {
      const field = (item.field || '').toLowerCase();
      const fromValue = (item.fromString || item.from || '').toString().toLowerCase();
      const toValue = (item.toString || item.to || '').toString().toLowerCase();
      
      // Verificar se é mudança no campo "flagged" (bandeira)
      if (field === 'flagged' || field === 'flag') {
        const wasFlagged = fromValue === 'true' || fromValue === 'impediment';
        const isFlagged = toValue === 'true' || toValue === 'impediment';
        
        if (!wasFlagged && isFlagged) {
          // Issue foi bloqueada
          currentBlockStart = changeTime;
        } else if (wasFlagged && !isFlagged) {
          // Issue foi desbloqueada
          if (currentBlockStart) {
            const durationHours = (changeTime - currentBlockStart) / (1000 * 60 * 60);
            blockPeriods.push({
              blockedAt: currentBlockStart,
              unblockedAt: changeTime,
              durationHours: durationHours
            });
            currentBlockStart = null;
          }
        }
      }
      
      // Verificar se é mudança de status para "blocked" ou similar
      if (field === 'status') {
        const fromIsBlocked = fromValue.includes('block') || fromValue.includes('impediment');
        const toIsBlocked = toValue.includes('block') || toValue.includes('impediment');
        
        if (!fromIsBlocked && toIsBlocked) {
          // Status mudou para bloqueado
          currentBlockStart = changeTime;
        } else if (fromIsBlocked && !toIsBlocked) {
          // Status mudou de bloqueado para não bloqueado
          if (currentBlockStart) {
            const durationHours = (changeTime - currentBlockStart) / (1000 * 60 * 60);
            blockPeriods.push({
              blockedAt: currentBlockStart,
              unblockedAt: changeTime,
              durationHours: durationHours
            });
            currentBlockStart = null;
          }
        }
      }
    }
  }
  
  // Se ainda está bloqueado (currentBlockStart não foi fechado)
  if (currentBlockStart) {
    blockPeriods.push({
      blockedAt: currentBlockStart,
      unblockedAt: null, // Ainda bloqueado
      durationHours: null // Não podemos calcular duração ainda
    });
  }
  
  return blockPeriods;
}

/**
 * Busca o(s) projectKey(s) de um board Jira.
 * @param {string} boardId
 * @returns {Promise<Array<string>>}
 */
export async function getProjectKeysFromBoard(boardId) {
  if (!validarCredenciais()) return [];
  const url = `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/project`;
  const auth = { username: JIRA_USER, password: JIRA_TOKEN };
  try {
    const response = await makeApiRequest(url, auth);
    return (response.values || []).map(p => p.key);
  } catch (error) {
    console.error("❌ Erro ao buscar projectKey do board:", error.message);
    return [];
  }
}

/**
 * Busca todas as tasks criadas nos últimos X dias para um board específico.
 * Detecta dinamicamente o campo de story points.
 * @param {string} boardId - ID do board.
 * @param {number} days - Quantidade de dias (ex: 90).
 * @returns {Promise<Array>} Lista de issues.
 */
export async function buscarTasksUltimosDiasPorBoard(boardId, days = 90) {
  if (!validarCredenciais()) return [];

  const auth = { username: JIRA_USER, password: JIRA_TOKEN };
  const projectKeys = await getProjectKeysFromBoard(boardId);
  if (!projectKeys.length) return [];

  const projectJQL = projectKeys.map(key => `project = "${key}"`).join(" OR ");
  const jql = `(${projectJQL}) AND created >= -${days}d ORDER BY assignee`;

  const url = `${JIRA_BASE_URL}/rest/api/3/search`;

  // Lista de possíveis campos de story points
  const storyPointFields = [
    "customfield_10002", "customfield_10004", "customfield_10005", "customfield_10006",
    "customfield_10007", "customfield_10008", "storyPoints", "storypoints", "story_points"
  ];

  try {
    let startAt = 0;
    let maxResults = 100;
    let allIssues = [];
    let total = 1;
    let detectedStoryPointField = null;

    while (startAt < total) {
      const response = await makeApiRequest(url, auth, {
        params: {
          jql,
          fields: "*all",
          startAt,
          maxResults
        }
      });
      total = response.total;
      allIssues = allIssues.concat(response.issues);
      startAt += maxResults;

      // Detecta o campo de story points na primeira página de resultados
      if (!detectedStoryPointField && response.issues.length > 0) {
        for (const issue of response.issues) {
          const fields = issue.fields;
          // Log para depuração
          // console.log("DEBUG fields:", Object.keys(fields));
          detectedStoryPointField = storyPointFields.find(f => fields && fields[f] !== undefined && fields[f] !== null);
          if (detectedStoryPointField) break;
        }
      }
    }

    // Fallback se não detectou nenhum campo
    if (!detectedStoryPointField) {
      console.warn("⚠️ Nenhum campo de story points detectado nos issues retornados.");
      detectedStoryPointField = "customfield_10002";
    } else {
      // console.log("Campo de story points detectado:", detectedStoryPointField);
    }

    return allIssues.map(issue => {
      let storyPoints = 0;
      for (const field of storyPointFields) {
        if (issue.fields[field] !== undefined && issue.fields[field] !== null) {
          storyPoints = Number(issue.fields[field]) || 0;
          break;
        }
      }

      // --- Detecta retrabalho ---
      let isRetrabalho = false;
      if (issue.changelog && Array.isArray(issue.changelog.histories)) {
        // Verifica se houve transição de "Done" para outro status e depois voltou para "Done"
        let wasDone = false;
        let reopened = false;
        for (const history of issue.changelog.histories) {
          for (const item of history.items) {
            if (item.field === "status") {
              const from = (item.fromString || "").toLowerCase();
              const to = (item.toString || "").toLowerCase();
              if (from.includes("done") && !to.includes("done")) {
                wasDone = true;
              }
              if (wasDone && to.includes("done")) {
                reopened = true;
              }
              // Alternativamente, se status foi para "Reopened"
              if (to.includes("reopen")) {
                reopened = true;
              }
            }
          }
        }
        isRetrabalho = reopened;
      }
      // --- fim retrabalho ---

      return {
        key: issue.key,
        summary: issue.fields.summary,
        assignee: issue.fields.assignee?.displayName || "Unassigned",
        assigneeName: issue.fields.assignee?.name || "",
        storyPoints,
        created: issue.fields.created,
        status: issue.fields.status?.name || "Unknown",
        isRetrabalho // <-- novo campo
      };
    });
  } catch (error) {
    console.error("❌ Erro ao buscar tasks dos últimos dias:", error.response?.data || error.message);
    return [];
  }
}
