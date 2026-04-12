package auth

import (
	"ai-prisoner/internal/db"
	"testing"
)

func TestGenerateAPIKey(t *testing.T) {
	key1, err := GenerateAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	key2, err := GenerateAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if key1 == key2 {
		t.Error("Generated keys should be unique")
	}
	if len(key1) != 64 { // 32 bytes hex
		t.Errorf("Expected key length 64, got %d", len(key1))
	}
}

func TestAuthenticate(t *testing.T) {
	// Setup test DB
	if err := db.InitDBWithSchema("/tmp/test_auth.db", "../../db/schema.sql"); err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Insert test agent
	_, err := db.DB.Exec("INSERT INTO agents (name, api_key, is_active) VALUES ('test', 'testkey', 1)")
	if err != nil {
		t.Fatal(err)
	}

	// Test success
	agent, err := Authenticate("testkey")
	if err != nil {
		t.Errorf("Expected success, got error: %v", err)
	}
	if agent.Name != "test" {
		t.Errorf("Expected name 'test', got %s", agent.Name)
	}

	// Test invalid key
	_, err = Authenticate("invalid")
	if err == nil {
		t.Error("Expected error for invalid key")
	}

	// Test disabled agent
	_, err = db.DB.Exec("INSERT INTO agents (name, api_key, is_active) VALUES ('disabled', 'disabledkey', 0)")
	if err != nil {
		t.Fatal(err)
	}
	_, err = Authenticate("disabledkey")
	if err == nil {
		t.Error("Expected error for disabled agent")
	}
}