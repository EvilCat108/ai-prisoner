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
	DB, err = sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_synchronous=NORMAL&_cache_size=1000&_foreign_keys=on")
	if err != nil {
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

	log.Println("Database initialized")
	return nil
}

// Close closes the database connection
func Close() error {
	if DB != nil {
		return DB.Close()
	}
	return nil
}