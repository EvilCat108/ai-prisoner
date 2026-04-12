package handlers

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/models"
	"encoding/json"
	"net/http"
	"strings"
)

// GetAgents handles getting the list of agents
func GetAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rows, err := db.DB.Query("SELECT id, name, api_key, is_active, created_at FROM agents ORDER BY id")
	if err != nil {
		http.Error(w, "Failed to get agents", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var agents []models.Agent
	for rows.Next() {
		var agent models.Agent
		rows.Scan(&agent.ID, &agent.Name, &agent.APIKey, &agent.IsActive, &agent.CreatedAt)
		agents = append(agents, agent)
	}

	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "text/html") {
		w.Header().Set("Content-Type", "text/html")
		Templates.ExecuteTemplate(w, "agents.html", agents)
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(agents)
	}
}