import { createApp } from "./app.js";
import { redis } from "./redis/client.js";
import { pool } from "./db/pool.js";
import { env } from "./config/env.js";
import { logger } from "./observability/logger.js";

const app = createApp(redis, pool);

app.listen(env.PORT, () => {
  logger.info(`LLM Gateway listening on port ${env.PORT}`);
});
