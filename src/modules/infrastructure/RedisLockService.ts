import { randomUUID } from "node:crypto";

import Redis from "ioredis";
import type { Logger } from "pino";

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export class RedisLockService {
  private readonly client: Redis;

  public constructor(
    redisUrl: string,
    private readonly logger: Logger
  ) {
    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true
    });

    this.client.on("error", (error) => {
      this.logger.error({ err: error }, "Erreur Redis");
    });
  }

  public async initialize(): Promise<void> {
    await this.client.connect();
    await this.client.ping();
    this.logger.info("Redis initialise");
  }

  public async acquire(lockKey: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const status = await this.client.set(this.withPrefix(lockKey), token, "PX", ttlMs, "NX");
    if (status !== "OK") {
      return null;
    }

    return token;
  }

  public async release(lockKey: string, token: string): Promise<void> {
    try {
      await this.client.eval(RELEASE_LOCK_SCRIPT, 1, this.withPrefix(lockKey), token);
    } catch (error) {
      this.logger.warn({ err: error, lockKey }, "Impossible de liberer le lock Redis");
    }
  }

  private withPrefix(lockKey: string): string {
    return `quantum:${lockKey}`;
  }
}

