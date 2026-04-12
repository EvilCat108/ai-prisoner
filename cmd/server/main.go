package main

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/handlers"
	"html/template"
	"log"
	"net/http"
	"strings"
)

func main() {
	// Initialize database
	if err := db.InitDB("arena.db"); err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer db.Close()

	// Parse templates
	handlers.Templates = template.Must(template.ParseGlob("templates/*.html"))

	// Routes
	http.HandleFunc("/agents/register", handlers.RegisterAgent)
	http.HandleFunc("/agents", handlers.GetAgents)
	http.HandleFunc("/matches", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handlers.GetMatches(w, r)
		} else {
			handlers.AuthMiddleware(handlers.CreateMatch)(w, r)
		}
	})
	http.HandleFunc("/matches/", handlers.AuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.Contains(path, "/join") {
			handlers.JoinMatch(w, r)
		} else if strings.Contains(path, "/actions") {
			handlers.SubmitAction(w, r)
		} else if strings.Contains(path, "/replay") {
			handlers.GetReplay(w, r)
		} else {
			handlers.GetMatch(w, r)
		}
	}))
	http.HandleFunc("/leaderboard", handlers.GetLeaderboard)
	http.HandleFunc("/", handlers.HomePage)

	log.Println("Starting server on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}