import { PrismaClient } from "@/generated/prisma/client";

import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";

const databaseEnvSchema = z.object({
  DATABASE_URL: z.url(),
});

function getDatabaseUrl(): string {
  const parsed = databaseEnvSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
  });
  if (!parsed.success) {
    console.error(
      "❌ Invalid database environment variables:\n" +
        z.prettifyError(parsed.error),
    );
    throw new Error(
      "Invalid database environment variables: DATABASE_URL is required and must be a valid URL",
    );
  }
  return parsed.data.DATABASE_URL;
}

const createPrismaClient = () => {
  const adapter = new PrismaPg({ connectionString: getDatabaseUrl() });
  return new PrismaClient({ adapter });
};

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

function getPrisma(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  const client = createPrismaClient();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }
  return client;
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrisma();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
