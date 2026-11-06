import { type Logger } from 'pino';
import { type Consumer, parseOutboxRecord, PoisonEventError } from './consumer';

type HeaderValue = Buffer | string | (Buffer | string)[] | undefined;

/** The parts of a kafkajs message this adapter reads. */
export interface KafkaMessageLike {
  key: Buffer | null;
  value: Buffer | null;
  headers?: Record<string, HeaderValue>;
  offset: string;
}

/** Minimal kafkajs surface (structurally compatible with `Kafka` from kafkajs). */
export interface KafkaClientLike {
  consumer(config: { groupId: string }): {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    subscribe(subscription: { topics: string[]; fromBeginning?: boolean }): Promise<void>;
    run(config: {
      autoCommit?: boolean;
      eachMessage: (payload: {
        topic: string;
        partition: number;
        message: KafkaMessageLike;
      }) => Promise<void>;
    }): Promise<void>;
  };
  producer(): {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(record: {
      topic: string;
      messages: {
        key: Buffer | string | null;
        value: Buffer | string | null;
        headers?: Record<string, string>;
      }[];
    }): Promise<unknown>;
  };
}

export interface KafkaSourceOptions {
  /** Kafka consumer group; one per consumer name so each service tracks its own offsets. */
  groupId: string;
  /** Topic that receives events failing schema validation, so one bad record cannot block a partition. */
  deadLetterTopic: string;
  logger?: Logger;
}

function first(value: HeaderValue): string | Buffer | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Feeds Kafka records into a `createConsumer()` consumer. Offsets advance only after the
 * handler's transaction commits (kafkajs commits after eachMessage resolves); a handler error
 * rethrows so kafkajs retries the message. Poison records go to the dead-letter topic.
 */
export async function runKafkaSource(
  kafka: KafkaClientLike,
  consumer: Consumer,
  options: KafkaSourceOptions,
): Promise<{ stop(): Promise<void> }> {
  const kafkaConsumer = kafka.consumer({ groupId: options.groupId });
  const producer = kafka.producer();
  await producer.connect();
  await kafkaConsumer.connect();
  await kafkaConsumer.subscribe({ topics: [...consumer.topics], fromBeginning: true });
  await kafkaConsumer.run({
    autoCommit: true,
    eachMessage: async ({ topic, partition, message }) => {
      const headers: Record<string, string | Buffer | undefined> = {};
      for (const [name, value] of Object.entries(message.headers ?? {}))
        headers[name] = first(value);
      try {
        await consumer.handle(
          parseOutboxRecord({ topic, key: message.key, value: message.value, headers }),
        );
      } catch (error) {
        if (!(error instanceof PoisonEventError)) throw error;
        options.logger?.error(
          { topic, partition, offset: message.offset, reason: error.message },
          'poison event sent to dead-letter topic',
        );
        await producer.send({
          topic: options.deadLetterTopic,
          messages: [
            {
              key: message.key,
              value: message.value,
              headers: {
                'x-original-topic': topic,
                'x-original-partition': String(partition),
                'x-original-offset': message.offset,
                'x-error': error.message.slice(0, 500),
                'x-consumer': consumer.name,
              },
            },
          ],
        });
      }
    },
  });
  return {
    async stop() {
      await kafkaConsumer.disconnect();
      await producer.disconnect();
    },
  };
}
