// Architecture tests: a dependency-free import scan that enforces the ADR Confirmation rules.
//   ADR-0002 layers (domain, application, presentation, infrastructure), child_process, z.object
//   ADR-0006 owner channel (engine never imports web)   ADR-0007 @octokit only in infrastructure/github
//   ADR-0008 drizzle-orm/pg only in infrastructure/db   ADR-0015 process.env only in infrastructure/config + main.ts
// Rules are written over layer names and path prefixes, so they apply to folders as they are added.
// Violations are reported as `path:line message`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENGINE_SRC = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(ENGINE_SRC, '..', '..');

interface SourceFile {
  /** Repo-relative POSIX path, e.g. `engine/src/domain/task.ts`. */
  path: string;
  text: string;
}

interface ImportRef {
  specifier: string;
  line: number;
  typeOnly: boolean;
}

interface Violation {
  path: string;
  line: number;
  message: string;
}

const SRC = 'engine/src';
const LAYERS = ['domain', 'application', 'infrastructure', 'presentation'] as const;
const COMPOSITION_ROOT = [`${SRC}/container.ts`, `${SRC}/main.ts`];

const toPosix = (p: string): string => p.split(sep).join('/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Production sources only: tests may import test tooling and node built-ins freely. */
function loadSources(dir: string): SourceFile[] {
  return walk(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !/\.test\.ts$/.test(f))
    .map((f) => ({ path: toPosix(relative(REPO_ROOT, f)), text: readFileSync(f, 'utf8') }));
}

/** Blank out comments (keeping newlines) so commented-out code is not scanned. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function extractImports(rawText: string): ImportRef[] {
  const text = stripComments(rawText);
  const patterns: { re: RegExp; specifierGroup: number; typeGroup: boolean }[] = [
    // import x from 'a' / import type {…} from 'a' / export … from 'a' (possibly multi-line)
    {
      re: /\b(import|export)(\s+type)?\b(?:[^'"`;]*?)\bfrom\s*(['"])([^'"\n]+)\3/g,
      specifierGroup: 4,
      typeGroup: true,
    },
    // side-effect import 'a'
    { re: /\bimport\s*(['"])([^'"\n]+)\1/g, specifierGroup: 2, typeGroup: false },
    // dynamic import('a')
    { re: /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, specifierGroup: 2, typeGroup: false },
  ];
  return patterns.flatMap(({ re, specifierGroup, typeGroup }) =>
    [...text.matchAll(re)].map((m) => ({
      specifier: m[specifierGroup] ?? '',
      line: lineOf(text, m.index ?? 0),
      typeOnly: typeGroup && m[2] !== undefined,
    })),
  );
}

/** `domain`, `application`, `infrastructure`, `presentation`, or `root:<file>` for anything else. */
function layerOf(path: string): string {
  const top = path.slice(SRC.length + 1).split('/')[0] ?? '';
  return (LAYERS as readonly string[]).includes(top) ? top : `root:${top}`;
}

/** Repo-relative path of a relative import, without extension. */
function resolveRelative(fromPath: string, specifier: string): string {
  return posix.join(posix.dirname(fromPath), specifier).replace(/\.(js|ts)$/, '');
}

const insideDir = (target: string, dir: string): boolean =>
  target === dir || target.startsWith(`${dir}/`);
const isShared = (s: string): boolean => s === '@jarvis/shared' || s.startsWith('@jarvis/shared/');
const isRelative = (s: string): boolean => s.startsWith('.');
const matchesPackage = (s: string, pkg: string): boolean => s === pkg || s.startsWith(`${pkg}/`);
const isChildProcess = (s: string): boolean => s === 'child_process' || s === 'node:child_process';

interface LayerRule {
  layer: string;
  /** Returns a reason when the import is not allowed. */
  check: (file: SourceFile, ref: ImportRef) => string | undefined;
}

/** Third-party packages that belong to one layer (or one adapter) and must not leak. */
const FRAMEWORK_PACKAGES = ['fastify', 'drizzle-orm', 'drizzle-kit', 'pg', 'postgres', '@octokit'];

const layerRules: LayerRule[] = [
  {
    // Strict allow-list: domain is plain data and pure functions.
    layer: 'domain',
    check: (file, ref) => {
      if (isRelative(ref.specifier)) {
        return insideDir(resolveRelative(file.path, ref.specifier), `${SRC}/domain`)
          ? undefined
          : `domain imports outside domain/: ${ref.specifier}`;
      }
      if (isShared(ref.specifier)) {
        return ref.typeOnly ? undefined : 'domain must use `import type` from @jarvis/shared';
      }
      return `domain may not import "${ref.specifier}"`;
    },
  },
  {
    layer: 'application',
    check: (file, ref) => {
      if (isRelative(ref.specifier)) {
        const target = resolveRelative(file.path, ref.specifier);
        return insideDir(target, `${SRC}/domain`) || insideDir(target, `${SRC}/application`)
          ? undefined
          : `application imports outside domain/ and application/: ${ref.specifier}`;
      }
      if (isChildProcess(ref.specifier)) return 'application may not spawn processes';
      const banned = FRAMEWORK_PACKAGES.find((p) => matchesPackage(ref.specifier, p));
      if (banned || matchesPackage(ref.specifier, '@fastify')) {
        return `application may not import "${ref.specifier}"`;
      }
      return undefined;
    },
  },
  {
    layer: 'presentation',
    check: (file, ref) => {
      if (isRelative(ref.specifier)) {
        const target = resolveRelative(file.path, ref.specifier);
        const ok =
          insideDir(target, `${SRC}/application`) ||
          insideDir(target, `${SRC}/presentation`) ||
          target === `${SRC}/domain/errors`;
        return ok
          ? undefined
          : `presentation imports outside application/, presentation/ and domain/errors: ${ref.specifier}`;
      }
      const banned = ['drizzle-orm', 'drizzle-kit', 'pg', 'postgres', '@octokit'].find((p) =>
        matchesPackage(ref.specifier, p),
      );
      return banned ? `presentation may not import "${ref.specifier}"` : undefined;
    },
  },
  {
    layer: 'infrastructure',
    check: (file, ref) =>
      isRelative(ref.specifier) &&
      insideDir(resolveRelative(file.path, ref.specifier), `${SRC}/presentation`)
        ? `infrastructure may not import presentation: ${ref.specifier}`
        : undefined,
  },
];

function checkLayer(layer: string, files: SourceFile[]): Violation[] {
  const rule = layerRules.find((r) => r.layer === layer);
  if (!rule) throw new Error(`no rule for layer ${layer}`);
  return files
    .filter((f) => layerOf(f.path) === layer)
    .flatMap((file) =>
      extractImports(file.text).flatMap((ref) => {
        const message = rule.check(file, ref);
        return message ? [{ path: file.path, line: ref.line, message }] : [];
      }),
    );
}

/** A package may only be imported from files whose path starts with one of `allowedPrefixes`. */
function checkPackageHome(
  files: SourceFile[],
  pkgs: string[],
  allowedPrefixes: string[],
  adr: string,
): Violation[] {
  return files
    .filter((f) => !allowedPrefixes.some((prefix) => insideDir(f.path, prefix)))
    .flatMap((file) =>
      extractImports(file.text)
        .filter((ref) => pkgs.some((p) => matchesPackage(ref.specifier, p)))
        .map((ref) => ({
          path: file.path,
          line: ref.line,
          message: `"${ref.specifier}" is only allowed in ${allowedPrefixes.join(', ')} (${adr})`,
        })),
    );
}

function checkChildProcess(files: SourceFile[]): Violation[] {
  return files
    .filter((f) => layerOf(f.path) !== 'infrastructure')
    .flatMap((file) =>
      extractImports(file.text)
        .filter((ref) => isChildProcess(ref.specifier))
        .map((ref) => ({
          path: file.path,
          line: ref.line,
          message: 'child processes are spawned only in infrastructure/ (ADR-0002)',
        })),
    );
}

function checkPattern(
  files: SourceFile[],
  re: RegExp,
  message: string,
  exempt: (file: SourceFile) => boolean = () => false,
): Violation[] {
  return files
    .filter((f) => !exempt(f))
    .flatMap((file) => {
      const text = stripComments(file.text);
      return [...text.matchAll(re)].map((m) => ({
        path: file.path,
        line: lineOf(text, m.index ?? 0),
        message: `${message}: ${m[0]}`,
      }));
    });
}

const ADAPTER_NAME =
  /\bnew\s+[A-Za-z0-9_]*(Repository|Clock|Runner|CodeHost|WorktreeManager|ArtifactStore|OwnerChannel|EventBus|ConfigProvider|UnitOfWork)\s*\(/g;

const fmt = (vs: Violation[]): string[] => vs.map((v) => `${v.path}:${v.line} ${v.message}`);

const engineFiles = loadSources(ENGINE_SRC);
const inLayer = (layer: string): SourceFile[] =>
  engineFiles.filter((f) => layerOf(f.path) === layer);
const sample = (path: string, ...lines: string[]): SourceFile => ({ path, text: lines.join('\n') });

describe('architecture: scanner sanity', () => {
  it('finds domain sources so the rules are not vacuous', () => {
    // contract: an empty scan would make every rule pass trivially
    expect(inLayer('domain').length).toBeGreaterThan(0);
  });

  it('extracts static, multi-line, re-export, side-effect and dynamic imports but ignores comments', () => {
    const refs = extractImports(
      [
        "import type { A } from '@jarvis/shared';",
        'import {',
        '  b,',
        "} from './b.js';",
        "export * from './c';",
        "import './side';",
        "const m = await import('./lazy');",
        "import { type D } from '@jarvis/shared';",
        "// import x from 'commented'",
        "/* import y from 'block' */",
      ].join('\n'),
    );
    expect(refs).toEqual([
      { specifier: '@jarvis/shared', line: 1, typeOnly: true },
      { specifier: './b.js', line: 2, typeOnly: false },
      { specifier: './c', line: 5, typeOnly: false },
      { specifier: '@jarvis/shared', line: 8, typeOnly: false },
      { specifier: './side', line: 6, typeOnly: false },
      { specifier: './lazy', line: 7, typeOnly: false },
    ]);
  });

  it('classifies paths by layer', () => {
    expect(layerOf('engine/src/domain/task.ts')).toBe('domain');
    expect(layerOf('engine/src/infrastructure/db/schema.ts')).toBe('infrastructure');
    expect(layerOf('engine/src/container.ts')).toBe('root:container.ts');
  });
});

describe('architecture: the rules catch violations (synthetic samples)', () => {
  it('domain: infrastructure, runtime shared, zod and node: imports', () => {
    const file = sample(
      'engine/src/domain/x.ts',
      "import type { T } from '@jarvis/shared';",
      "import { db } from '../infrastructure/db/client.js';",
      "import { TaskStageSchema } from '@jarvis/shared';",
      "import { z } from 'zod';",
      "import { readFileSync } from 'node:fs';",
      "import { ok } from './task.js';",
    );
    expect(fmt(checkLayer('domain', [file])).map((v) => v.split(' ')[0])).toEqual([
      'engine/src/domain/x.ts:2',
      'engine/src/domain/x.ts:3',
      'engine/src/domain/x.ts:4',
      'engine/src/domain/x.ts:5',
    ]);
  });

  it('application: infrastructure, presentation, fastify, drizzle-orm and child_process', () => {
    const file = sample(
      'engine/src/application/tasks/x.ts',
      "import { a } from '../../infrastructure/x.js';",
      "import { b } from '../../presentation/y.js';",
      "import Fastify from 'fastify';",
      "import { eq } from 'drizzle-orm/pg-core';",
      "import { spawn } from 'node:child_process';",
      "import { c } from '../ports/c.js';",
      "import { d } from '../../domain/task.js';",
      "import { randomUUID } from 'node:crypto';",
    );
    expect(checkLayer('application', [file])).toHaveLength(5);
  });

  it('presentation: infrastructure and drizzle-orm', () => {
    const file = sample(
      'engine/src/presentation/http/x.ts',
      "import { a } from '../../infrastructure/x.js';",
      "import { eq } from 'drizzle-orm';",
      "import { b } from '../../application/b.js';",
      "import Fastify from 'fastify';",
      "import { DomainError } from '../../domain/errors.js';",
    );
    expect(checkLayer('presentation', [file])).toHaveLength(2);
  });

  it('infrastructure: presentation', () => {
    const file = sample(
      'engine/src/infrastructure/sse/x.ts',
      "import { a } from '../../presentation/http/a.js';",
    );
    expect(checkLayer('infrastructure', [file])).toHaveLength(1);
  });

  it('package homes and child_process', () => {
    const files = [
      sample(
        'engine/src/application/a.ts',
        "import { Octokit } from '@octokit/rest';",
        "import { spawn } from 'node:child_process';",
      ),
      sample('engine/src/infrastructure/git/g.ts', "import { spawn } from 'node:child_process';"),
      sample('engine/src/infrastructure/github/h.ts', "import { Octokit } from '@octokit/rest';"),
    ];
    expect(
      checkPackageHome(files, ['@octokit'], [`${SRC}/infrastructure/github`], 'ADR-0007'),
    ).toHaveLength(1);
    expect(checkChildProcess(files)).toHaveLength(1);
  });

  it('process.env, wall clock and adapter instantiation', () => {
    const files = [
      sample(
        'engine/src/application/a.ts',
        'const k = process.env.X;',
        '// process.env.IN_COMMENT',
        'const d = Date.now();',
      ),
      sample(
        'engine/src/domain/b.ts',
        'const r = Math.random(); const n = new Date(); const ok = new Date(5);',
      ),
      sample('engine/src/presentation/c.ts', 'const r = new TaskRepository();'),
    ];
    expect(checkPattern(files, /\bprocess\.env\b/g, 'env')).toHaveLength(1);
    expect(
      checkPattern(files, /\bDate\.now\b|\bMath\.random\b|\bnew\s+Date\s*\(\s*\)/g, 'clock'),
    ).toHaveLength(3);
    expect(checkPattern(files, ADAPTER_NAME, 'adapter')).toHaveLength(1);
  });
});

describe('architecture: ADR-0002 layers', () => {
  it('domain imports only domain files and `import type` from @jarvis/shared', () => {
    expect(fmt(checkLayer('domain', engineFiles))).toEqual([]);
  });

  it('domain is pure: no wall clock, no randomness, no process or I/O globals', () => {
    expect(
      fmt(
        checkPattern(
          inLayer('domain'),
          /\bDate\.now\b|\bMath\.random\b|\bnew\s+Date\s*\(\s*\)|\bprocess\.|\bconsole\.|\bfetch\s*\(/g,
          'impure domain code',
        ),
      ),
    ).toEqual([]);
  });

  it('application imports no infrastructure, presentation, fastify, drizzle-orm or child_process', () => {
    expect(fmt(checkLayer('application', engineFiles))).toEqual([]);
  });

  it('presentation imports no infrastructure and no drizzle-orm', () => {
    expect(fmt(checkLayer('presentation', engineFiles))).toEqual([]);
  });

  it('presentation defines no wire schemas with z.object (they live in shared)', () => {
    expect(
      fmt(
        checkPattern(
          inLayer('presentation'),
          /\bz\.(strict)?[oO]bject\b/g,
          'z.object in presentation',
        ),
      ),
    ).toEqual([]);
  });

  it('infrastructure does not import presentation', () => {
    expect(fmt(checkLayer('infrastructure', engineFiles))).toEqual([]);
  });

  it('child processes are spawned only in infrastructure', () => {
    expect(fmt(checkChildProcess(engineFiles))).toEqual([]);
  });

  it('only container.ts and main.ts reach into infrastructure or presentation from the root', () => {
    const offenders = engineFiles
      .filter((f) => layerOf(f.path).startsWith('root:') && !COMPOSITION_ROOT.includes(f.path))
      .flatMap((file) =>
        extractImports(file.text)
          .filter((ref) => isRelative(ref.specifier))
          .map((ref) => ({ file, ref, layer: layerOf(resolveRelative(file.path, ref.specifier)) }))
          .filter(({ layer }) => layer === 'infrastructure' || layer === 'presentation')
          .map(({ file: f, ref, layer }) => ({
            path: f.path,
            line: ref.line,
            message: `root file imports ${layer}`,
          })),
      );
    expect(fmt(offenders)).toEqual([]);
  });

  it('concrete adapters are instantiated only in infrastructure, application/testing and container.ts', () => {
    expect(
      fmt(
        checkPattern(
          engineFiles,
          ADAPTER_NAME,
          'adapter instantiated outside container.ts',
          (f) =>
            layerOf(f.path) === 'infrastructure' ||
            insideDir(f.path, `${SRC}/application/testing`) ||
            f.path === `${SRC}/container.ts`,
        ),
      ),
    ).toEqual([]);
  });
});

describe('architecture: ADR-0006 owner channel', () => {
  it('the engine never imports the web package', () => {
    const offenders = engineFiles.flatMap((file) =>
      extractImports(file.text)
        .filter(
          (ref) =>
            matchesPackage(ref.specifier, '@jarvis/web') || /(^|\/)web\/src\//.test(ref.specifier),
        )
        .map((ref) => ({
          path: file.path,
          line: ref.line,
          message: `imports web: ${ref.specifier}`,
        })),
    );
    expect(fmt(offenders)).toEqual([]);
  });

  it('application talks to the owner only through ports (no import of a channel adapter)', () => {
    // contract: adapters live in infrastructure/, which application/ may not import (rule above); this
    // guards the other door, a relative import of any folder named like an owner-channel adapter
    const offenders = inLayer('application').flatMap((file) =>
      extractImports(file.text)
        .filter((ref) => /(^|\/)(web-chat|slack)(\/|$)/.test(ref.specifier))
        .map((ref) => ({
          path: file.path,
          line: ref.line,
          message: `imports channel adapter: ${ref.specifier}`,
        })),
    );
    expect(fmt(offenders)).toEqual([]);
  });
});

describe('architecture: ADR-0007 code host', () => {
  it('@octokit is imported only in infrastructure/github', () => {
    expect(
      fmt(
        checkPackageHome(engineFiles, ['@octokit'], [`${SRC}/infrastructure/github`], 'ADR-0007'),
      ),
    ).toEqual([]);
  });
});

describe('architecture: ADR-0008 persistence', () => {
  it('drizzle-orm, drizzle-kit, pg and postgres are imported only in infrastructure/db', () => {
    expect(
      fmt(
        checkPackageHome(
          engineFiles,
          ['drizzle-orm', 'drizzle-kit', 'pg', 'postgres'],
          [`${SRC}/infrastructure/db`],
          'ADR-0008',
        ),
      ),
    ).toEqual([]);
  });

  it('no code updates or deletes task_events (the journal is append-only)', () => {
    expect(
      fmt(
        checkPattern(
          engineFiles,
          /update\(\s*taskEvents\s*\)|delete\(\s*taskEvents\s*\)|UPDATE\s+task_events\b|DELETE\s+FROM\s+task_events\b/gi,
          'mutates task_events',
        ),
      ),
    ).toEqual([]);
  });
});

describe('architecture: ADR-0015 secrets', () => {
  it('process.env is read only in infrastructure/config and main.ts', () => {
    expect(
      fmt(
        checkPattern(
          engineFiles,
          /\bprocess\.env\b/g,
          'process.env outside infrastructure/config and the process entry points',
          (f) =>
            insideDir(f.path, `${SRC}/infrastructure/config`) ||
            f.path === `${SRC}/main.ts` ||
            // The MCP server is a separate process started by `claude`; its entry is its composition root.
            f.path === `${SRC}/presentation/mcp/main.ts`,
        ),
      ),
    ).toEqual([]);
  });
});
