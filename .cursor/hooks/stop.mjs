import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const latestSessionDir = path.join(rootDir, 'memory', '05_Agent_Session_Logs');

function readSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function latestSessionLog() {
  try {
    const latest = fs.readdirSync(latestSessionDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({
        file,
        full: path.join(latestSessionDir, file),
        mtimeMs: fs.statSync(path.join(latestSessionDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return latest?.full ?? null;
  } catch {
    return null;
  }
}

const latestLog = latestSessionLog();
const latestLogText = latestLog ? readSafe(latestLog) : '';
const hasSummary = /##\s+Summary/i.test(latestLogText) || /##\s+TL;DR/i.test(latestLogText);
const hasLog = /##\s+Log/i.test(latestLogText) || /##\s+Session Log/i.test(latestLogText) || /##\s+What Was Done/i.test(latestLogText);
const hasVerify = /##\s+Verify/i.test(latestLogText) || /##\s+Verification/i.test(latestLogText) || /##\s+Quality Checks/i.test(latestLogText);

const message = [
  'On stop, confirm whether the session changed durable truth and whether a session log should be written.',
  'If memory files changed, prefer running npm run memory:verify before ending the session.',
  latestLog ? `Latest session log: ${path.relative(rootDir, latestLog)}` : 'No session logs found.',
  hasSummary ? 'Latest session log includes a summary.' : 'Latest session log is missing a summary section.',
  hasLog ? 'Latest session log includes a log section.' : 'Latest session log is missing a log section.',
  hasVerify ? 'Latest session log includes a verification section.' : 'Latest session log is missing a verification section.',
].join('\n');

console.log(JSON.stringify({ additional_context: message }));
