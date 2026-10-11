import { runSessionProof } from './blog-admin-session.mjs';
import { runMediaProof } from './blog-media.mjs';

const allowed = new Map([
  ['tests/e2e/session.spec.js', runSessionProof],
  ['tests/e2e/media.spec.js', runMediaProof],
]);
const selected = process.argv.slice(2);
if (selected.length !== 1 || !allowed.has(selected[0])) {
  process.stderr.write('Choose one E2E proof: tests/e2e/session.spec.js or tests/e2e/media.spec.js\n');
  process.exitCode = 2;
} else {
  await allowed.get(selected[0])();
}
