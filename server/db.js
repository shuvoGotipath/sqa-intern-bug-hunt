import { MongoClient } from 'mongodb';

/**
 * Connects to MongoDB and ensures indexes. Collections:
 *   sessions       challenge sessions (_id = public reference, tokenHash unique)
 *   reports        bug reports (sessionId)
 *   applications   job applications (sessionId unique, email unique)
 *   adminSessions  admin logins (_id = token hash, TTL on expiresAt)
 *   demoState      ShopNest sandbox state per session (_id = sessionId)
 *   settings       admin-controlled settings (_id = 'hiring')
 */
export async function openDatabase(uri, dbName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(dbName);
  const col = {
    sessions: db.collection('sessions'),
    reports: db.collection('reports'),
    applications: db.collection('applications'),
    adminSessions: db.collection('adminSessions'),
    demoState: db.collection('demoState'),
    settings: db.collection('settings'),
  };
  await Promise.all([
    col.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    col.sessions.createIndex({ status: 1 }),
    col.reports.createIndex({ sessionId: 1, createdAt: 1 }),
    col.applications.createIndex({ sessionId: 1 }, { unique: true }),
    col.applications.createIndex({ email: 1 }, { unique: true }),
    col.applications.createIndex({ status: 1 }),
    col.adminSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  return { client, db, col };
}

export const isDuplicateKey = (err) => err?.code === 11000;
