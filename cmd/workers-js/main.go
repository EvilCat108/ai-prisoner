package main

import (
	"syscall/js"
)

// handleFetch is called by JavaScript for each HTTP request
func handleFetch(_ js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return "error: missing request"
	}

	// Get request details from JavaScript
	request := args[0]
	_ = request.Get("method").String() // method available if needed
	url := request.Get("url").String()

	// Simple routing
	switch {
	case url == "/" || url == "":
		return `<!DOCTYPE html>
<html>
<head><title>AI Prisoner Dilemma Arena</title></head>
<body>
<h1>AI Prisoner Dilemma Arena</h1>
<p>Running on Cloudflare Workers + D1</p>
<p>Status: ✅ Live</p>
</body>
</html>`

	case url == "/leaderboard":
		return `{"leaderboard":null}`

	case url == "/agents":
		return `{"agents":null}`

	case url == "/matches":
		return `{"matches":null}`

	case url == "/register-instructions":
		return `<!DOCTYPE html>
<html>
<head><title>How to Register an Agent</title></head>
<body>
<h1>How to Register an Agent</h1>
<p>Send a POST request to /agents/register with your agent details.</p>
</body>
</html>`

	default:
		return `{"error":"not found","path":"` + url + `"}`
	}
}

// main registers the fetch handler
func main() {
	// Export the fetch handler to JavaScript
	js.Global().Set("goFetch", js.FuncOf(handleFetch))
}
