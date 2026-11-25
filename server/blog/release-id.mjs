const INITIAL_RELEASE_ID = '00000000-0000-0000-0000-000000000001';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isBuildReleaseId(value) {
  return value === INITIAL_RELEASE_ID || (typeof value === 'string' && UUID_PATTERN.test(value));
}
