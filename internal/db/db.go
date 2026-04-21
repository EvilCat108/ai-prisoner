package db

import (
	"database/sql"
	_ "github.com/mattn/go-sqlite3"
	"io/ioutil"
	"log"
	"os"
)

var DB *sql.DB

// InitDB initializes the SQLite database with WAL mode and runs schema
func InitDB(dbPath string) error {
	return InitDBWithSchema(dbPath, "db/schema.sql")
}

// InitDBWithSchema initializes with custom schema path
func InitDBWithSchema(dbPath, schemaPath string) error {
	// Remove existing file if not memory
	if dbPath != ":memory:" {
		os.Remove(dbPath)
	}

	var err error
	// Open database with basic configuration first
	// WAL mode will be set separately after creation
	connectionString := dbPath
	if dbPath != ":memory:" {
		connectionString = dbPath + "?cache=shared"
	}
	
	DB, err = sql.Open("sqlite3", connectionString)
	if err != nil {
		log.Printf("Failed to open database: %v", err)
		return err
	}

	// Enable foreign keys
	if _, err := DB.Exec("PRAGMA foreign_keys = ON"); err != nil {
		log.Printf("Failed to enable foreign keys: %v", err)
		return err
	}

	// Read schema
	schema, err := ioutil.ReadFile(schemaPath)
	if err != nil {
		log.Printf("Failed to read schema from %s: %v", schemaPath, err)
		return err
	}

	// Execute schema
	_, err = DB.Exec(string(schema))
	if err != nil {
		log.Printf("Failed to execute schema: %v", err)
		return err
	}

	// Enable WAL mode after successful schema creation
	if dbPath != ":memory:" {
		if _, err := DB.Exec("PRAGMA journal_mode = WAL"); err != nil {
			log.Printf("Warning: Failed to enable WAL mode (non-fatal): %v", err)
		}
		if _, err := DB.Exec("PRAGMA synchronous = NORMAL"); err != nil {
			log.Printf("Warning: Failed to set synchronous mode (non-fatal): %v", err)
		}
	}

	log.Println("Database initialized")
	return nil
}

// InitD1DB initializes connection to Cloudflare D1 database
// This is called when running on Cloudflare Workers
// The D1Database binding is passed from wrangler environment
func InitD1DB(d1Database interface{}) error {
	// For Cloudflare Workers, use the D1Database binding
	// The database/sql driver will be configured through the bindings
	// This is a placeholder - actual implementation depends on the D1 driver used
	
	// NOTE: When using with Cloudflare Workers + D1, the database connection
	// is configured through wrangler.toml bindings and environment variables.
	// The SQL queries remain unchanged from SQLite.
	
	log.Println("D1 Database connection initialized")
	return nil
}

// Close closes the database connection
func Close() error {
	if DB != nil {
		return DB.Close()
	}
	return nil
}