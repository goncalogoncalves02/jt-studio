import { runSessionProof } from './blog-admin-session.mjs';
import { runMediaProof } from './blog-media.mjs';
import { runPublicationProof } from './blog-publication.mjs';
import { runEditorProof } from './editor.spec.js';
import { runEditorAccessibilityProof } from './accessibility.spec.js';
import { runFullFlowProof } from './blog-full-flow.mjs';

const allowed = new Map([
  ['tests/e2e/session.spec.js', runSessionProof],
  ['tests/e2e/media.spec.js', runMediaProof],
  ['tests/e2e/publication.spec.js', runPublicationProof],
  ['tests/e2e/editor.spec.js', runEditorProof],
  ['tests/e2e/accessibility.spec.js', runEditorAccessibilityProof],
  ['tests/e2e/full-flow.spec.js', runFullFlowProof],
]);
const selected = process.argv.slice(2);
if (!selected.length || new Set(selected).size !== selected.length || selected.some((file) => !allowed.has(file))) {
  process.stderr.write('Choose E2E proofs: ' + [...allowed.keys()].join(', ') + '\n');
  process.exitCode = 2;
} else {
  for (const file of selected) await allowed.get(file)();
}
