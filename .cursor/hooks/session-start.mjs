import fs from 'node:fs';
import path from 'node:path';

function readRecentSessions(rootDir, limit = 3) {
  const sessionsDir = path.join(rootDir, 'memory', '05_Agent_Session_Logs');
  try {
    const files = fs.readdirSync(sessionsDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({
        file,
        full: path.join(sessionsDir, file),
        mtimeMs: fs.statSync(path.join(sessionsDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((item) => item.file);
    return files;
  } catch {
    return [];
  }
}

const rootDir = process.cwd();
const recentSessions = readRecentSessions(rootDir);

const messageLines = [
  'Session started: bootstrap Memory Vault first.',
  'Read: memory/AGENTS.md, memory/00_Index/MOC-Home.md, memory/00_Index/Goals.md.',
  'Then inspect the latest session logs before acting.',
];

if (recentSessions.length > 0) {
  messageLines.push(`Recent sessions: ${recentSessions.join(', ')}`);
}

console.log(JSON.stringify({
  additional_context: messageLines.join('\n'),
}));
