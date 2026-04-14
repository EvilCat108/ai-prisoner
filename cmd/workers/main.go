package main

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/handlers"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strings"

	"github.com/syumai/workers"
)

// InitializeTemplates loads all HTML templates from the embedded templates directory
func InitializeTemplates() error {
	var err error
	handlers.Templates, err = template.ParseGlob("templates/*.html")
	if err != nil {
		return fmt.Errorf("failed to parse templates: %w", err)
	}
	return nil
}

// registerRoutes registers all HTTP routes with the standard http package
// These routes work seamlessly with both http.ListenAndServe and workers.Serve
func registerRoutes() {
	// Public routes
	http.HandleFunc("/register-instructions", handlers.RegisterInstructionsPage)
	http.HandleFunc("/agents/register", handlers.RegisterAgent)
	http.HandleFunc("/agents", handlers.GetAgents)
	
	// Match routes (some require authentication)
	http.HandleFunc("/matches", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handlers.GetMatches(w, r)
		} else {
			// POST requires authentication
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
	
	// Leaderboard (public)
	http.HandleFunc("/leaderboard", handlers.GetLeaderboard)
	
	// Homepage
	http.HandleFunc("/", handlers.HomePage)
}

// main is the entry point for Cloudflare Workers
// When running on Cloudflare Workers, this uses workers.Serve() instead of http.ListenAndServe()
// The D1 database binding is automatically available through environment variables
func main() {
	// Initialize templates
	if err := InitializeTemplates(); err != nil {
		log.Fatal("Failed to initialize templates:", err)
	}

	// Initialize database - in production this would use D1 binding
	// For local development, use SQLite
	// The D1 database connection is configured through wrangler.toml environment bindings
	if err := db.InitDB("arena.db"); err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer db.Close()

	// Register all routes
	registerRoutes()

	// Detect runtime environment and choose appropriate server
	isWorker := detectCloudflareWorker()
	
	if isWorker {
		// Running on Cloudflare Workers - use workers.Serve()
		log.Println("Starting Cloudflare Worker")
		if err := workers.Serve(nil); err != nil {
			log.Fatal("Cloudflare Worker error:", err)
		}
	} else {
		// Running locally or on traditional server - use http.ListenAndServe()
		port := "8080"
		addr := ":" + port
		log.Printf("Starting local server on %s", addr)
		log.Fatal(http.ListenAndServe(addr, nil))
	}
}

// detectCloudflareWorker checks if we're running on Cloudflare Workers
// by checking for the WORKERS_CF_ENVIRONMENT variable or other CF-specific markers
func detectCloudflareWorker() bool {
	// Check for Cloudflare-specific environment variable
	// This would be set in wrangler.toml configuration
	workers := workers.GetBinding("environment") != nil
	return workers
}
