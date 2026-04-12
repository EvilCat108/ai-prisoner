package auth

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/models"
	"crypto/rand"
	"encoding/hex"
	"errors"
)

// GenerateAPIKey generates a random API key
func GenerateAPIKey() (string, error) {
	bytes := make([]byte, 32)
	_, err := rand.Read(bytes)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

// Authenticate checks if the API key is valid and agent is active
func Authenticate(apiKey string) (*models.Agent, error) {
	var agent models.Agent
	err := db.DB.QueryRow("SELECT id, name, api_key, is_active, created_at FROM agents WHERE api_key = ? AND is_active = 1", apiKey).Scan(
		&agent.ID, &agent.Name, &agent.APIKey, &agent.IsActive, &agent.CreatedAt)
	if err != nil {
		return nil, errors.New("invalid API key or agent disabled")
	}
	return &agent, nil
}