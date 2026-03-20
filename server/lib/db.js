const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!global.__mongooseConnectionCache) {
  global.__mongooseConnectionCache = {
    conn: null,
    promise: null
  };
}

async function connectToDatabase() {
  if (!MONGO_URI) {
    throw new Error('Missing MONGO_URI (or MONGODB_URI) environment variable');
  }

  const cache = global.__mongooseConnectionCache;

  if (cache.conn && mongoose.connection.readyState === 1) {
    return cache.conn;
  }

  if (!cache.promise) {
    cache.promise = mongoose.connect(MONGO_URI).then((mongooseInstance) => mongooseInstance);
  }

  try {
    cache.conn = await cache.promise;
  } catch (error) {
    cache.promise = null;
    throw error;
  }

  return cache.conn;
}

module.exports = {
  connectToDatabase
};
