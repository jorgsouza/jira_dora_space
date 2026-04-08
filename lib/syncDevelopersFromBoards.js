/**
 * Sincroniza developers.json com assignees únicos encontrados nas issues dos boards Agile.
 * Novos utilizadores vão para developers.jira_boards; existentes em qualquer categoria são
 * atualizados (nome / jiraAccountId) se o Jira divergir.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { makeApiRequest } from './apiUtils.js';
import { createSpinner } from './cliSpinner.js';

const IMPORT_CATEGORY = 'jira_boards';

/**
 * @param {object} options
 * @param {string[]} options.boardIds IDs numéricos dos boards (JIRA_BOARD_ID)
 * @param {string} options.developersPath caminho absoluto do developers.json
 * @param {string} options.baseUrl JIRA_BASE_URL sem barra final
 * @param {{ username: string, password: string }} options.auth
 * @returns {Promise<{ updated: boolean, added: number, nameOrAccountUpdates: number, skippedNoEmail: number, uniqueAssignees: number, boardRequests: number }>}
 */
export async function syncDevelopersFromBoards({ boardIds, developersPath, baseUrl, auth }) {
  const result = {
    updated: false,
    added: 0,
    nameOrAccountUpdates: 0,
    skippedNoEmail: 0,
    uniqueAssignees: 0,
    boardRequests: 0,
  };

  const validBoards = boardIds.map(String).filter((id) => /^\d+$/.test(id));
  if (!validBoards.length) return result;

  const spin = createSpinner(`Boards: a preparar ${validBoards.length} quadro(s)…`);
  const base = String(baseUrl || '').replace(/\/$/, '');
  
  /** 
   * Mapeia email -> informações do dev e contagem de issues por board 
   * @type {Map<string, { name: string, accountId: string|null, emailOriginal: string, boardCounts: Map<string, { name: string, count: number }> }>} 
   */
  const byEmail = new Map();

  try {
    for (let bi = 0; bi < validBoards.length; bi++) {
      const boardId = validBoards[bi];
      let startAt = 0;
      const maxResults = 100;
      const url = `${base}/rest/agile/1.0/board/${boardId}/issue`;
      const boardUrl = `${base}/rest/agile/1.0/board/${boardId}`;

      // Obter nome do board para usar como squad
      let boardName = 'N/A';
      try {
        const bData = await makeApiRequest(boardUrl, auth, { timeout: 30000 });
        boardName = bData.name || 'N/A';
      } catch (e) {
        console.warn(`   ⚠️ Não foi possível obter nome do board ${boardId}: ${e.message}`);
      }

      for (;;) {
        result.boardRequests++;
        spin.update(
          `Board ${bi + 1}/${validBoards.length} · ${boardName} (id ${boardId}) · API #${result.boardRequests} · ${byEmail.size} pessoa(s) única(s)`
        );
        const data = await makeApiRequest(url, auth, {
          params: { startAt, maxResults, fields: 'assignee' },
          timeout: 90000,
        });
        const issues = data.issues || [];
        for (const issue of issues) {
          const a = issue.fields?.assignee;
          if (!a) continue;
          const emailOriginal = (a.emailAddress || '').trim();
          if (!emailOriginal) {
            result.skippedNoEmail++;
            continue;
          }
          const key = emailOriginal.toLowerCase();
          const name = (a.displayName || emailOriginal).trim();
          const accountId = a.accountId || null;
          
          let devData = byEmail.get(key);
          if (!devData) {
            devData = { name, accountId, emailOriginal, boardCounts: new Map() };
            byEmail.set(key, devData);
          } else {
            if (name && name !== devData.name) devData.name = name;
            if (accountId && !devData.accountId) devData.accountId = accountId;
          }

          // Incrementar contagem para este board
          const stats = devData.boardCounts.get(boardId) || { name: boardName, count: 0 };
          stats.count++;
          devData.boardCounts.set(boardId, stats);
        }
        spin.update(
          `Board ${bi + 1}/${validBoards.length} · ${boardName} · +${issues.length} issues nesta página · ${byEmail.size} pessoa(s)`
        );
        if (issues.length < maxResults) break;
        startAt += maxResults;
      }
    }

    result.uniqueAssignees = byEmail.size;
    if (byEmail.size === 0) {
      spin.clear();
      return result;
    }

    // Calcular squad predominante para cada dev
    const processedByEmail = new Map();
    for (const [emailKey, devData] of byEmail) {
      let maxCount = -1;
      let topBoardName = 'N/A';

      for (const stats of devData.boardCounts.values()) {
        if (stats.count > maxCount) {
          maxCount = stats.count;
          topBoardName = stats.name;
        }
      }

      // Heurística de Tribo
      let tribe = 'N/A';
      if (topBoardName.includes('B2C')) tribe = 'Tribo Consumidor (B2C)';
      if (topBoardName.includes('GB2B')) tribe = 'Tribo Empresas (B2B)';

      processedByEmail.set(emailKey, { 
        ...devData, 
        squad: topBoardName, 
        tribe 
      });
    }

    spin.update(`A ler e mesclar developers.json · ${byEmail.size} pessoa(s) nos boards…`);

    let raw = { developers: {}, metadata: {} };
    try {
      const txt = await readFile(developersPath, 'utf8');
      raw = JSON.parse(txt);
    } catch {
      /* ficheiro inexistente ou inválido — começa vazio */
    }

    if (!raw.developers || typeof raw.developers !== 'object') raw.developers = {};
    if (!raw.metadata || typeof raw.metadata !== 'object') raw.metadata = {};

    /** @type {Map<string, { roleKey: string, index: number, dev: object }>} */
    const emailToRef = new Map();
    for (const roleKey of Object.keys(raw.developers)) {
      const arr = raw.developers[roleKey];
      if (!Array.isArray(arr)) continue;
      arr.forEach((dev, index) => {
        const em = (dev.email || '').trim().toLowerCase();
        if (em) emailToRef.set(em, { roleKey, index, dev });
      });
    }

    for (const [emailKey, info] of processedByEmail) {
      const ref = emailToRef.get(emailKey);
      if (ref) {
        let touched = false;
        if (info.name && ref.dev.name !== info.name) {
          ref.dev.name = info.name;
          touched = true;
        }
        if (info.accountId && ref.dev.jiraAccountId !== info.accountId) {
          ref.dev.jiraAccountId = info.accountId;
          touched = true;
        }
        if (ref.dev.email !== info.emailOriginal) {
          ref.dev.email = info.emailOriginal;
          touched = true;
        }
        // Atualizar Squad/Tribe se mudaram ou eram N/A
        if (info.squad !== 'N/A' && ref.dev.squad !== info.squad) {
          ref.dev.squad = info.squad;
          touched = true;
        }
        if (info.tribe !== 'N/A' && ref.dev.tribe !== info.tribe) {
          ref.dev.tribe = info.tribe;
          touched = true;
        }

        if (touched) {
          result.nameOrAccountUpdates++;
          result.updated = true;
        }
      } else {
        if (!raw.developers[IMPORT_CATEGORY]) raw.developers[IMPORT_CATEGORY] = [];
        const local = info.emailOriginal.split('@')[0] || 'user';
        raw.developers[IMPORT_CATEGORY].push({
          name: info.name,
          email: info.emailOriginal,
          role: 'N/A',
          role2: 'Sincronizado dos boards Jira (jiraToMongo)',
          username: local.toLowerCase().replace(/[^a-z0-9._-]/g, '.') || 'user',
          squad: info.squad || 'N/A',
          tribe: info.tribe || 'N/A',
          leader: false,
          reportsTo: '',
          leaderEmail: '',
          ...(info.accountId ? { jiraAccountId: info.accountId } : {}),
        });
        result.added++;
        result.updated = true;
      }
    }

    const seen = new Set();
    let total = 0;
    for (const roleKey of Object.keys(raw.developers)) {
      const arr = raw.developers[roleKey];
      if (!Array.isArray(arr)) continue;
      for (const d of arr) {
        const em = (d.email || '').trim().toLowerCase();
        if (em && !seen.has(em)) {
          seen.add(em);
          total++;
        }
      }
    }
    raw.metadata.totalDevelopers = total;
    raw.metadata.lastUpdated = new Date().toISOString().slice(0, 10);
    if (!raw.metadata.version) raw.metadata.version = '1.0.0';

    if (result.updated) {
      spin.update('A gravar developers.json…');
      await mkdir(path.dirname(path.resolve(developersPath)), { recursive: true });
      await writeFile(developersPath, JSON.stringify(raw, null, 2), 'utf8');
    }

    spin.clear();
    return result;
  } catch (e) {
    spin.clear();
    throw e;
  }
}
