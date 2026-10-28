import { z } from 'zod';

export const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  MCEPTION_PUBLIC_URL: z
    .string()
    .url()
    .default('http://localhost:3000')
    .transform((url) => url.replace(/\/$/, '')),
  MCEPTION_MASTER_KEY: z.string().min(32).optional(),
  ADMIN_API_KEY: z.string().min(8).default('mception-dev-secret-key'),
  BLOCK_PRIVATE_NETWORKS: z.coerce.boolean().default(false),
  ALLOWED_REDIRECT_URIS: z.string().optional(),
  DATABASE_PATH: z.string().default('./data/mception.db'),
});

export type Config = z.infer<typeof configSchema>;

let cachedConfig: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cachedConfig) {
    return cachedConfig;
  }
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    throw new Error(`Invalid configuration: ${errorDetails}`);
  }
  cachedConfig = result.data;
  return cachedConfig;
}

export function resetConfigForTesting(): void {
  cachedConfig = null;
}
