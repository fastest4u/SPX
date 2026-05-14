import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const goalsPath = path.join(rootDir, 'memory', '00_Index', 'Goals.md');
const followupsPath = path.join(rootDir, 'memory', '00_Index', 'Open-Followups.md');
const dashboardPath = path.join(rootDir, 'memory', '00_Index', 'Vault-Dashboard.md');
const resultsPath = path.join(rootDir, 'memory', '00_Index', 'Multi-AI-Acceptance-Results.md');
const sessionsDir = path.join(rootDir, 'memory', '05_Agent_Session_Logs');

function readSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function latestSessionLog() {
  try {
    const latest = fs.readdirSync(sessionsDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({
        file,
        full: path.join(sessionsDir, file),
        mtimeMs: fs.statSync(path.join(sessionsDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return latest?.full ?? null;
  } catch {
    return null;
  }
}

const goals = readSafe(goalsPath);
const followups = readSafe(followupsPath);
const dashboard = readSafe(dashboardPath);
const results = readSafe(resultsPath);
const latestLog = latestSessionLog();
const latestLogText = latestLog ? readSafe(latestLog) : '';

const openTasks = (latestLogText.match(/^- \[ \] /gm) || []).length;
const closedTasks = (latestLogText.match(/^- \[(x|X)\] /gm) || []).length;
const passCount = (results.match(/\|\s*pass\s*\|/g) || []).length;
const pendingCount = (results.match(/\|\s*pending\s*\|/g) || []).length;

const requiredSections = [
  { label: 'summary section', patterns: [/^##\s+Summary$/im, /^##\s+TL;DR$/im] },
  { label: 'log section', patterns: [/^##\s+Log$/im, /^##\s+Session Log$/im, /^##\s+What Was Done$/im] },
  { label: 'verification section', patterns: [/^##\s+Verification$/im, /^##\s+Quality Checks/i] },
  { label: 'follow-ups section', patterns: [/^##\s+Follow-?ups$/im, /^##\s+Open Issues\s*\/\s*Follow-?ups$/im] },
];

const missingSections = latestLogText
  ? requiredSections
      .filter(({ patterns }) => !patterns.some((pattern) => pattern.test(latestLogText)))
      .map(({ label }) => label)
  : [];

const lines = [
  'Session end automation active.',
  'Before stopping: write or update the session log, capture open follow-ups, and update durable notes if truth changed.',
  `Latest session log open tasks: ${openTasks}`,
  `Latest session log closed tasks: ${closedTasks}`,
  `Multi-AI acceptance snapshot: ${passCount} pass, ${pendingCount} pending.`,
  dashboard.includes('Vault Dashboard') || dashboard.includes('Vault Status') ? 'Vault dashboard is present; review it when memory hygiene changes.' : 'Vault dashboard not found.',
  goals.includes('G-003') ? 'Goal G-003 still tracks re-explanation reduction; preserve retrieval discipline.' : 'Goal G-003 not found.',
  followups.includes('Open Follow-Ups') ? 'Open-Followups dashboard is present; promote recurring work instead of leaving it buried.' : 'Open-Followups dashboard not found.',
  latestLog ? `Latest session log: ${path.relative(rootDir, latestLog)}` : 'No session logs found.',
  missingSections.length > 0
    ? `Latest session log is older template style; missing recommended sections: ${missingSections.join(', ')}.`
    : 'Latest session log includes the recommended sections.',
];

console.log(JSON.stringify({ additional_context: lines.join('\n') }));