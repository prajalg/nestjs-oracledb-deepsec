const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercise the tarball as a consumer, so source-tree resolution cannot hide
// missing compiled files, exports or declaration dependencies.
test('packed plugin works in JavaScript and exposes checked TypeScript declarations', () => {
  const root = resolve(__dirname, '..');
  const temporary = mkdtempSync(join(tmpdir(), 'deepsec-package-'));
  const run = (command, args, cwd = temporary) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    return result.stdout;
  };
  try {
    // npm test builds first; skip scripts here to avoid rebuilding during parallel tests.
    const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      join(root, 'packages/nestjs-deepsec')));
    assert.ok(packed.files.some(file => file.path === 'dist/index.js'));
    assert.ok(packed.files.some(file => file.path === 'dist/index.d.ts'));
    assert.ok(!packed.files.some(file => file.path.startsWith('src/')));
    run('tar', ['-xzf', join(temporary, packed.filename)]);
    const manifest = JSON.parse(readFileSync(join(temporary, 'package/package.json'), 'utf8'));
    for (const hook of ['install', 'postinstall', 'prepare']) assert.equal(manifest.scripts?.[hook], undefined);

    // Supply peers already installed by the demo, excluding its linked plugin and compiler.
    const { mkdirSync } = require('node:fs');
    mkdirSync(join(temporary, 'node_modules'));
    for (const name of readdirSync(join(root, 'node_modules'))) {
      if (['nestjs-oracledb-deepsec', 'typescript', '.bin'].includes(name)) continue;
      symlinkSync(join(root, 'node_modules', name), join(temporary, 'node_modules', name));
    }
    symlinkSync(join(temporary, 'package'), join(temporary, 'node_modules/nestjs-oracledb-deepsec'));
    writeFileSync(join(temporary, 'consumer.cjs'), `
      const assert = require('node:assert/strict');
      const plugin = require('nestjs-oracledb-deepsec');
      assert.equal(typeof plugin.DeepSecModule.forRoot, 'function');
      assert.deepEqual(plugin.mapBearerIdentity({headers:{authorization:'Bearer fixture'}}), {endUserToken:'fixture'});
      for (const name of ['azure-login', 'error-details', 'identity-mappers', 'tokens'])
        assert.ok(require('nestjs-oracledb-deepsec/' + name));
    `);
    run(process.execPath, ['--preserve-symlinks', 'consumer.cjs']);
    writeFileSync(join(temporary, 'consumer.ts'), `
      import { DeepSecModule, mapBearerIdentity, mapSessionIdentity, type DeepSecOptions } from 'nestjs-oracledb-deepsec';
      import type { Pool } from 'oracledb';
      import { errorDetails } from 'nestjs-oracledb-deepsec/error-details';
      declare const pool: Pool;
      const options: DeepSecOptions = { pool, mapIdentity: mapBearerIdentity };
      DeepSecModule.forRoot(options);
      DeepSecModule.forRootAsync({ useFactory: async () => ({pool, mapIdentity: mapSessionIdentity}) });
      DeepSecModule.forRoot<{ user: { token: string } }>({ pool,
        mapIdentity: request => ({endUserToken: request.user.token}) });
      errorDetails(new Error('fixture'));
      // @ts-expect-error The mapper is required.
      DeepSecModule.forRoot({pool});
      // @ts-expect-error Token metadata must have a string token.
      DeepSecModule.forRoot({pool, mapIdentity: () => ({endUserToken: 123})});
      // @ts-expect-error Only factory-based async configuration is supported.
      DeepSecModule.forRootAsync({});
    `);
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
      '--skipLibCheck', 'false', '--types', 'node', '--esModuleInterop', '--target', 'ES2022',
      '--module', 'Node16', '--moduleResolution', 'Node16', 'consumer.ts']);
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
      '--skipLibCheck', 'false', '--types', 'node', '--esModuleInterop', '--target', 'ES2022',
      '--module', 'commonjs', '--moduleResolution', 'node', 'consumer.ts']);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
