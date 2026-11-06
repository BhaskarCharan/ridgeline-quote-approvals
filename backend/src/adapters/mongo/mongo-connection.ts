import { MongoClient, type Db } from "mongodb";

/** Collection names in one place, so adapters and resets cannot drift apart. */
export const COLLECTIONS = {
  quotes: "quotes",
  audit: "audit_log",
} as const;

/** An open connection plus its database handle. */
export interface MongoConnection {
  client: MongoClient;
  db: Db;
}

/**
 * Connect to MongoDB. A short server-selection timeout makes "Mongo is not
 * running" fail in seconds with a clear error instead of hanging the CLI.
 */
export async function connectMongo(uri: string, dbName: string): Promise<MongoConnection> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, appName: "ridgeline-quote-approvals" });
  await client.connect();
  return { client, db: client.db(dbName) };
}
