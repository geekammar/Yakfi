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

const defaultCreatePrismaClient = () => {
  const adapter = new PrismaPg({ connectionString: getDatabaseUrl() });
  return new PrismaClient({ adapter });
};

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof defaultCreatePrismaClient> | undefined;
};

export type PrismaClientFactory = () => PrismaClient;

export function createPrismaProxy(
  factory: PrismaClientFactory = defaultCreatePrismaClient,
): PrismaClient {
  let productionPrisma: PrismaClient | undefined;

  function getPrisma(): PrismaClient {
    if (process.env.NODE_ENV === "production") {
      if (!productionPrisma) {
        productionPrisma = factory();
      }
      return productionPrisma;
    }
    if (!globalForPrisma.prisma) {
      globalForPrisma.prisma = factory();
    }
    return globalForPrisma.prisma;
  }

  return new Proxy({} as PrismaClient, {
    get(_target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }
      const client = getPrisma();
      const value = Reflect.get(client, prop, receiver);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

export const db = createPrismaProxy();
