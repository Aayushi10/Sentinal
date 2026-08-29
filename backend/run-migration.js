#!/usr/bin/env node
/**
 * run-migration.js
 * Applies the add_approval_state.sql migration using the pg library.
 * Run once: node run-migration.js
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, 'src', 'migrations', 'add_approval_state.sql'),
    'utf8',
  );
  
  const client = await pool.connect();
  try {
    console.log('Running migration: add_approval_state.sql ...');
    await client.query(sql);
    console.log('Migration complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
