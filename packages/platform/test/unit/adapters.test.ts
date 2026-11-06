import { randomBytes } from 'node:crypto';
import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';
import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { TenantActivated } from '@atlas/contracts';
import {
  AwsKmsKeyEncryption,
  type ConsumedEvent,
  type Consumer,
  type KafkaClientLike,
  type KafkaMessageLike,
  LocalKeyEncryption,
  RedisRateLimiter,
  runKafkaSource,
} from '../../src';

describe('KeyEncryption', () => {
  it('local: round-trips and binds ciphertext to its context', async () => {
    const keys = new LocalKeyEncryption('dev', randomBytes(32));
    expect(keys.keyRef).toBe('local:dev');
    const sealed = await keys.encrypt(Buffer.from('secret'), 'purpose-a');
    expect((await keys.decrypt(sealed, 'purpose-a')).toString()).toBe('secret');
    await expect(keys.decrypt(sealed, 'purpose-b')).rejects.toThrow();
    const dk = await keys.generateDataKey('dek');
    expect(dk.plaintext).toHaveLength(32);
    expect((await keys.decrypt(dk.wrapped, 'dek')).equals(dk.plaintext)).toBe(true);
    expect(() => new LocalKeyEncryption('x', randomBytes(16))).toThrow(/32 bytes/);
  });

  it('aws: sends the purpose as encryption context and never handles the KEK', async () => {
    const kms = mockClient(KMSClient);
    const arn = 'arn:aws:kms:eu-central-1:111122223333:key/abc';
    kms.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from('ct') });
    kms.on(DecryptCommand).resolves({ Plaintext: Buffer.from('pt') });
    kms.on(GenerateDataKeyCommand).resolves({
      Plaintext: Buffer.alloc(32, 1),
      CiphertextBlob: Buffer.from('wrapped'),
    });
    const keys = new AwsKmsKeyEncryption(new KMSClient({ region: 'eu-central-1' }), arn);

    expect((await keys.encrypt(Buffer.from('pt'), 'signing-key:k1')).toString()).toBe('ct');
    expect((await keys.decrypt(Buffer.from('ct'), 'signing-key:k1')).toString()).toBe('pt');
    expect((await keys.generateDataKey('tenant-dek')).wrapped.toString()).toBe('wrapped');

    expect(kms.commandCalls(EncryptCommand)[0]!.args[0].input).toMatchObject({
      KeyId: arn,
      EncryptionContext: { purpose: 'signing-key:k1' },
    });
    expect(kms.commandCalls(DecryptCommand)[0]!.args[0].input.EncryptionContext).toEqual({
      purpose: 'signing-key:k1',
    });
    expect(kms.commandCalls(GenerateDataKeyCommand)[0]!.args[0].input).toMatchObject({
      KeySpec: 'AES_256',
      EncryptionContext: { purpose: 'tenant-dek' },
    });
    expect(() => new AwsKmsKeyEncryption(new KMSClient({}), 'my-key')).toThrow(/ARN or alias/);

    kms.on(DecryptCommand).resolves({});
    await expect(keys.decrypt(Buffer.from('ct'), 'x')).rejects.toThrow(/no plaintext/);
    kms.restore();
  });
});

describe('RedisRateLimiter', () => {
  it('shares one counter per key across limiter instances (replicas)', async () => {
    const redis = new RedisMock();
    const a = new RedisRateLimiter(redis);
    const b = new RedisRateLimiter(redis);
    expect((await a.consume('ip:1', 2, 60)).allowed).toBe(true);
    expect((await b.consume('ip:1', 2, 60)).allowed).toBe(true);
    const third = await a.consume('ip:1', 2, 60);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
    expect(third.retryAfterSec).toBeLessThanOrEqual(60);
    expect((await a.consume('ip:2', 2, 60)).allowed).toBe(true);
  });

  it('fails open when Redis is unavailable', async () => {
    const broken = { eval: () => Promise.reject(new Error('ECONNREFUSED')) };
    expect(await new RedisRateLimiter(broken).consume('k', 1, 60)).toEqual({
      allowed: true,
      retryAfterSec: 0,
    });
  });
});

describe('runKafkaSource', () => {
  const eventId = '0192f0c4-0000-7000-8000-0000000000aa';
  const tenantId = '0192f0c4-0000-7000-8000-0000000000bb';

  function fakeKafka() {
    const sent: { topic: string; headers?: Record<string, string> }[] = [];
    let eachMessage:
      | ((p: { topic: string; partition: number; message: KafkaMessageLike }) => Promise<void>)
      | null = null;
    const subscribed: string[][] = [];
    const client: KafkaClientLike = {
      consumer: () => ({
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        subscribe: (s) => {
          subscribed.push(s.topics);
          return Promise.resolve();
        },
        run: (config) => {
          eachMessage = config.eachMessage;
          return Promise.resolve();
        },
      }),
      producer: () => ({
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        send: (record) => {
          sent.push({
            topic: record.topic,
            ...(record.messages[0]?.headers ? { headers: record.messages[0].headers } : {}),
          });
          return Promise.resolve();
        },
      }),
    };
    return {
      client,
      sent,
      subscribed,
      deliver: (message: KafkaMessageLike, topic = TenantActivated.topic) =>
        eachMessage!({ topic, partition: 0, message }),
    };
  }

  it('parses outbox records, retries handler failures and dead-letters poison', async () => {
    const handled: ConsumedEvent[] = [];
    let fail = false;
    const consumer: Consumer = {
      name: 'test',
      topics: [TenantActivated.topic],
      handle: (event) => {
        if (fail) return Promise.reject(new Error('db down'));
        handled.push(event);
        return Promise.resolve('processed');
      },
    };
    const kafka = fakeKafka();
    const source = await runKafkaSource(kafka.client, consumer, {
      groupId: 'g',
      deadLetterTopic: 'dlq.test',
    });
    expect(kafka.subscribed).toEqual([[TenantActivated.topic]]);

    const good: KafkaMessageLike = {
      key: Buffer.from(tenantId),
      value: Buffer.from(JSON.stringify({ tenant_id: tenantId })),
      headers: { event_id: [Buffer.from(eventId)], tenant_id: Buffer.from(tenantId) },
      offset: '7',
    };
    await kafka.deliver(good);
    expect(handled[0]).toMatchObject({ eventId, tenantId, payload: { tenant_id: tenantId } });

    // Transient failure: rethrown so kafkajs retries and does not commit the offset.
    fail = true;
    await expect(kafka.deliver(good)).rejects.toThrow('db down');
    fail = false;

    // Poison: dead-lettered with its origin, and the partition keeps moving.
    await kafka.deliver({ ...good, headers: {}, offset: '9' });
    expect(kafka.sent).toHaveLength(1);
    expect(kafka.sent[0]).toMatchObject({
      topic: 'dlq.test',
      headers: {
        'x-original-topic': TenantActivated.topic,
        'x-original-offset': '9',
        'x-consumer': 'test',
      },
    });
    await source.stop();
  });
});
