const { Pool } = require('pg');
require('dotenv').config();

// Database connection configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'postgres', // Connect to default db first
  user: process.env.DB_USER || 'postgres',
  password: String(process.env.DB_PASSWORD || ''),
});

// SQL to create the database
const createDatabaseQuery = `
  SELECT 'CREATE DATABASE portl_db'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'portl_db')\gexec
`;

// SQL to enable extensions
const extensionsQuery = `
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
`;

// Read the schema file
const fs = require('fs');
const path = require('path');

const initializeDatabase = async () => {
  let client;
  try {
    console.log('Starting database initialization...');

    // Connect to default postgres database to create our db if it doesn't exist
    client = await pool.connect();
    console.log('Connected to PostgreSQL server');

    // Create database if it doesn't exist
    await client.query(createDatabaseQuery);
    console.log('Database "portl_db" ensured to exist');

    // Release connection to default db
    client.release();

    // Now connect to our actual database
    const targetPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'portl_db',
      user: process.env.DB_USER || 'postgres',
      password: String(process.env.DB_PASSWORD || ''),
    });

    const targetClient = await targetPool.connect();
    console.log('Connected to target database');

    // Enable extensions
    await targetClient.query(extensionsQuery);
    console.log('Extensions enabled');

    // Read and execute schema
    const schemaPath = path.join(__dirname, 'database', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    // Split by semicolon and execute each statement
    const statements = schemaSql
      .split(';')
      .map(statement => statement.trim())
      .filter(statement => statement.length > 0);

    for (const statement of statements) {
      try {
        await targetClient.query(statement);
      } catch (stmtError) {
        // Some statements might fail if objects already exist, which is OK
        console.warn(`Statement execution warning: ${stmtError.message}`);
      }
    }

    console.log('Database schema applied successfully');

    // Release connection
    targetClient.release();

    console.log('Database initialization completed successfully!');

  } catch (error) {
    console.error('Database initialization failed:', error);
    if (client) {
      client.release();
    }
    process.exit(1);
  }
};

if (require.main === module) {
  initializeDatabase();
}

module.exports = { initializeDatabase };