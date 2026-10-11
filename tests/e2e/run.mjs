const allowed = new Set(['tests/e2e/session.spec.js']);
const selected = process.argv.slice(2);
if (selected.some((path) => !allowed.has(path)) || selected.length > 1) {
  process.stderr.write('Unknown Task 4 E2E selection. Use: npm run test:e2e -- tests/e2e/session.spec.js\n');
  process.exitCode = 2;
} else {
  await import('./session.spec.js');
}
