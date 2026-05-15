import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const eventName = process.argv[2] || '';
const input = await readHookInput();
const rootDir = findRepoRoot(input.cwd || process.cwd());

switch (eventName || input.hook_event_name) {
  case 'SessionStart':
    writeJson(additionalContext('SessionStart', sessionStartContext()));
    break;
  case 'UserPromptSubmit':
    handleUserPromptSubmit();
    break;
  case 'PreToolUse':
    handlePreToolUse();
    break;
  case 'PermissionRequest':
    handlePermissionRequest();
    break;
  case 'PostToolUse':
    handlePostToolUse();
    break;
  case 'Stop':
    handleStop();
    break;
  default:
    process.exit(0);
}

async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function findRepoRoot(startDir) {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir,
    encoding: 'utf8',
    windowsHide: true,
  });

  const gitRoot = git.stdout?.trim();
  if (git.status === 0 && gitRoot) {
    return gitRoot;
  }

  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'memory'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function additionalContext(hookEventName, text) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: text,
    },
  };
}

function readSafe(relativePath) {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
  } catch {
    return '';
  }
}

function recentSessionFiles(limit = 3) {
  const sessionsDir = path.join(rootDir, 'memory', '05_Agent_Session_Logs');
  try {
    return fs.readdirSync(sessionsDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({
        file,
        mtimeMs: fs.statSync(path.join(sessionsDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((item) => item.file);
  } catch {
    return [];
  }
}

function latestSessionLog() {
  const sessionsDir = path.join(rootDir, 'memory', '05_Agent_Session_Logs');
  try {
    const latest = fs.readdirSync(sessionsDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({
        file,
        full: path.join(sessionsDir, file),
        mtimeMs: fs.statSync(path.join(sessionsDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return latest || null;
  } catch {
    return null;
  }
}

function sessionStartContext() {
  const goals = readSafe('memory/00_Index/Goals.md');
  const recent = recentSessionFiles();
  const activeGoalLines = goals
    .split(/\r?\n/)
    .filter((line) => /^### G-\d+/.test(line))
    .slice(0, 4);

  return [
    'SPX Codex auto hooks are active.',
    'Before meaningful work, load Memory Vault context: memory/AGENTS.md, memory/00_Index/MOC-Home.md, memory/AGENT-IDENTITY.md, memory/00_Index/Goals.md, and relevant recent session logs.',
    'Use repo-local skills when useful: $spx-session-start, $spx-awaken, $spx-self-check, $spx-multi-perspective, $spx-dream, $spx-session-end, $spx-memory-verify.',
    activeGoalLines.length ? `Active goals: ${activeGoalLines.join(' | ')}` : 'Active goals: read memory/00_Index/Goals.md before planning.',
    recent.length ? `Recent session logs: ${recent.join(', ')}` : 'No recent session logs found.',
    'After meaningful work, write a session log and run npm run memory:verify for memory-only changes or npm run verify for code + memory changes.',
  ].join('\n');
}

function handleUserPromptSubmit() {
  const prompt = String(input.prompt || '');
  if (looksLikeSecretPaste(prompt)) {
    writeJson({
      decision: 'block',
      reason: 'Prompt appears to include a pasted secret or credential. Redact the value and resend the request.',
    });
    return;
  }

  const context = [];
  context.push('SPX auto prompt hook: follow root AGENTS.md and Memory Vault retrieval rules before acting.');

  if (isRiskyPrompt(prompt)) {
    context.push('Risky-work trigger matched: run SPX self-check before edits or claims. Check source of truth, matching mistakes/runbooks, production risk, and verification gate.');
  }

  if (mentionsCloseout(prompt)) {
    context.push('Closeout trigger matched: if meaningful work was completed, write a session log and run the appropriate memory/code verification gate before final response.');
  }

  writeJson(additionalContext('UserPromptSubmit', context.join('\n')));
}

function looksLikeSecretPaste(text) {
  const assignmentPattern = /\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|COOKIE|WEBHOOK[_-]?URL|CHANNEL[_-]?ACCESS[_-]?TOKEN)\s*=\s*["']?[A-Za-z0-9_./+=:@-]{12,}/i;
  const openAiKeyPattern = /\bsk-[A-Za-z0-9_-]{20,}\b/;
  return assignmentPattern.test(text) || openAiKeyPattern.test(text);
}

function isRiskyPrompt(text) {
  return /\b(production|prod|deploy|schema|db|database|migration|auth|secret|token|password|delete|drop|reset|rewrite|refactor|multi-file|commit|push|merge|docker|notify|notification|auto-accept)\b/i.test(text);
}

function mentionsCloseout(text) {
  return /\b(done|finished|finish|save this|session-end|session end|memory verify|verify|ship it)\b/i.test(text)
    || /เสร็จ|บันทึก|จบงาน|ตรวจ memory/i.test(text);
}

function handlePreToolUse() {
  const toolName = String(input.tool_name || '');
  const command = toolCommandText(input.tool_input);
  const denial = blockedToolReason(toolName, command);

  if (denial) {
    writeJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denial,
      },
    });
  }
}

function handlePermissionRequest() {
  const toolName = String(input.tool_name || '');
  const command = toolCommandText(input.tool_input);
  const denial = blockedToolReason(toolName, command);

  if (!denial) {
    process.exit(0);
  }

  writeJson({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: denial,
      },
    },
  });
}

function handlePostToolUse() {
  const toolName = String(input.tool_name || '');
  const command = toolCommandText(input.tool_input);
  const notes = [];

  if (/apply_patch|Edit|Write/i.test(toolName) || /\*\*\* (Add|Update|Delete) File:/i.test(command)) {
    notes.push('File edits detected. Keep changes scoped, do not revert user changes, and update the session log after meaningful work.');
  }

  if (/\bnpm\s+run\s+memory:verify\b/i.test(command)) {
    notes.push('Memory gate was run. Summarize the pass/fail status and score in the final response or session log.');
  }

  if (/\bnpm\s+run\s+verify\b/i.test(command)) {
    notes.push('Full verification gate was run. Summarize build and memory results before final response.');
  }

  if (notes.length) {
    writeJson(additionalContext('PostToolUse', notes.join('\n')));
  }
}

function handleStop() {
  if (input.stop_hook_active) {
    writeJson({ continue: true });
    return;
  }

  const changed = gitStatusPaths();
  const meaningful = changed.filter(isMeaningfulPath);
  if (!meaningful.length) {
    writeJson({ continue: true });
    return;
  }

  const latest = latestSessionLog();
  const latestText = latest ? readFile(latest.full) : '';
  const latestChangeMs = newestMtime(meaningful);
  const hasFreshTodayLog = Boolean(latest && latest.file.startsWith(todayIso()) && latest.mtimeMs >= latestChangeMs - 1000);
  const memoryChanged = changed.some((file) => file.startsWith('memory/'));
  const codeOrConfigChanged = changed.some(isCodeOrConfigPath);
  const latestMentionsMemoryGate = /\bnpm run memory:verify\b/.test(latestText) || /\bnpm run verify\b/.test(latestText);
  const latestMentionsFullGate = /\bnpm run verify\b/.test(latestText);
  const reminders = [];

  if (!hasFreshTodayLog) {
    reminders.push('Write a session log in memory/05_Agent_Session_Logs/ for this meaningful work.');
  }

  if (memoryChanged && (!hasFreshTodayLog || !latestMentionsMemoryGate)) {
    reminders.push('Run npm run memory:verify and record the result.');
  }

  if (codeOrConfigChanged && (!hasFreshTodayLog || !latestMentionsFullGate)) {
    reminders.push('Run npm run verify for code/config + memory changes, or explain why it is not applicable.');
  }

  if (!reminders.length) {
    writeJson({ continue: true });
    return;
  }

  writeJson({
    decision: 'block',
    reason: [
      'SPX auto closeout required before final response:',
      ...reminders.map((item) => `- ${item}`),
      'Continue by completing the closeout, then provide the final answer.',
    ].join('\n'),
  });
}

function toolCommandText(toolInput) {
  if (!toolInput) {
    return '';
  }

  if (typeof toolInput === 'string') {
    return toolInput;
  }

  if (typeof toolInput.command === 'string') {
    return toolInput.command;
  }

  if (typeof toolInput.patch === 'string') {
    return toolInput.patch;
  }

  try {
    return JSON.stringify(toolInput);
  } catch {
    return '';
  }
}

function blockedToolReason(toolName, command) {
  const text = `${toolName}\n${command}`;

  const blockedPatterns = [
    {
      pattern: /\bgit\s+reset\s+--hard\b/i,
      reason: 'Blocked by SPX policy: do not run git reset --hard unless the user explicitly asks for it.',
    },
    {
      pattern: /\bgit\s+clean\s+-f/i,
      reason: 'Blocked by SPX policy: destructive git clean requires explicit user request.',
    },
    {
      pattern: /\brm\s+-rf\b/i,
      reason: 'Blocked by SPX policy: recursive delete requires explicit user request and path verification.',
    },
    {
      pattern: /\bRemove-Item\b[\s\S]*\s-(?:Recurse|r)\b/i,
      reason: 'Blocked by SPX policy: recursive Remove-Item requires explicit user request and path verification.',
    },
    {
      pattern: /\b(?:Get-Content|gc|type|cat|Select-String)\b[\s\S]*(?:^|[\\/\s'"])\.env(?:$|[\s'"])/i,
      reason: 'Blocked by SPX policy: never read or print root .env secret values.',
    },
    {
      pattern: /\$env:(?:DB_PASSWORD|COOKIE|JWT_SECRET|COOKIE_SECRET|LINE_CHANNEL_ACCESS_TOKEN|DISCORD_WEBHOOK_URL)\b/i,
      reason: 'Blocked by SPX policy: never print secret environment variables.',
    },
    {
      pattern: /\bDROP\s+(?:DATABASE|SCHEMA)\b/i,
      reason: 'Blocked by SPX policy: destructive DB DDL requires explicit user request and migration plan.',
    },
    {
      pattern: /\bTRUNCATE\s+TABLE\b/i,
      reason: 'Blocked by SPX policy: destructive DB operation requires explicit user request.',
    },
    {
      pattern: /^\*\*\* (?:Add|Update|Delete) File: (?:dist|data|logs|node_modules)\//im,
      reason: 'Blocked by SPX policy: do not edit generated/runtime folders.',
    },
    {
      pattern: /^\*\*\* (?:Add|Update|Delete) File: \.env(?:$|\s)/im,
      reason: 'Blocked by SPX policy: do not edit .env unless the user explicitly asks and secrets are protected.',
    },
  ];

  return blockedPatterns.find(({ pattern }) => pattern.test(text))?.reason || '';
}

function gitStatusPaths() {
  const result = spawnSync('git', ['status', '--short', '--untracked-files=all'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^.. /, '').replace(/^.* -> /, '').replace(/\\/g, '/'));
}

function isMeaningfulPath(file) {
  return isCodeOrConfigPath(file) || file.startsWith('memory/');
}

function isCodeOrConfigPath(file) {
  return [
    '.codex/',
    '.agents/',
    '.cursor/',
    '.windsurf/',
    '.github/',
    'src/',
    'migrations/',
    'scripts/',
    'docs/',
  ].some((prefix) => file.startsWith(prefix))
    || [
      '.gitignore',
      'package.json',
      'package-lock.json',
      'Dockerfile',
      'docker-compose.yml',
      'AGENTS.md',
      'opencode.json',
      'tsconfig.json',
      'vite.config.ts',
    ].includes(file);
}

function newestMtime(files) {
  const times = files
    .map((file) => {
      try {
        return fs.statSync(path.join(rootDir, file)).mtimeMs;
      } catch {
        return 0;
      }
    })
    .filter(Boolean);

  return times.length ? Math.max(...times) : 0;
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
