/**
 * Architecture rules from spec section 4 ("Layering rules").
 * A violation fails CI. Change these only with an ADR.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment: 'Domain code may import only other domain code and zod.',
      severity: 'error',
      from: { path: '^packages/core/src/domain' },
      to: { pathNot: ['^packages/core/src/domain', 'node_modules/zod'] },
    },
    {
      name: 'app-depends-on-ports-not-adapters',
      comment: 'Use cases see only domain and ports.',
      severity: 'error',
      from: { path: '^packages/core/src/app' },
      to: { pathNot: ['^packages/core/src/(domain|ports|app)', 'node_modules/zod'] },
    },
    {
      name: 'ports-are-interfaces-only',
      severity: 'error',
      from: { path: '^packages/core/src/ports' },
      to: { pathNot: ['^packages/core/src/(domain|ports)'] },
    },
    {
      name: 'adapters-never-import-use-cases',
      severity: 'error',
      from: { path: '^packages/adapters' },
      to: { path: '^packages/core/src/app' },
    },
    {
      name: 'apps-do-not-import-each-other',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|test)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'types', 'default'] },
  },
};
