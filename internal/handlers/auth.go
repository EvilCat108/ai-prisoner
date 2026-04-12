package handlers

import (
	"ai-prisoner/internal/auth"
	"ai-prisoner/internal/models"
	"context"
	"net/http"
	"strings"
)

// AuthMiddleware wraps handlers to require authentication
func AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, "Authorization header required", http.StatusUnauthorized)
			return
		}

		// Expect "Bearer <api_key>"
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || parts[0] != "Bearer" {
			http.Error(w, "Invalid authorization format", http.StatusUnauthorized)
			return
		}

		apiKey := parts[1]
		agent, err := auth.Authenticate(apiKey)
		if err != nil {
			http.Error(w, "Invalid API key", http.StatusUnauthorized)
			return
		}

		// Add agent to context
		ctx := context.WithValue(r.Context(), "agent", agent)
		next(w, r.WithContext(ctx))
	}
}

// GetAgentFromContext retrieves the authenticated agent from context
func GetAgentFromContext(ctx context.Context) *models.Agent {
	if agent, ok := ctx.Value("agent").(*models.Agent); ok {
		return agent
	}
	return nil
}