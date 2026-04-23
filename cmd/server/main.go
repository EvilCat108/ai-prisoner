package main

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/handlers"
	"html/template"
	"log"
	"net/http"
	"os"
	"strings"
)

func main() {
	// Get configuration from environment or use defaults
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "arena.db"
	}
	
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	
	// Initialize database
	if err := db.InitDB(dbPath); err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer db.Close()

	// Parse templates
	handlers.Templates = template.Must(template.ParseGlob("templates/*.html"))

	// Routes
	http.HandleFunc("/register-instructions", handlers.RegisterInstructionsPage)
	http.HandleFunc("/agents/register", handlers.RegisterAgent)
	http.HandleFunc("/agents", handlers.GetAgents)
	http.HandleFunc("/matches", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handlers.GetMatches(w, r)
		} else {
			handlers.AuthMiddleware(handlers.CreateMatch)(w, r)
		}
	})
	http.HandleFunc("/matches/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if r.Method == http.MethodGet {
			if strings.Contains(path, "/replay") {
				handlers.GetReplay(w, r)
			} else {
				handlers.GetMatch(w, r)
			}
		} else {
			handlers.AuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(path, "/join") {
					handlers.JoinMatch(w, r)
				} else if strings.Contains(path, "/actions") {
					handlers.SubmitAction(w, r)
				} else {
					http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				}
			})(w, r)
		}
	})
	http.HandleFunc("/leaderboard", handlers.GetLeaderboard)
	http.HandleFunc("/", handlers.HomePage)

	addr := ":" + port
	log.Println("Starting server on", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}