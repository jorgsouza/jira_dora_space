#!/usr/bin/env node
/**
 * jiraToMongo — pacote autónomo: Jira → CSV + MongoDB (mesmo fluxo que agent-rag/scripts/dora-flow-extraction.js).
 *
 * Setup: copie esta pasta, `npm install`, crie `.env` (ver env.example) e `developers.json` (ou use DEVELOPERS_JSON).
 *
 * Uso:
 *   npm run extract
 *   node extract.mjs --year=2026
 *   node extract.mjs --year=2025 --months=12
 *   node extract.mjs --years=2025,2026
 *   node extract.mjs --no-csv | --no-mongo
 *   node extract.mjs --skip-existing
 *   node extract.mjs --no-sync-developers   (não atualiza developers.json pelos boards)
 *   node extract.mjs   (sem --year: jan/2026 até hoje)
 *
 * Com JIRA_BOARD_ID: antes da extração, sincroniza developers.json com assignees das issues dos boards.
 *
 * timeInStatus_lifetime_* / timeInStatus_windowed_* — ver script original no repo.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { MongoClient } from 'mongodb';
import { createSpinner } from './lib/cliSpinner.js';
import { buildSquadResolutionContext, resolveSquadForIssue } from './lib/squadResolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
dotenv.config({ path: path.join(ROOT, '.env') });

const { buscarHistoricoTasksPorEmail, enrichSprintDimension, applySprintDimension, getProjectKeysFromBoard } =
  await import('./lib/jiraService.js');
const { DeveloperService } = await import('./lib/DeveloperService.js');

const COLLECTION = 'issues_dora_flow';
const DB_NAME = process.env.MONGO_KR_DB || process.env.MONGO_DORA_DB || 'agent-rag';

function parseArgs() {
  const args = process.argv.slice(2);
  const hasYear = args.some((a) => a.startsWith('--year='));
  const hasYears = args.some((a) => a.startsWith('--years='));
  const opts = {
    year: new Date().getFullYear(),
    years: null,
    months: null,
    csv: true,
    mongo: true,
    skipExisting: false,
    fromJan2026ToToday: false,
    syncDevelopers: true,
    clearDb: false,
  };
  for (const a of args) {
    if (a.startsWith('--year=')) opts.year = parseInt(a.split('=')[1], 10) || opts.year;
    if (a.startsWith('--years=')) {
      const list = a.split('=')[1];
      opts.years = list.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 1990 && n < 2100);
    }
    if (a.startsWith('--months=')) opts.months = parseInt(a.split('=')[1], 10);
    if (a === '--no-csv') opts.csv = false;
    if (a === '--no-mongo') opts.mongo = false;
    if (a === '--skip-existing') opts.skipExisting = true;
    if (a === '--no-skip-existing') opts.skipExisting = false;
    if (a === '--no-sync-developers') opts.syncDevelopers = false;
    if (a === '--clear-db') opts.clearDb = true;
  }
  if (!hasYear && !hasYears) {
    opts.fromJan2026ToToday = true;
    opts.years = [2026];
  }
  if (opts.months == null) opts.months = Math.min(12, 1 + (new Date().getMonth() + 1));
  return opts;
}

function extractSeniority(role2) {
  if (!role2 || typeof role2 !== 'string') return 'N/A';
  const r = role2.toLowerCase();
  if (r.includes('senior') || r.includes('sênior')) return 'Senior';
  if (r.includes('pleno')) return 'Pleno';
  if (r.includes('junior') || r.includes('júnior')) return 'Junior';
  if (r.includes('estagiário') || r.includes('estagiario')) return 'Estagiário';
  return 'N/A';
}

function normalizeStoryPoints(sp) {
  const n = Number(sp);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Parseia data em formato ISO ou YYYY-MM-DD [HH:mm]; retorna Date ou null se inválido. */
function parseDate(str) {
  if (!str || str === 'N/A') return null;
  const d = new Date(str);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Retorna string com timestamp completo (YYYY-MM-DD HH:mm:ss). Se já tiver hora, mantém; senão usa 00:00:00. */
function ensureTimestamp(dateStr) {
  if (!dateStr || dateStr === 'N/A') return '';
  const s = String(dateStr).trim();
  if (/T|\d{1,2}:\d{2}/.test(s)) return s.replace('T', ' ').slice(0, 19);
  return s.length >= 10 ? `${s.slice(0, 10)} 00:00:00` : '';
}

/** Calcula dias entre duas datas (mesmo timezone; fração em dias). */
function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const ms = endDate.getTime() - startDate.getTime();
  return ms / (24 * 60 * 60 * 1000);
}

/** Converte Date local para YYYY-MM-DD (para comparar com issue.resolved do jiraService). */
function toYmd(d) {
  if (!d || !(d instanceof Date) || !Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * issue.resolved vem como "YYYY-MM-DD" (sem timezone). Evitar new Date("YYYY-MM-DD") na comparação
 * com periodStart/periodEnd locais — isso pode excluir todas as issues por deslocamento UTC vs local.
 */
function resolvedDateInRange(resolvedStr, periodStart, periodEnd) {
  if (!resolvedStr || typeof resolvedStr !== 'string') return false;
  const ymd = resolvedStr.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const lo = toYmd(periodStart);
  const hi = toYmd(periodEnd);
  if (!lo || !hi) return false;
  return ymd >= lo && ymd <= hi;
}

/**
 * Calcula tempo em cada status apenas dentro da janela [windowStart, windowEnd] (para Flow Efficiency).
 * statusHistory = [{ status, start, end, durationDays }]; start/end em "YYYY-MM-DD HH:mm".
 * Retorna { statusName: days } em dias; valores >= 0.
 */
function computeTimeInStatusWindowed(statusHistory, windowStart, windowEnd) {
  const byStatus = {};
  if (!windowStart || !windowEnd || windowEnd.getTime() < windowStart.getTime()) return byStatus;
  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();
  for (const seg of statusHistory || []) {
    const status = seg.status || 'Unknown';
    if (!status || status === 'Unknown') continue;
    const segStart = parseDate(seg.start);
    const segEnd = seg.end ? parseDate(seg.end) : windowEnd;
    if (!segStart) continue;
    const overlapStart = Math.max(segStart.getTime(), windowStartMs);
    const overlapEnd = Math.min(segEnd ? segEnd.getTime() : windowEndMs, windowEndMs);
    if (overlapEnd <= overlapStart) continue;
    const days = (overlapEnd - overlapStart) / (24 * 60 * 60 * 1000);
    byStatus[status] = (byStatus[status] || 0) + Math.max(0, days);
  }
  return byStatus;
}

/** Monta uma issue no formato “enriquecido” (tribe, squad, etc.) a partir da issue do jiraService e do dev. */
function enrichIssue(issue, devInfo, squadResolution) {
  const sr = squadResolution || {
    squad: devInfo.squad || 'N/A',
    tribe: devInfo.tribe || 'N/A',
    source: 'assignee',
  };
  return {
    key: issue.key,
    summary: issue.summary || 'Sem título',
    user: devInfo.name || devInfo.email,
    email: devInfo.email,
    function: devInfo.role || 'N/A',
    seniority: extractSeniority(devInfo.role2 || devInfo.role),
    stack: devInfo.roleCategory || devInfo.stack || 'outros',
    squad: sr.squad || devInfo.squad || 'N/A',
    tribe: sr.tribe || devInfo.tribe || 'N/A',
    squadSource: sr.source || 'assignee',
    projectKey: issue.projectKey || '',
    projectName: issue.projectName || '',
    storyPoints: normalizeStoryPoints(issue.storyPoints),
    cycleTimeDays: issue.cycleTime || 0,
    created: issue.created || 'N/A',
    resolved: issue.resolved || null,
    status: issue.status || 'N/A',
    issueType: issue.type || issue.issueType || 'N/A',
    priority: issue.priority || 'N/A',
    sprintId: issue.sprintId || 'none',
    sprintName: issue.sprintName || 'Sem Sprint',
    sprintStartDate: issue.sprintStartDate || null,
    sprintEndDate: issue.sprintEndDate || null,
    sprintState: issue.sprintState || null,
    sprintCreatedName: issue.sprintCreatedName || 'Sem Sprint',
    sprintResolvedName: issue.sprintResolvedName || 'Sem Sprint',
    addedToSprintAt: issue.addedToSprintAt || null,
    cycleTimeStartedAt: issue.cycleTimeStartedAt || null,
    cycleTimeDoneAt: issue.cycleTimeDoneAt || null,
    cycleTimeSource: issue.cycleTimeSource || '',
    ctHadActiveTransition: !!issue.ctHadActiveTransition,
    ctProxyKind: issue.ctProxyKind || null,
    leadTimeDays: issue.leadTimeDays != null ? issue.leadTimeDays : null,
    idleBeforeWorkDays: issue.idleBeforeWorkDays != null ? issue.idleBeforeWorkDays : null,
    totalBlockHours: issue.totalBlockHours || 0,
    blockPeriods: issue.blockPeriods || [],
    reopens: issue.reopens || { wasReopened: false },
    dependencies: issue.dependencies || { hasDependencies: false },
    workType: issue.workType || 'outros',
    lane: issue.lane || 'outros',
    parentKey: issue.parentKey || null,
    parentType: issue.parentType || null,
    statusTime: issue.statusTime || {},
    statusHistory: issue.statusHistory || [],
    totalStatusChanges: issue.totalStatusChanges || 0,
    statusTransitions: issue.statusTransitions || [],
    assigneeCount: issue.assigneeCount || 1,
    handoffCount: issue.handoffCount || 0,
    tooManyCooks: issue.tooManyCooks || false,
    communicationComplexity: issue.communicationComplexity || 0,
    queueTimeDays: issue.workflow?.queueTimeDays || 0,
    touchTimeDays: issue.workflow?.touchTimeDays || 0,
    waitTimeDays: issue.workflow?.waitTimeDays || 0,
    flowEfficiency: issue.workflow?.flowEfficiency || 0,
    sprintCount: issue.sprintCount || 0,
    isScopeCreep: issue.isScopeCreep || false,
    predictabilityIndex: issue.predictabilityIndex || 0,
    reviewLatencyDays: issue.reviewLatencyDays || 0,
    epic: issue.epic || null,
    labels: issue.labels || [],
    sprintHistory: (issue.sprintHistory || []).map((sh) => ({
      sprintId: sh.sprintId || 'none',
      sprintName: sh.sprintName || 'Sem Sprint',
      sprintStartDate: sh.sprintStartDate || null,
      sprintEndDate: sh.sprintEndDate || null,
      sprintState: sh.sprintState || null,
      addedAt: sh.addedAt || null,
      removedAt: sh.removedAt || null,
      wasRemoved: sh.wasRemoved || false
    }))
  };
}

/** Coleta todos os status únicos (statusTime + statusHistory) para colunas timeInStatus_*. */
function collectSortedStatuses(issues) {
  const set = new Set();
  for (const issue of issues) {
    if (issue.statusTime && typeof issue.statusTime === 'object') {
      Object.keys(issue.statusTime).forEach((s) => s && s !== 'Unknown' && set.add(s));
    }
    (issue.statusHistory || []).forEach((sh) => {
      const s = sh.status || (typeof sh === 'string' ? sh : null);
      if (s && s !== 'Unknown') set.add(s);
    });
    if (issue.status && issue.status !== 'Unknown') set.add(issue.status);
  }
  return Array.from(set).sort();
}

/** Formata uma issue enriquecida para uma linha CSV/Mongo. ctDays derivado de (end−start); inválido se end < start.
 *  timeInStatus_lifetime_* = created→resolved (dias). timeInStatus_windowed_* = só start→end (dias); use para Flow Efficiency.
 *  Unidades: todos os timeInStatus em dias. createdAtTs/resolvedAtTs = timestamp completo (YYYY-MM-DD HH:mm:ss). */
function formatIssueForExport(issue, sortedStatuses, statusHistoryMap, stats = { clampedNegativeCount: 0 }) {
  const stack = issue.stack || 'outros';
  const startStr = issue.cycleTimeStartedAt || issue.created || null;
  const endStr = issue.cycleTimeDoneAt || issue.resolved || null;
  const startDate = startStr || 'N/A';
  const endDate = endStr || 'N/A';
  const startParsed = parseDate(startStr);
  const endParsed = parseDate(endStr);
  let ctDays = null;
  let invalidForCT = false;
  if (startParsed && endParsed) {
    if (endParsed.getTime() < startParsed.getTime()) {
      invalidForCT = true;
    } else {
      const days = daysBetween(startParsed, endParsed);
      ctDays = days != null ? parseFloat(Number(days).toFixed(1)) : null;
    }
  } else {
    invalidForCT = !startParsed || !endParsed;
  }
  const statusTime = issue.statusTime || {};
  let statusInitial = issue.status || 'Unknown';
  let statusFinal = issue.status || 'Unknown';
  const history = statusHistoryMap.get(issue.key) || issue.statusHistory || [];
  if (history.length > 0) {
    statusInitial = history[0].status || statusInitial;
    statusFinal = history[history.length - 1].status || statusFinal;
  }
  const timeInStatusByStatus = {};
  sortedStatuses.forEach((s) => {
    const val = statusTime[s];
    const num = typeof val === 'number' && Number.isFinite(val) ? val : 0;
    if (num < 0) stats.clampedNegativeCount += 1;
    timeInStatusByStatus[`timeInStatus_lifetime_${s}`] = Math.max(0, num);
  });
  const timeInStatusWindowed = startParsed && endParsed && endParsed.getTime() >= startParsed.getTime()
    ? computeTimeInStatusWindowed(history, startParsed, endParsed)
    : {};
  const timeInStatusWindowedByStatus = {};
  sortedStatuses.forEach((s) => {
    const val = timeInStatusWindowed[s];
    const num = typeof val === 'number' && Number.isFinite(val) ? val : 0;
    if (num < 0) stats.clampedNegativeCount += 1;
    timeInStatusWindowedByStatus[`timeInStatus_windowed_${s}`] = Math.max(0, num);
  });
  return {
    key: issue.key,
    title: (issue.summary || 'Sem título').substring(0, 100),
    tribe: issue.tribe || 'N/A',
    squad: issue.squad || 'N/A',
    squadSource: issue.squadSource || 'assignee',
    projectKey: issue.projectKey || '',
    projectName: issue.projectName || '',
    stack,
    assignee: issue.user || 'N/A',
    seniority: issue.seniority || 'N/A',
    function: issue.function || 'N/A',
    workType: issue.workType || 'outros',
    lane: issue.lane || 'outros',
    issueType: issue.issueType || 'N/A',
    parentKey: issue.parentKey || null,
    parentType: issue.parentType || null,
    priority: issue.priority || 'N/A',
    status: issue.status || 'N/A',
    sp: issue.storyPoints || 0,
    ctDays: ctDays ?? '',
    invalidForCT,
    createdAt: issue.created || '',
    createdAtTs: ensureTimestamp(issue.created),
    start: startDate,
    end: endDate,
    resolvedAt: issue.resolved || '',
    resolvedAtTs: ensureTimestamp(issue.resolved),
    blockedHours: issue.totalBlockHours || 0,
    hasDependencies: issue.dependencies?.hasDependencies || false,
    clonesCount: issue.dependencies?.clonesCount || 0,
    clonedByCount: issue.dependencies?.clonedByCount || 0,
    linkedIssues: issue.dependencies?.linkedIssues || [],
    handoffCount: issue.handoffCount || 0,
    tooManyCooks: issue.tooManyCooks || false,
    communicationComplexity: issue.communicationComplexity || 0,
    queueTimeDays: issue.queueTimeDays || 0,
    touchTimeDays: issue.touchTimeDays || 0,
    waitTimeDays: issue.waitTimeDays || 0,
    flowEfficiency: issue.flowEfficiency || 0,
    sprintCount: issue.sprintCount || 0,
    isScopeCreep: issue.isScopeCreep || false,
    predictabilityIndex: issue.predictabilityIndex || 0,
    reviewLatencyDays: issue.reviewLatencyDays || 0,
    cycleTimeSource: issue.cycleTimeSource || '',
    ctHadActiveTransition: !!issue.ctHadActiveTransition,
    ctProxyKind: issue.ctProxyKind || '',
    leadTimeDays:
      issue.leadTimeDays != null && Number.isFinite(Number(issue.leadTimeDays))
        ? parseFloat(Number(issue.leadTimeDays).toFixed(1))
        : '',
    idleBeforeWorkDays:
      issue.idleBeforeWorkDays != null && Number.isFinite(Number(issue.idleBeforeWorkDays))
        ? parseFloat(Number(issue.idleBeforeWorkDays).toFixed(1))
        : '',
    assigneeCount: issue.assigneeCount || 1,
    statusChanges: issue.totalStatusChanges || 0,
    wasReopened: issue.reopens?.wasReopened || false,
    statusInitial,
    statusFinal,
    ...timeInStatusByStatus,
    ...timeInStatusWindowedByStatus,
    sprintCreated: issue.sprintCreatedName || 'Sem Sprint',
    sprintResolved: issue.sprintResolvedName || 'Sem Sprint',
    epic: issue.epic || null,
    labels: issue.labels || [],
    statusTransitions: issue.statusTransitions || [],
    _sprintHistory: issue.sprintHistory || []
  };
}

/** Uma linha por issue: dedup por key e consolida sprint em sprintNames, lastSprint*, etc. */
function consolidateSprintAndDedup(formattedIssues, sprintDimension) {
  const byKey = new Map();
  for (const issue of formattedIssues) {
    if (byKey.has(issue.key)) continue;
    const sprintHistory = issue._sprintHistory || [];
    const sprintNames = [];
    let lastSprintName = issue.sprintResolved || 'Sem Sprint';
    let lastSprintStartDate = null;
    let lastSprintEndDate = null;
    let lastAddedToSprintAt = null;
    let wasRemovedFromSprint = false;
    let lastRemovedFromSprintAt = null;
    if (sprintHistory.length > 0) {
      for (const s of sprintHistory) {
        let name = s.sprintName || 'Sem Sprint';
        let start = s.sprintStartDate || null;
        let end = s.sprintEndDate || null;
        if (s.sprintId && s.sprintId !== 'none' && sprintDimension.has(String(s.sprintId))) {
          const meta = sprintDimension.get(String(s.sprintId));
          if (!start) start = meta.startDate;
          if (!end) end = meta.endDate;
          if (!name || name === 'Sem Sprint' || name === 'Unknown Sprint') name = meta.name;
        }
        sprintNames.push(name);
        if (s.wasRemoved) {
          wasRemovedFromSprint = true;
          if (s.removedAt) lastRemovedFromSprintAt = s.removedAt;
        }
      }
      const last = sprintHistory[sprintHistory.length - 1];
      lastSprintName = last.sprintName || 'Sem Sprint';
      lastSprintStartDate = last.sprintStartDate || null;
      lastSprintEndDate = last.sprintEndDate || null;
      lastAddedToSprintAt = last.addedAt || null;
      if (last.sprintId && last.sprintId !== 'none' && sprintDimension.has(String(last.sprintId))) {
        const meta = sprintDimension.get(String(last.sprintId));
        if (!lastSprintStartDate) lastSprintStartDate = meta.startDate;
        if (!lastSprintEndDate) lastSprintEndDate = meta.endDate;
        if (!lastSprintName || lastSprintName === 'Sem Sprint') lastSprintName = meta.name;
      }
    }
    const { _sprintHistory, ...rest } = issue;
    byKey.set(issue.key, {
      ...rest,
      sprintNames,
      lastSprintName,
      lastSprintStartDate,
      lastSprintEndDate,
      lastAddedToSprintAt,
      wasRemovedFromSprint,
      lastRemovedFromSprintAt
    });
  }
  return Array.from(byKey.values());
}

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function saveCSV(rows, headers, periodLabel) {
  const exportDir = path.join(ROOT, 'exports');
  if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  const safePeriod = (periodLabel || 'dora_flow').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const filepath = path.join(exportDir, `issues_dora_flow_${safePeriod}_${timestamp}.csv`);
  const headerLine = headers.map(escapeCSV).join(',');
  const dataLines = rows.map((row) =>
    headers.map((h) => {
      let val = row[h];
      if (h === 'hasDependencies' || h === 'wasReopened' || h === 'wasRemovedFromSprint' || h === 'invalidForCT' || h === 'ctHadActiveTransition') {
        val = val === true || val === 'SIM' ? 'SIM' : 'NÃO';
      } else if ((h === 'labels' || h === 'sprintNames') && Array.isArray(val)) {
        val = JSON.stringify(val);
      } else if (h.startsWith('timeInStatus_') && (typeof val === 'number' || val !== undefined)) {
        val = Number(val).toFixed(2);
      }
      return escapeCSV(val);
    }).join(',')
  );
  const content = '\uFEFF' + [headerLine, ...dataLines].join('\n');
  writeFileSync(filepath, content, 'utf8');
  return filepath;
}

function rowToDoc(row, dataExport, anoMes) {
  const doc = {
    data_export: dataExport,
    ano_mes: anoMes,
    key: row.key || '',
    title: row.title || '',
    projectKey: row.projectKey || '',
    projectName: row.projectName || '',
    tribe: row.tribe || '',
    squad: row.squad || '',
    squadSource: row.squadSource || '',
    stack: row.stack || '',
    assignee: row.assignee || '',
    seniority: row.seniority || '',
    function: row.function || '',
    workType: row.workType || '',
    lane: row.lane || 'outros',
    issueType: row.issueType || '',
    parentKey: row.parentKey || null,
    parentType: row.parentType || null,
    priority: row.priority || '',
    status: row.status || '',
    sp: row.sp != null ? Number(row.sp) : 0,
    ctDays: row.ctDays !== '' && row.ctDays != null && !row.invalidForCT ? Number(row.ctDays) : null,
    leadTimeDays: row.leadTimeDays !== '' && row.leadTimeDays != null && Number.isFinite(Number(row.leadTimeDays)) ? Number(row.leadTimeDays) : null,
    idleBeforeWorkDays: row.idleBeforeWorkDays !== '' && row.idleBeforeWorkDays != null && Number.isFinite(Number(row.idleBeforeWorkDays)) ? Number(row.idleBeforeWorkDays) : null,
    cycleTimeSource: row.cycleTimeSource || '',
    ctHadActiveTransition: row.ctHadActiveTransition === true || row.ctHadActiveTransition === 'SIM',
    ctProxyKind: row.ctProxyKind || '',
    invalidForCT: row.invalidForCT === true || row.invalidForCT === 'SIM',
    createdAt: row.createdAt || '',
    createdAtTs: row.createdAtTs || '',
    start: row.start || '',
    end: row.end || '',
    resolvedAt: row.resolvedAt || '',
    resolvedAtTs: row.resolvedAtTs || '',
    blockedHours: row.blockedHours != null ? Number(row.blockedHours) : 0,
    queueTimeDays: row.queueTimeDays != null ? Number(row.queueTimeDays) : 0,
    touchTimeDays: row.touchTimeDays != null ? Number(row.touchTimeDays) : 0,
    waitTimeDays: row.waitTimeDays != null ? Number(row.waitTimeDays) : 0,
    flowEfficiency: row.flowEfficiency != null ? Number(row.flowEfficiency) : 0,
    sprintCount: row.sprintCount != null ? Number(row.sprintCount) : 0,
    isScopeCreep: row.isScopeCreep === true || row.isScopeCreep === 'SIM',
    predictabilityIndex: row.predictabilityIndex != null ? Number(row.predictabilityIndex) : 0,
    reviewLatencyDays: row.reviewLatencyDays != null ? Number(row.reviewLatencyDays) : 0,
    hasDependencies: row.hasDependencies === true || row.hasDependencies === 'SIM',
    clonesCount: row.clonesCount != null ? Number(row.clonesCount) : 0,
    clonedByCount: row.clonedByCount != null ? Number(row.clonedByCount) : 0,
    linkedIssues: Array.isArray(row.linkedIssues) ? row.linkedIssues : [],
    handoffCount: row.handoffCount != null ? Number(row.handoffCount) : 0,
    assigneeCount: row.assigneeCount != null ? Number(row.assigneeCount) : 0,
    tooManyCooks: row.tooManyCooks === true || row.tooManyCooks === 'SIM',
    communicationComplexity: row.communicationComplexity != null ? Number(row.communicationComplexity) : 0,
    statusChanges: row.statusChanges != null ? Number(row.statusChanges) : 0,
    wasReopened: row.wasReopened === true || row.wasReopened === 'SIM',
    statusInitial: row.statusInitial || '',
    statusFinal: row.statusFinal || '',
    sprintNames: Array.isArray(row.sprintNames) ? row.sprintNames : [],
    lastSprintName: row.lastSprintName || '',
    lastSprintStartDate: row.lastSprintStartDate || '',
    lastSprintEndDate: row.lastSprintEndDate || '',
    lastAddedToSprintAt: row.lastAddedToSprintAt || '',
    wasRemovedFromSprint: row.wasRemovedFromSprint === true || row.wasRemovedFromSprint === 'SIM',
    lastRemovedFromSprintAt: row.lastRemovedFromSprintAt || '',
    sprintCreated: row.sprintCreated || '',
    sprintResolved: row.sprintResolved || '',
    epic: row.epic || '',
    labels: Array.isArray(row.labels) ? row.labels : [],
    statusTransitions: Array.isArray(row.statusTransitions) ? row.statusTransitions : []
  };
  for (const k of Object.keys(row)) {
    if ((k.startsWith('timeInStatus_lifetime_') || k.startsWith('timeInStatus_windowed_')) && !(k in doc)) doc[k] = row[k] != null ? Number(row[k]) : 0;
  }
  return doc;
}

async function saveToMongo(rows, dataExport, anoMes, skipExisting = false) {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.warn('⚠️ MONGO_URI não definido; pulando gravação no MongoDB.');
    return null;
  }
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const col = db.collection(COLLECTION);
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let existingKeys = new Set();
    if (skipExisting && rows.length > 0) {
      const keys = rows.map((r) => r.key || '').filter(Boolean);
      const found = await col.find({ key: { $in: keys } }).project({ key: 1 }).toArray();
      existingKeys = new Set(found.map((d) => d.key));
    }
    for (const row of rows) {
      const doc = rowToDoc(row, dataExport, anoMes);
      const key = doc.key;
      if (skipExisting && existingKeys.has(key)) {
        skipped++;
        continue;
      }
      const result = await col.updateOne(
        { key },
        { $set: { ...doc, updatedAt: new Date() } },
        { upsert: true }
      );
      if (result.upsertedCount) inserted++;
      else if (result.modifiedCount) updated++;
    }
    console.log(`   MongoDB: ${inserted} inserido(s), ${updated} atualizado(s)${skipped > 0 ? `, ${skipped} já existente(s) (ignorados)` : ''} em ${DB_NAME}.${COLLECTION}`);
    return `${DB_NAME}.${COLLECTION}`;
  } catch (err) {
    console.error('Erro ao gravar no MongoDB:', err.message);
    return null;
  } finally {
    await client.close();
  }
}

async function clearMongoCollection() {
  const uri = process.env.MONGO_URI;
  if (!uri) return;
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const col = db.collection(COLLECTION);
    const count = await col.countDocuments();
    if (count > 0) {
      await col.deleteMany({});
      console.log(`   🗑️ MongoDB: Coleção ${DB_NAME}.${COLLECTION} limpa (${count} documentos removidos).`);
    }
  } catch (err) {
    console.error('Erro ao limpar MongoDB:', err.message);
  } finally {
    await client.close();
  }
}

async function main() {
  const startTime = Date.now();
  const opts = parseArgs();
  const years = opts.years && opts.years.length > 0 ? opts.years : [opts.year];
  const months = opts.months;

  if (!process.env.JIRA_USER || !process.env.JIRA_TOKEN) {
    console.error('Defina JIRA_USER e JIRA_TOKEN no .env');
    process.exit(1);
  }
  if (!process.env.JIRA_BASE_URL) {
    console.error('Defina JIRA_BASE_URL no .env (ex.: https://sua-org.atlassian.net)');
    process.exit(1);
  }

  console.log('\n📋 Extração DORA/Flow — Jira → CSV + MongoDB');
  if (opts.fromJan2026ToToday) {
    console.log('   Período: jan/2026 até hoje (padrão quando não informa --year)');
  } else {
    console.log(`   Ano(s): ${years.join(', ')}${years.length > 1 ? '' : `, meses: ${months}`}`);
  }
  if (opts.mongo) console.log(`   Mongo: ${opts.skipExisting ? 'só insere keys novas (--skip-existing)' : 'insere e atualiza (padrão)'}`);
  if (opts.clearDb) await clearMongoCollection();
  console.log('');

  const devJsonPath = process.env.DEVELOPERS_JSON
    ? path.isAbsolute(process.env.DEVELOPERS_JSON)
      ? process.env.DEVELOPERS_JSON
      : path.join(ROOT, process.env.DEVELOPERS_JSON)
    : path.join(ROOT, 'developers.json');

  if (opts.syncDevelopers && process.env.JIRA_BOARD_ID) {
    const boardIds = process.env.JIRA_BOARD_ID.split(',').map((s) => s.trim()).filter(Boolean);
    if (boardIds.length > 0) {
      try {
        const { syncDevelopersFromBoards } = await import('./lib/syncDevelopersFromBoards.js');
        const auth = { username: process.env.JIRA_USER, password: process.env.JIRA_TOKEN };
        const syncResult = await syncDevelopersFromBoards({
          boardIds,
          developersPath: devJsonPath,
          baseUrl: process.env.JIRA_BASE_URL.replace(/\/$/, ''),
          auth,
        });
        if (syncResult.uniqueAssignees === 0) {
          console.log(
            '   ⚠️ Nenhum assignee com e-mail encontrado nas issues dos boards (ver permissões / privacidade de e-mail no Jira). developers.json não foi alterado por esta etapa.'
          );
        } else if (syncResult.updated) {
          console.log(
            `   Lista atualizada: +${syncResult.added} novo(s), ${syncResult.nameOrAccountUpdates} registo(s) ajustados (nome/accountId). ` +
              `${syncResult.uniqueAssignees} pessoa(s) única(s) nos boards (${syncResult.boardRequests} pedido(s) à API).`
          );
          if (syncResult.skippedNoEmail > 0) {
            console.log(
              `   ⚠️ ${syncResult.skippedNoEmail} ocorrência(s) de assignee sem e-mail visível (ignoradas).`
            );
          }
        } else {
          console.log(
            `   Lista de pessoas: OK (nada a alterar). ${syncResult.uniqueAssignees} pessoa(s) única(s) nos boards.`
          );
          if (syncResult.skippedNoEmail > 0) {
            console.log(`   ⚠️ ${syncResult.skippedNoEmail} ocorrência(s) sem e-mail visível nos issues dos boards.`);
          }
        }
      } catch (e) {
        console.warn(`   ⚠️ Sincronização pelos boards falhou: ${e.message}. A usar developers.json sem alterar.`);
      }
    }
  } else if (opts.syncDevelopers && !process.env.JIRA_BOARD_ID) {
    console.log('   (Sem JIRA_BOARD_ID: não sincroniza lista automaticamente. Defina no .env ou use developers.json manual.)');
  }

  const developerService = new DeveloperService(devJsonPath);
  const allDevelopers = await developerService.getAllDevelopers();
  if (!allDevelopers || allDevelopers.length === 0) {
    console.error('Nenhum desenvolvedor: coloque developers.json nesta pasta ou defina DEVELOPERS_JSON=/caminho/absoluto/developers.json');
    process.exit(1);
  }

  const developersMap = {};
  allDevelopers.forEach((dev) => {
    developersMap[dev.email.toLowerCase()] = {
      name: dev.name,
      email: dev.email,
      role: dev.role || 'N/A',
      role2: dev.role2 || dev.role,
      roleCategory: dev.roleCategory || 'outros',
      squad: dev.squad || 'N/A',
      tribe: dev.tribe || 'N/A'
    };
  });

  const devRoot = await developerService.loadDevelopers();
  let squadCtx = { byProject: {}, projectFromBoard: {} };
  try {
    squadCtx = await buildSquadResolutionContext(devRoot, process.env.JIRA_BOARD_ID, getProjectKeysFromBoard);
    const nP = Object.keys(squadCtx.byProject || {}).length;
    const nB = Object.keys(squadCtx.projectFromBoard || {}).length;
    console.log(
      `   Squad (developers.json): ${nP} entrada(s) em squadByProjectKey; ${nB} projeto(s) cobertos por squadByBoardId + JIRA_BOARD_ID.`
    );
  } catch (e) {
    console.warn(`   ⚠️ Mapa squad por projeto/board falhou: ${e.message} — fallback: squad do assignee.`);
  }

  const allIssues = [];
  for (const year of years) {
    const startDate = new Date(year, 0, 1);
    let endDate = new Date(year, 11, 31);
    if (opts.fromJan2026ToToday && year === 2026) {
      endDate = new Date();
    }
    const periodStart = new Date(startDate);
    periodStart.setDate(periodStart.getDate() - 1);
    const periodEnd = new Date(endDate);
    periodEnd.setDate(periodEnd.getDate() + 1);
    const now = new Date();
    const monthsForYear = opts.fromJan2026ToToday && year === 2026
      ? Math.max(1, (now.getFullYear() - 2026) * 12 + (now.getMonth() + 1))
      : (years.length > 1 ? 12 : months);
    const spinDev = createSpinner(
      `${years.length > 1 ? `[${year}] ` : ''}Jira · 0/${allDevelopers.length} · a iniciar…`
    );
    try {
      for (let i = 0; i < allDevelopers.length; i++) {
        const dev = allDevelopers[i];
        const shortName = (dev.name || dev.email || '?').slice(0, 48);
        const squadName = dev.squad || 'N/A';
        spinDev.update(
          `${years.length > 1 ? `[${year}] ` : ''}Jira ${i + 1}/${allDevelopers.length} · ${shortName} (${squadName}) · a pedir issues (API pode demorar)…`
        );
        try {
          const assigneeHints = {
            username: dev.username,
            name: dev.name,
            jiraAccountId: dev.jiraAccountId
          };
          const issues = await buscarHistoricoTasksPorEmail(dev.email, monthsForYear, year, assigneeHints);
          const completed = (issues || []).filter((issue) => {
            if (!issue.resolved) return false;
            return resolvedDateInRange(issue.resolved, periodStart, periodEnd);
          });
          const devInfo = developersMap[dev.email.toLowerCase()] || {};
          completed.forEach((issue) => {
            const squadRes = resolveSquadForIssue(issue.projectKey, devInfo, squadCtx);
            allIssues.push(enrichIssue(issue, devInfo, squadRes));
          });
          spinDev.update(
            `${years.length > 1 ? `[${year}] ` : ''}Jira ${i + 1}/${allDevelopers.length} · ${shortName} · +${completed.length} concluída(s) no período`
          );
        } catch (e) {
          process.stdout.write('\n');
          console.warn(`   ⚠️ Erro ao buscar ${dev.email}: ${e.message}`);
          spinDev.update(`${years.length > 1 ? `[${year}] ` : ''}Jira · a continuar após erro…`);
        }
      }
    } finally {
      spinDev.clear();
    }
    if (years.length > 1) console.log(`   [${year}] ${allIssues.length} issues acumuladas até agora.`);
  }
  const uniqueKeysAfterFetch = new Set(allIssues.map((i) => i.key).filter(Boolean)).size;
  console.log(`\n   ✅ ${allIssues.length} linha(s) com issues concluídas no(s) período(s) (soma por assignee).`);
  console.log(`   📌 ${uniqueKeysAfterFetch} chave(s) Jira única(s) (várias linhas com a mesma key = mesma issue contada em mais do que um dev).`);

  if (allIssues.length === 0) {
    console.log('Nenhuma issue para exportar.');
    const first = allDevelopers[0];
    if (first?.email) {
      const y = years[0];
      const startDate = new Date(y, 0, 1);
      let endDate = new Date(y, 11, 31);
      if (opts.fromJan2026ToToday && y === 2026) endDate = new Date();
      const periodStart = new Date(startDate);
      periodStart.setDate(periodStart.getDate() - 1);
      const periodEnd = new Date(endDate);
      periodEnd.setDate(periodEnd.getDate() + 1);
      const lo = toYmd(periodStart);
      const hi = toYmd(periodEnd);
      const monthsForDiag =
        opts.fromJan2026ToToday && y === 2026
          ? Math.max(1, (new Date().getFullYear() - 2026) * 12 + (new Date().getMonth() + 1))
          : years.length > 1
            ? 12
            : months;
      console.log('\n   🔎 Diagnóstico (primeiro dev da lista):');
      const spinDiag = createSpinner('      Diagnóstico · a pedir histórico ao Jira (pode demorar)…');
      try {
        const firstHints = {
          username: first.username,
          name: first.name,
          jiraAccountId: first.jiraAccountId
        };
        const raw = await buscarHistoricoTasksPorEmail(first.email, monthsForDiag, y, firstHints);
        spinDiag.clear();
        const nRaw = raw?.length ?? 0;
        const nWithResolved = (raw || []).filter((i) => i.resolved).length;
        const nInWindow = (raw || []).filter((i) => i.resolved && resolvedDateInRange(i.resolved, periodStart, periodEnd)).length;
        console.log(`      Assignee testado: ${first.email}`);
        console.log(`      Janela de resolução (YYYY-MM-DD): ${lo} .. ${hi}`);
        console.log(`      Issues retornadas pela API (após processar): ${nRaw}`);
        console.log(`      Com campo resolved preenchido: ${nWithResolved}`);
        console.log(`      Com resolução dentro da janela: ${nInWindow}`);
        if (nRaw > 0 && nWithResolved === 0) {
          const keys = (raw || []).slice(0, 5).map((i) => i.key).join(', ');
          console.log(`      Amostra de keys sem resolved: ${keys || '—'}`);
        }
        if (nWithResolved > 0 && nInWindow === 0) {
          const sample = (raw || [])
            .filter((i) => i.resolved)
            .slice(0, 8)
            .map((i) => `${i.key}→${String(i.resolved).slice(0, 10)}`);
          console.log(`      Resoluções fora da janela (amostra): ${sample.join('; ')}`);
        }
        if (nRaw === 0) {
          console.log(
            '      → Nenhuma issue na busca JQL para esse usuário. O fluxo tenta várias queries em /rest/api/3/user/search (e-mail, usuário, nome) para obter accountId; sem isso o fallback assignee por e-mail costuma retornar vazio no Jira Cloud.'
          );
          console.log(
            '        Verifique: token com acesso ao Jira, permissão global "Browse users and groups" (user/search), JIRA_BASE_URL, e-mail no perfil Atlassian. Opcional em developers.json: campo "jiraAccountId" (Atlassian account id) por pessoa.'
          );
        }
      } catch (e) {
        spinDiag.clear();
        console.log(`      Erro na busca de diagnóstico: ${e.message}`);
      }
    }
    return;
  }

  const spinSp = createSpinner('   Sprint dimension · a enriquecer metadados (API Jira)…');
  const sprintDimension = await enrichSprintDimension(allIssues);
  spinSp.clear();
  console.log('   Sprint dimension: concluído.');
  const enrichedIssues = allIssues.map((issue) => applySprintDimension({ ...issue }, sprintDimension));

  const uniqueByKey = new Map();
  enrichedIssues.forEach((issue) => {
    uniqueByKey.set(issue.key, issue);
  });
  const uniqueIssues = Array.from(uniqueByKey.values());
  if (uniqueIssues.length < enrichedIssues.length) {
    console.log(`   Dedup por key: ${enrichedIssues.length} → ${uniqueIssues.length} issues.`);
  }

  const statusHistoryMap = new Map();
  uniqueIssues.forEach((issue) => {
    if (issue.statusHistory && issue.statusHistory.length > 0) {
      statusHistoryMap.set(issue.key, issue.statusHistory);
    }
  });
  const sortedStatuses = collectSortedStatuses(uniqueIssues);

  const formatStats = { clampedNegativeCount: 0 };
  const formatted = uniqueIssues.map((issue) =>
    formatIssueForExport(issue, sortedStatuses, statusHistoryMap, formatStats)
  );
  const rows = consolidateSprintAndDedup(formatted, sprintDimension);

  if (formatStats.clampedNegativeCount > 0) {
    console.log(`   ⚠️ timeInStatus: ${formatStats.clampedNegativeCount} valor(es) negativo(s) corrigido(s) para 0.`);
  }

  const invalidCount = rows.filter((r) => r.invalidForCT).length;
  if (invalidCount > 0) {
    console.log(`   ⚠️ Datas inválidas (end < start ou vazias): ${invalidCount} issues (ctDays não calculado).`);
  }

  const headers = [
    'key', 'title', 'projectKey', 'projectName', 'tribe', 'squad', 'squadSource', 'stack', 'assignee', 'seniority', 'function',
    'workType', 'lane', 'issueType', 'parentKey', 'parentType', 'priority', 'status',
    'sp', 'ctDays', 'leadTimeDays', 'idleBeforeWorkDays', 'cycleTimeSource', 'ctHadActiveTransition', 'ctProxyKind',
    'invalidForCT', 'createdAt', 'createdAtTs', 'start', 'end', 'resolvedAt', 'resolvedAtTs',
    'blockedHours', 'queueTimeDays', 'touchTimeDays', 'waitTimeDays', 'flowEfficiency',
    'sprintCount', 'isScopeCreep', 'predictabilityIndex', 'reviewLatencyDays',
    'hasDependencies', 'clonesCount', 'clonedByCount', 'handoffCount', 'assigneeCount', 'tooManyCooks', 'communicationComplexity', 'statusChanges', 'wasReopened',
    'statusInitial', 'statusFinal',
    ...sortedStatuses.map((s) => `timeInStatus_lifetime_${s}`),
    ...sortedStatuses.map((s) => `timeInStatus_windowed_${s}`),
    'sprintNames', 'lastSprintName', 'lastSprintStartDate', 'lastSprintEndDate',
    'lastAddedToSprintAt', 'wasRemovedFromSprint', 'lastRemovedFromSprintAt',
    'sprintCreated', 'sprintResolved', 'epic', 'labels'
  ];

  const periodLabel = `DORA_Flow_${years.join('_')}`;
  const dataExport = new Date().toISOString().slice(0, 10);
  const anoMes = dataExport.slice(0, 7);

  if (opts.csv) {
    const csvPath = saveCSV(rows, headers, periodLabel);
    console.log(`   CSV: ${csvPath}`);
  }

  if (opts.mongo) {
    const spinMongo = createSpinner('   MongoDB · a gravar/atualizar documentos…');
    await saveToMongo(rows, dataExport, anoMes, opts.skipExisting);
    spinMongo.clear();
  }

  console.log('\n✅ Extração concluída.');
  const totalSeconds = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  console.log(`⏱️ Tempo total: ${minutes}m ${seconds}s\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
