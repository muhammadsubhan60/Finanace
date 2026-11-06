import { MongoClient, type ClientSession, type Db } from "mongodb";

const g = globalThis as unknown as { __mongo?: { client: MongoClient; promise: Promise<MongoClient> } };

export const ORG_ID = process.env.ORG_ID ?? "delta-labs";

function uri(): string {
  const u = process.env.MONGODB_URI;
  if (!u) throw new Error("MONGODB_URI is not set (see .env.example)");
  return u;
}

export async function getClient(): Promise<MongoClient> {
  if (!g.__mongo) {
    const client = new MongoClient(uri(), { retryWrites: true });
    g.__mongo = { client, promise: client.connect() };
  }
  return g.__mongo.promise;
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(process.env.MONGODB_DB ?? "delta_finance");
}

/** Run `fn` inside a multi-document transaction (replica set required). */
export async function withTransaction<T>(fn: (session: ClientSession, db: Db) => Promise<T>): Promise<T> {
  const client = await getClient();
  const db = await getDb();
  const session = client.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await fn(session, db);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}

export async function closeDb() {
  if (g.__mongo) {
    await g.__mongo.client.close();
    delete g.__mongo;
  }
}
