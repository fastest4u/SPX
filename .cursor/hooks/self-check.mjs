const message = [
  'Self-check reminder for risky work.',
  'Use when the prompt involves production, deploy, schema, db, migration, auth, secrets, or broad refactors.',
  'Check confidence, mistakes, identity, goals, and prior work before proceeding.',
].join('\n');

console.log(JSON.stringify({
  additional_context: message,
}));
