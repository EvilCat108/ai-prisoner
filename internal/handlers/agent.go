package handlers

import (
	"ai-prisoner/internal/auth"
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/models"
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// RegisterAgentRequest represents the request to register an agent
type RegisterAgentRequest struct {
	Name string `json:"name"`
}

// RegisterAgentResponse represents the response after registration
type RegisterAgentResponse struct {
	Agent models.Agent `json:"agent"`
}

// RegisterAgent handles agent registration
func RegisterAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req RegisterAgentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate name
	if req.Name == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}
	if len(req.Name) > 100 {
		http.Error(w, "Name too long (max 100 characters)", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Name) != req.Name {
		http.Error(w, "Name cannot have leading or trailing whitespace", http.StatusBadRequest)
		return
	}

	// Generate API key
	apiKey, err := auth.GenerateAPIKey()
	if err != nil {
		http.Error(w, "Failed to generate API key", http.StatusInternalServerError)
		return
	}

	// Insert agent
	result, err := db.DB.Exec("INSERT INTO agents (name, api_key, is_active) VALUES (?, ?, 1)", req.Name, apiKey)
	if err != nil {
		http.Error(w, "Failed to register agent", http.StatusInternalServerError)
		return
	}

	id, _ := result.LastInsertId()

	agent := models.Agent{
		ID:       int(id),
		Name:     req.Name,
		APIKey:   apiKey,
		IsActive: true,
	}

	log.Printf("Agent registered: ID=%d, Name=%s", agent.ID, agent.Name)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RegisterAgentResponse{Agent: agent})
}