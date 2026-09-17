/**
 * Manifest invariants for the packaged plugin.
 *
 * The package declares every harness dependency TWICE by design: a
 * version-range `peerDependencies` entry, which is what the installed artifact
 * resolves against in a profile, and a `link:` `devDependencies` entry, which
 * is what source-plane compilation and these tests resolve against. A runtime
 * import declared in only one of the two is the failure mode this guards:
 * `@deepseek-ai/dsh-llm` had only the link, so the `file:`-installed artifact
 * would have imported `createUserMessage` from a package the profile was never
 * told to provide.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  devDependencies: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

/**
 * Every `.ts` file under one directory, recursively.
 *
 * The scan MUST recurse: the MCP half lives in `src/mcp/`, and a top-level
 * `src/*.ts` listing would let every module below it escape the dependency
 * invariant silently — which is exactly the failure the invariant exists to
 * catch, since an installed copy would then import a harness package no
 * profile was told to provide.
 * @param dir - absolute directory to walk.
 * @returns absolute paths of every TypeScript source below it.
 */
function typescriptFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...typescriptFiles(path))
    else if (entry.endsWith('.ts')) found.push(path)
  }
  return found
}

/** Specifiers imported for their RUNTIME value, not erased as types. */
function runtimeHarnessImports(): ReadonlySet<string> {
  const found = new Set<string>()
  for (const file of typescriptFiles(join(packageRoot, 'src'))) {
    const source = readFileSync(file, 'utf8')
    // `import type …` and `import type {} …` are erased by
    // `verbatimModuleSyntax`; everything else survives into `lib/`.
    const pattern = /^import\s+(?!type\b)[^\n]*?from\s+'(@deepseek-ai\/[^']+)'/gm
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) found.add(specifier)
    }
  }
  return found
}

describe('identity', () => {
  test('the package, the bundle patch and the Loader entry id all agree', () => {
    expect(manifest.name).toBe('dsh-project-context')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: dsh-project-context')
    expect(patch).toContain("name: 'dsh-project-context'")
    expect(patch).not.toContain('dsh-project-agents')
  })
})

describe('dependency symmetry', () => {
  test('every RUNTIME harness import is declared as BOTH a peer and a link', () => {
    const imports = runtimeHarnessImports()
    // Sanity: the detector must actually be finding something.
    expect(imports.size).toBeGreaterThan(0)
    expect(imports).toContain('@deepseek-ai/dsh-llm')
    expect(imports).toContain('@deepseek-ai/dsh-tool-subagent')
    for (const specifier of imports) {
      expect(manifest.peerDependencies, `${specifier} must be a peerDependency`).toHaveProperty(specifier)
      expect(manifest.devDependencies, `${specifier} must have a link: devDependency`).toHaveProperty(specifier)
      expect(manifest.devDependencies[specifier]).toMatch(/^link:\.\.\/deepseek-harness\//)
    }
  })

  test('every peer is optional and has a matching link, so a local install never resolves a registry copy', () => {
    for (const specifier of Object.keys(manifest.peerDependencies)) {
      expect(manifest.peerDependenciesMeta[specifier]?.optional).toBe(true)
      expect(manifest.devDependencies[specifier]).toMatch(/^link:\.\.\/deepseek-harness\//)
    }
  })

  test('the dsh-llm peer was added rather than swapping out its link', () => {
    expect(manifest.peerDependencies['@deepseek-ai/dsh-llm']).toBeDefined()
    expect(manifest.devDependencies['@deepseek-ai/dsh-llm'])
      .toBe('link:../deepseek-harness/packages/llm/llm')
  })
})
