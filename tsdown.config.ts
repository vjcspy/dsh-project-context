/**
 * Browser-half build. The harness client module system loads every enabled
 * `dsh.client` package's `./client` export as a lazy CommonJS factory, so the
 * only artifact a loader accepts is `lib/client.js` calling
 * `window.__ModuleLoader__.load({ id, factory })`. No published preset exposes
 * that format, so this config reproduces it from tsdown's own output
 * primitives: a CJS browser bundle wrapped in a factory body.
 *
 * The module table hands the factory its `require`: the shell seeds `react`,
 * the shared client libraries and `@deepseek-ai/cordis`, while every other
 * harness package the browser half imports is a cordis service reached through
 * `inject` and therefore carries no value import. Bare specifiers stay
 * external, except that react and its JSX runtime must be INLINED — the
 * module table is only reachable through the `require` the factory receives,
 * and a bare `require('react')` outside the factory would run before the
 * loader exists.
 */

import { defineConfig } from 'tsdown'

/** Package name stamped into the loader handoff and onto injected style tags. */
const PLUGIN_ID = 'dsh-project-context'

/** Specifiers the factory's `require` answers, plus the inlined React runtime. */
const EXTERNAL = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime']

export default defineConfig({
  name: PLUGIN_ID,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  /**
   * `react` resolves through the module table at runtime and must not be
   * inlined here: the page has exactly one React copy and a second one breaks
   * hooks. It is only a devDependency of this package.
   */
  deps: { neverBundle: EXTERNAL },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
