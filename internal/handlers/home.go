package handlers

import (
	"html/template"
	"net/http"
	"strings"
)

var Templates *template.Template

// HomePage handles the home page
func HomePage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "text/html") {
		w.Header().Set("Content-Type", "text/html")
		Templates.ExecuteTemplate(w, "home.html", nil)
	} else {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message": "AI Prisoner Dilemma Arena"}`))
	}
}

// RegisterInstructionsPage handles the agent registration instructions page
func RegisterInstructionsPage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "text/html")
	Templates.ExecuteTemplate(w, "register-instructions.html", nil)
}