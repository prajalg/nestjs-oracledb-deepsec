const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { Module, Controller } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { MessagePattern, Transport, ClientProxyFactory, RpcException } = require('@nestjs/microservices');
const { Observable, firstValueFrom, toArray, timeout } = require('rxjs');
const { DeepSecModule, DeepSec, SkipDeepSec } = require('nestjs-oracledb-deepsec');
const driver = require('oracledb').getSecurityContextProvider();
const decorate = (decorator, type, name) => decorator(type.prototype, name,
  Object.getOwnPropertyDescriptor(type.prototype, name));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('real TCP message handlers share the same plugin: mapping, concurrent scopes, roles, bypass, streams and errors', async () => {
  const types = [];
  let teardowns = 0;
  class Messages {
    async query() {
      const metadata = driver.getCurrentContext();
      await delay(metadata.endUserToken === 'alice' ? 10 : 1);
      assert.equal(driver.getCurrentContext(), metadata);
      return metadata;
    }
    health() { return { scoped: driver.getCurrentContext() !== null }; }
    report() { return this.query(); }
    fail() { throw new RpcException('Fixture business failure'); }
    stream() {
      return new Observable(subscriber => {
        const metadata = driver.getCurrentContext();
        let n = 0;
        const timer = setInterval(() => {
          assert.equal(driver.getCurrentContext(), metadata);
          subscriber.next(metadata);
          if (++n === 2) subscriber.complete();
        }, 2);
        return () => { clearInterval(timer); teardowns++; };
      });
    }
  }
  Controller()(Messages);
  for (const name of ['query', 'health', 'report', 'fail', 'stream']) decorate(MessagePattern(name), Messages, name);
  decorate(SkipDeepSec(), Messages, 'health');
  decorate(DeepSec({ dataRoles: ['SALARY_REPORT'] }), Messages, 'report');
  class App {}
  Module({ imports: [DeepSecModule.forRoot({
    async mapIdentity(context) {
      types.push(context.getType());
      assert.equal(context.getHandler().name.length > 0, true);
      const data = context.switchToRpc().getData();
      if (data.user === 'missing') return null;
      if (!['alice', 'bob'].includes(data.user)) throw new RpcException('Fixture authentication required');
      await delay(1);
      return { endUserToken: data.user, dataRoles: ['READER'], attributes: { user: data.user } };
    },
  })], controllers: [Messages] })(App);
  const port = await freePort();
  const options = { transport: Transport.TCP, options: { host: '127.0.0.1', port } };
  const app = await NestFactory.createMicroservice(App, { ...options, logger: false });
  const client = ClientProxyFactory.create(options);
  const send = (pattern, user) => firstValueFrom(client.send(pattern, { user }).pipe(timeout(3000)));
  try {
    await app.listen();
    assert.deepEqual(await send('health'), { scoped: false });
    assert.equal(types.length, 0, 'bypass never calls the mapper');
    const results = await Promise.all([send('query', 'alice'), send('query', 'bob')]);
    assert.deepEqual(results.map(value => value.endUserToken), ['alice', 'bob']);
    assert.deepEqual((await send('report', 'alice')).dataRoles, ['SALARY_REPORT']);
    assert.deepEqual((await send('query', 'alice')).dataRoles, ['READER']);
    await assert.rejects(send('query', 'invalid'), error => error.message === 'Fixture authentication required');
    await assert.rejects(send('query', 'missing'), error => error.message === 'Internal server error');
    await assert.rejects(send('fail', 'alice'), error => error.message === 'Fixture business failure');
    assert.equal((await send('query', 'bob')).endUserToken, 'bob');
    const values = await firstValueFrom(client.send('stream', { user: 'alice' }).pipe(timeout(3000), toArray()));
    assert.equal(values.length, 2);
    assert.ok(values.every(value => value.endUserToken === 'alice'));
    assert.equal(teardowns, 1);
    assert.ok(types.every(type => type === 'rpc'));
    assert.equal(driver.getCurrentContext(), null);
  } finally { client.close(); await app.close(); }
});
