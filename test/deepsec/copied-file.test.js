const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, copyFileSync, readdirSync, mkdirSync, symlinkSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');
const { spawnSync } = require('node:child_process');

test('copied DeepSec integration files compile and work without optional auth dependencies', () => {
  const root = resolve(__dirname, '../..');
  const dependencyRoot = dirname(dirname(require.resolve('typescript/package.json')));
  const temporary = mkdtempSync(join(tmpdir(), 'deepsec-copy-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: temporary, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  };
  try {
    for (const name of ['deepsec.interceptor.ts', 'deepsec.definitions.ts'])
      copyFileSync(join(root, 'src/deepsec', name), join(temporary, name));
    mkdirSync(join(temporary, 'node_modules'));
    const excluded = new Set(['typescript', '.bin',
      'passport', 'express-session', 'memorystore', 'lru-cache', 'nestjs-cls', '@azure']);
    for (const name of readdirSync(dependencyRoot)) {
      if (excluded.has(name)) continue;
      if (name === '@nestjs') {
        mkdirSync(join(temporary, 'node_modules', name));
        for (const child of readdirSync(join(dependencyRoot, name))) {
          if (['passport', 'microservices', 'websockets', 'platform-socket.io'].includes(child)) continue;
          symlinkSync(join(dependencyRoot, name, child), join(temporary, 'node_modules', name, child));
        }
      } else symlinkSync(join(dependencyRoot, name), join(temporary, 'node_modules', name));
    }
    writeFileSync(join(temporary, 'consumer.ts'), `
      import { DeepSecConfiguration, DeepSecInterceptor, RunWithDataRoles, SkipDeepSec, type DeepSecOptions } from './deepsec.interceptor';
      import type { DeepSecIdentity } from './deepsec.definitions';
      const identity: DeepSecIdentity = { endUserToken: 'fixture' };
      void identity;
      const options: DeepSecOptions = {
        mapIdentity: context => ({ endUserToken: context.switchToHttp().getRequest<{ user: { token: string } }>().user.token }),
      };
      DeepSecConfiguration.forRoot(options);
      DeepSecConfiguration.forRootAsync({ useFactory: async () => options });
      RunWithDataRoles(['REPORT']); SkipDeepSec();
      // @ts-expect-error Mapping is required.
      DeepSecConfiguration.forRoot({});
      // @ts-expect-error Tokens must be strings.
      DeepSecConfiguration.forRoot({ mapIdentity: () => ({ endUserToken: 123 }) });
      // @ts-expect-error Resources stay app-owned.
      DeepSecConfiguration.forRoot({ ...options, poolOptions: {} });
      // @ts-expect-error Scoped roles must be strings.
      RunWithDataRoles([123]);
      // @ts-expect-error The role list is required.
      RunWithDataRoles();
      void DeepSecInterceptor;
    `);
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--strict', '--skipLibCheck', 'false',
      '--types', 'node', '--experimentalDecorators', '--emitDecoratorMetadata', '--esModuleInterop',
      '--target', 'ES2022', '--module', 'Node16', '--moduleResolution', 'Node16',
      '--outDir', 'build', 'deepsec.interceptor.ts', 'consumer.ts']);
    writeFileSync(join(temporary, 'verify.cjs'), `
      const assert = require('node:assert/strict');
      for (const name of ['passport', 'nestjs-cls', '@azure/msal-node', '@nestjs/websockets'])
        assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
      const integration = require('./build/deepsec.interceptor');
      assert.equal(typeof integration.DeepSecConfiguration.forRoot, 'function');
      assert.equal(typeof integration.DeepSecConfiguration.forRootAsync, 'function');
      assert.equal(typeof integration.DeepSecInterceptor, 'function');
      assert.equal(typeof integration.RunWithDataRoles, 'function');
      assert.equal(typeof integration.SkipDeepSec, 'function');
      assert.equal(integration.DeepSec, undefined);
      assert.equal(integration.DeepSecModule, undefined);
      const definition = integration.DeepSecConfiguration.forRoot({ mapIdentity: () => null });
      assert.ok(!definition.controllers?.length);
      const driver = require('oracledb').getSecurityContextProvider();
      driver.runWithContext({ endUserToken: 'fixture' }, () =>
        assert.equal(driver.getCurrentContext().endUserToken, 'fixture'));
      assert.equal(driver.getCurrentContext(), null);
    `);
    run(process.execPath, ['verify.cjs']);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
