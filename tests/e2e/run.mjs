import { runSessionProof } from './blog-admin-session.mjs';
import { runMediaProof } from './blog-media.mjs';
import { runPublicationProof } from './blog-publication.mjs';

const allowed = new Map([
  ['tests/e2e/session.spec.js', runSessionProof],
  ['tests/e2e/media.spec.js', runMediaProof],
  ['tests/e2e/publication.spec.js', runPublicationProof],
]);
const selected = process.argv.slice(2);
if (selected.length !== 1 || !allowed.has(selected[0])) {
  process.stderr.write('Choose one E2E proof: tests/e2e/session.spec.js, tests/e2e/media.spec.js, or tests/e2e/publication.spec.js\n');
  process.exitCode = 2;
} else {
  await allowed.get(selected[0])();
}
