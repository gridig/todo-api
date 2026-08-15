import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Config-drift guard. `.env.example` is the only place an operator looks when
// standing up an environment, and several variables are load-bearing at boot:
// production refuses to start without METRICS_TOKEN, real ENCRYPTION_* keys,
// CORS_ORIGIN, RESEND_API_KEY/MAIL_FROM, and a non-localhost APP_BASE_URL. A
// variable declared in env.ts but missing from the example is therefore a failed
// deploy that the operator has no way to anticipate — which is exactly what
// happened when email verification added three required vars and only the
// optional one got documented.
//
// The reverse matters too, if less loudly: an entry left in the example after
// its variable is removed from env.ts is a setting an operator will configure
// and expect to take effect, silently doing nothing.
//
// If a variable legitimately belongs in only one place (e.g. one consumed by a
// sibling service rather than this app), add it to the matching allowlist with a
// reason rather than deleting the assertion.
const ENV_TS_PATH = join(process.cwd(), 'src', 'config', 'env.ts');
const ENV_EXAMPLE_PATH = join(process.cwd(), '.env.example');

// Declared in env.ts but deliberately absent from .env.example.
const ALLOWLIST_UNDOCUMENTED = new Set<string>([
  // e.g. 'INTERNAL_ONLY_FLAG',  // reason: set by the platform, never by hand
]);

// Present in .env.example but deliberately not declared in env.ts.
const ALLOWLIST_STALE = new Set<string>([
  // e.g. 'PGBACKREST_REPO1_S3_KEY',  // reason: consumed by the DB image, not the app
]);

// Pull the names out of the cleanEnv({ ... }) call rather than the whole file,
// so unrelated SCREAMING_CASE constants elsewhere in the module are not mistaken
// for environment variables. Matching `NAME:` at two-space indentation (rather
// than enumerating validator names like str/num/bool) means a new custom
// validator cannot quietly make a variable invisible to this guard.
export function extractDeclaredVars(source: string): string[] {
  const start = source.indexOf('cleanEnv(process.env, {');
  if (start === -1) {
    throw new Error(
      'env-example guard: could not find the cleanEnv(process.env, { … }) call in env.ts — ' +
        'update this parser rather than deleting the guard.',
    );
  }
  const end = source.indexOf('\n});', start);
  if (end === -1) {
    throw new Error('env-example guard: could not find the end of the cleanEnv call in env.ts.');
  }
  const block = source.slice(start, end);
  return [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1] as string);
}

// Both `NAME=value` and the commented-out `# NAME=value` form count as
// documented — optional variables are conventionally shown commented here.
// Anchored to the line start so a variable mentioned mid-sentence in prose
// ("…also set FOO=true…") does not count as documenting it.
export function extractDocumentedVars(text: string): string[] {
  return [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string);
}

describe('config guard: .env.example matches env.ts', () => {
  const declared = extractDeclaredVars(readFileSync(ENV_TS_PATH, 'utf8'));
  const documented = extractDocumentedVars(readFileSync(ENV_EXAMPLE_PATH, 'utf8'));

  // Sanity floor: if a refactor breaks the parser it must fail here, loudly,
  // rather than silently comparing two empty sets and passing forever.
  it('parses a plausible set of variables from both files', () => {
    expect(declared.length).toBeGreaterThan(30);
    expect(documented.length).toBeGreaterThan(30);
    expect(declared).toEqual(expect.arrayContaining(['PORT', 'DATABASE_URL', 'JWT_SECRET']));
    expect(documented).toEqual(expect.arrayContaining(['PORT', 'DATABASE_URL', 'JWT_SECRET']));
  });

  it('declares no variable that .env.example fails to document', () => {
    const documentedSet = new Set(documented);
    const missing = declared.filter(
      (name) => !documentedSet.has(name) && !ALLOWLIST_UNDOCUMENTED.has(name),
    );

    expect(missing).toEqual([]);
  });

  it('documents no variable that env.ts no longer declares', () => {
    const declaredSet = new Set(declared);
    const stale = documented.filter((name) => !declaredSet.has(name) && !ALLOWLIST_STALE.has(name));

    expect(stale).toEqual([]);
  });
});

describe('config guard: parser fixtures', () => {
  it('extracts declared names, ignoring constants outside the cleanEnv call', () => {
    const source = [
      'const JWT_SECRET_MIN_LENGTH = 32;',
      'export const env = cleanEnv(process.env, {',
      "  NODE_ENV: str({ default: 'development' }),",
      '  PORT: port({ default: 3001 }),',
      '  SOME_NEW_KNOB: someCustomValidator({ default: 1 }),',
      '});',
      'export const METRICS_TOKEN_MIN_LENGTH = 32;',
    ].join('\n');

    expect(extractDeclaredVars(source)).toEqual(['NODE_ENV', 'PORT', 'SOME_NEW_KNOB']);
  });

  it('counts both live and commented-out entries as documented', () => {
    const example = ['PORT=3001', '# OPTIONAL_KNOB=5', '#ALSO_OPTIONAL=1'].join('\n');

    expect(extractDocumentedVars(example)).toEqual(['PORT', 'OPTIONAL_KNOB', 'ALSO_OPTIONAL']);
  });

  it('does not count a variable merely mentioned mid-line in prose', () => {
    const example = '# To enable in production, also set DISABLE_RATE_LIMIT=true first.';

    expect(extractDocumentedVars(example)).toEqual([]);
  });

  it('throws rather than passing vacuously when env.ts cannot be parsed', () => {
    expect(() => extractDeclaredVars('export const env = somethingElse();')).toThrow(
      /could not find the cleanEnv/,
    );
  });
});
