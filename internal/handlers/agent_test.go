package handlers

import (
	"ai-prisoner/internal/db"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterAgent(t *testing.T) {
	// Setup test DB
	if err := db.InitDBWithSchema("/tmp/test_agent.db", "../../db/schema.sql"); err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Test successful registration
	reqBody := RegisterAgentRequest{Name: "TestAgent"}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest(http.MethodPost, "/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	RegisterAgent(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var resp RegisterAgentResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Agent.Name != "TestAgent" {
		t.Errorf("Expected name 'TestAgent', got %s", resp.Agent.Name)
	}
	if resp.Agent.APIKey == "" {
		t.Error("Expected API key to be generated")
	}
	if !resp.Agent.IsActive {
		t.Error("Expected agent to be active")
	}

	// Test missing name
	reqBody2 := RegisterAgentRequest{}
	body2, _ := json.Marshal(reqBody2)
	req2 := httptest.NewRequest(http.MethodPost, "/register", bytes.NewReader(body2))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()

	RegisterAgent(w2, req2)

	if w2.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400, got %d", w2.Code)
	}
}