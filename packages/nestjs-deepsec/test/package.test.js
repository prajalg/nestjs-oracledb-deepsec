const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercise the tarball as a consumer, so source-tree resolution cannot hide
// missing compiled files, exports or declaration dependencies.
test('packed plugin works in JavaScript and exposes checked TypeScript declarations', () => {
  const packageRoot = resolve(__dirname, '..');
  // Works with package-local or hoisted development dependencies.
  const dependencyRoot = dirname(dirname(require.resolve('typescript/package.json')));
  const compiler = require.resolve('typescript/bin/tsc');
  const temporary = mkdtempSync(join(tmpdir(), 'deepsec-package-'));
  const run = (command, args, cwd = temporary) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    return result.stdout;
  };
  try {
    // npm test builds first; skip scripts here to avoid rebuilding during parallel tests.
    const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      packageRoot));
    assert.ok(packed.files.some(file => file.path === 'dist/index.js'));
    assert.ok(packed.files.some(file => file.path === 'dist/index.d.ts'));
    assert.ok(!packed.files.some(file => file.path.startsWith('src/')));
    assert.ok(packed.files.some(file => file.path === 'README.md'));
    assert.ok(!packed.files.some(file => /^(test|diagnostics)\//.test(file.path)));
    assert.ok(!packed.files.some(file => /^dist\/(azure-login|error-details|identity-mappers)[.]/.test(file.path)));
    run('tar', ['-xzf', join(temporary, packed.filename)]);
    const manifest = JSON.parse(readFileSync(join(temporary, 'package/package.json'), 'utf8'));
    for (const name of ['passport', 'nestjs-cls', '@azure/msal-node', 'express-session', 'memorystore', 'lru-cache', '@nestjs/websockets', '@nestjs/microservices']) {
      assert.equal(manifest.dependencies?.[name], undefined);
      assert.equal(manifest.peerDependencies?.[name], undefined);
    }
    for (const hook of ['install', 'postinstall', 'prepare']) assert.equal(manifest.scripts?.[hook], undefined);

    // Reuse installed development dependencies, excluding auth packages, the plugin and compiler.
    const { mkdirSync } = require('node:fs');
    mkdirSync(join(temporary, 'node_modules'));
    const excluded = new Set(['nestjs-oracledb-deepsec', 'typescript', '.bin',
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
    symlinkSync(join(temporary, 'package'), join(temporary, 'node_modules/nestjs-oracledb-deepsec'));
    writeFileSync(join(temporary, 'consumer.cjs'), `
      const assert = require('node:assert/strict');
      // Missing optional auth packages are verified by normal Node resolution,
      // without intercepting private module-loader methods.
      for (const name of ['passport', '@nestjs/passport', 'nestjs-cls',
        'express-session', '@azure/msal-node', 'memorystore', 'lru-cache',
        '@nestjs/websockets', '@nestjs/microservices'])
        assert.throws(() => require.resolve(name), {code:'MODULE_NOT_FOUND'});
      const plugin = require('nestjs-oracledb-deepsec');
      assert.equal(typeof plugin.DeepSecModule.forRoot, 'function');
      assert.ok(require('nestjs-oracledb-deepsec/tokens'));
      const definition = plugin.DeepSecModule.forRoot({mapIdentity: () => null});
      assert.ok(!definition.controllers?.length);
      assert.equal(plugin.AzureLoginService, undefined);
      assert.throws(() => require('nestjs-oracledb-deepsec/azure-login'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    `);
    run(process.execPath, ['consumer.cjs']);
    writeFileSync(join(temporary, 'consumer.mjs'), `
      import assert from 'node:assert/strict';
      import { DeepSecModule, DeepSecInterceptor, DeepSec, SkipDeepSec } from 'nestjs-oracledb-deepsec';
      assert.equal(typeof DeepSecModule.forRoot, 'function');
      assert.equal(typeof DeepSecInterceptor, 'function');
      assert.equal(typeof DeepSec, 'function');
      assert.equal(typeof SkipDeepSec, 'function');
      assert.equal('DEEPSEC_POOL' in (await import('nestjs-oracledb-deepsec')), false);
    `);
    run(process.execPath, ['consumer.mjs']);
    writeFileSync(join(temporary, 'consumer.ts'), `
      import { DeepSecModule, DeepSec, SkipDeepSec, type DeepSecOptions } from 'nestjs-oracledb-deepsec';
      DeepSec({dataRoles:['SALARY_REPORT']});
      // @ts-expect-error Scoped roles must be strings.
      DeepSec({dataRoles:[123]});
      DeepSec(); SkipDeepSec();
      const mapIdentity = () => ({endUserToken: "fixture"});
      const options: DeepSecOptions = { mapIdentity };
      DeepSecModule.forRoot(options);
      DeepSecModule.forRootAsync({ useFactory: async () => ({mapIdentity}) });
      const typed: DeepSecOptions = {
        mapIdentity: context => ({endUserToken: context.switchToHttp().getRequest<{ user: { token: string } }>().user.token}) };
      DeepSecModule.forRoot(typed);
      // @ts-expect-error Login is owned by the app, not configured on the plugin.
      DeepSecModule.forRoot({mapIdentity, azureLogin: {clientId:'fixture'}});
      // @ts-expect-error The mapper is required.
      DeepSecModule.forRoot({});
      // @ts-expect-error Token metadata must have a string token.
      DeepSecModule.forRoot({mapIdentity: () => ({endUserToken: 123})});
      // @ts-expect-error Pools are owned by the application, not configured on the plugin.
      DeepSecModule.forRoot({mapIdentity, pool: {}});
      // @ts-expect-error Connection options belong to the application.
      DeepSecModule.forRoot({mapIdentity, poolOptions: {}});
      // @ts-expect-error Nest expects a callable factory.
      DeepSecModule.forRootAsync({useFactory: 'invalid'});
    `);
    run(process.execPath, [compiler, '--noEmit', '--strict',
      '--skipLibCheck', 'false', '--types', 'node', '--esModuleInterop', '--target', 'ES2022',
      '--module', 'Node16', '--moduleResolution', 'Node16', 'consumer.ts']);
    run(process.execPath, [compiler, '--noEmit', '--strict',
      '--skipLibCheck', 'false', '--types', 'node', '--esModuleInterop', '--target', 'ES2022',
      '--module', 'commonjs', '--moduleResolution', 'node', 'consumer.ts']);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
