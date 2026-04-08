/**
 * Resolve squad/tribe a partir de projeto Jira e/ou board Agile (developers.json).
 * Prioridade: squadByProjectKey[project] → projetos do board em squadByBoardId → squad do assignee.
 */

function upperKey(k) {
  return String(k || '').trim().toUpperCase();
}

/** Normaliza mapas cujas chaves são project keys ou board ids. */
function normalizeStringMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[String(k).trim()] = v;
  }
  return out;
}

/**
 * Lê squadByProjectKey e squadByBoardId da raiz do developers.json.
 * Chaves de projeto ficam em MAIÚSCULAS; ids de board como string trim (ex.: "407").
 * @param {object} devRoot - objeto parseado do ficheiro completo
 */
export function extractSquadMappings(devRoot) {
  const byProject = {};
  for (const [k, v] of Object.entries(devRoot?.squadByProjectKey || {})) {
    const K = upperKey(k);
    if (K) byProject[K] = v;
  }
  const byBoard = normalizeStringMap(devRoot?.squadByBoardId || {});
  return { byProject, byBoard };
}

/**
 * Para cada boardId com entrada em squadByBoardId, obtém project keys do board
 * e mapeia projeto → squad (primeiro board na lista vence se houver colisão).
 * @param {string[]} boardIds - IDs de board (ex.: JIRA_BOARD_ID.split)
 * @param {object} byBoard - squadByBoardId normalizado
 * @param {(id: string) => Promise<string[]>} getProjectKeysForBoard
 */
export async function buildProjectSquadFromBoards(boardIds, byBoard, getProjectKeysForBoard) {
  const projectFromBoard = {};
  if (!boardIds?.length || !getProjectKeysForBoard) return projectFromBoard;
  for (const bid of boardIds) {
    const id = String(bid).trim();
    if (!id) continue;
    const entry = byBoard[id];
    if (!entry || !String(entry.squad || '').trim()) continue;
    let keys = [];
    try {
      keys = await getProjectKeysForBoard(id);
    } catch {
      keys = [];
    }
    for (const pk of keys) {
      const P = upperKey(pk);
      if (!P || projectFromBoard[P]) continue;
      projectFromBoard[P] = {
        squad: entry.squad,
        tribe: entry.tribe || '',
      };
    }
  }
  return projectFromBoard;
}

/**
 * @param {string} projectKey - issue.fields.project.key
 * @param {object} devInfo - { squad, tribe } do assignee
 * @param {{ byProject: object, projectFromBoard: object }} ctx
 */
export function resolveSquadForIssue(projectKey, devInfo, ctx) {
  const dev = devInfo || {};
  const pk = upperKey(projectKey);
  const byP = ctx?.byProject || {};
  const fromB = ctx?.projectFromBoard || {};

  const projEntry = pk ? byP[pk] : null;
  if (projEntry && String(projEntry.squad || '').trim()) {
    return {
      squad: String(projEntry.squad).trim(),
      tribe: String(projEntry.tribe || dev.tribe || 'N/A').trim() || 'N/A',
      source: 'project_map',
    };
  }

  const boardEntry = pk ? fromB[pk] : null;
  if (boardEntry && String(boardEntry.squad || '').trim()) {
    return {
      squad: String(boardEntry.squad).trim(),
      tribe: String(boardEntry.tribe || dev.tribe || 'N/A').trim() || 'N/A',
      source: 'board_map',
    };
  }

  return {
    squad: dev.squad || 'N/A',
    tribe: dev.tribe || 'N/A',
    source: 'assignee',
  };
}

export async function buildSquadResolutionContext(devRoot, boardIdEnv, getProjectKeysForBoard) {
  const { byProject, byBoard } = extractSquadMappings(devRoot);
  const boardIds = boardIdEnv
    ? String(boardIdEnv)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const projectFromBoard = await buildProjectSquadFromBoards(boardIds, byBoard, getProjectKeysForBoard);
  return { byProject, projectFromBoard };
}
