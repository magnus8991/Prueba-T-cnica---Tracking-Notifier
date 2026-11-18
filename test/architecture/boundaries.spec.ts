import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Protege la arquitectura hexagonal: el núcleo (domain + application) no depende
 * de frameworks, ORM/driver, APIs de Node ni adaptadores de infraestructura.
 */
const SRC = join(__dirname, '..', '..', 'src');
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]!).filter(Boolean);
}

const isExternal = (spec: string) => !spec.startsWith('.');

describe('Fronteras de la arquitectura hexagonal', () => {
  it('domain/ no importa nada externo ni capas exteriores', () => {
    const violations = filesUnder(join(SRC, 'domain')).flatMap((file) =>
      importsOf(file)
        .filter((spec) => isExternal(spec) || /application|infrastructure/.test(spec))
        .map((spec) => `${relative(SRC, file)} -> ${spec}`),
    );
    expect(violations).toEqual([]);
  });

  it('application/ solo depende de domain/ (sin frameworks, Node APIs ni infraestructura)', () => {
    const violations = filesUnder(join(SRC, 'application')).flatMap((file) =>
      importsOf(file)
        .filter((spec) => isExternal(spec) || /infrastructure/.test(spec))
        .map((spec) => `${relative(SRC, file)} -> ${spec}`),
    );
    expect(violations).toEqual([]);
  });

  it('application/ no usa decoradores de framework', () => {
    const offenders = filesUnder(join(SRC, 'application')).filter((file) => /@(Injectable|Inject|Module|Controller)\(/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
