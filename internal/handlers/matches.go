package handlers

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/models"
	"encoding/json"
	"net/http"
	"strings"
)

// GetMatches handles getting the list of matches
func GetMatches(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rows, err := db.DB.Query("SELECT id, agent1_id, agent2_id, status, created_at FROM matches ORDER BY id DESC")
	if err != nil {
		http.Error(w, "Failed to get matches", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var matches []models.Match
	for rows.Next() {
		var match models.Match
		rows.Scan(&match.ID, &match.Agent1ID, &match.Agent2ID, &match.Status, &match.CreatedAt)
		matches = append(matches, match)
	}

	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "text/html") {
		w.Header().Set("Content-Type", "text/html")
		Templates.ExecuteTemplate(w, "matches.html", matches)
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(matches)
	}
}