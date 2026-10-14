// Command go-agent is a dependency-free example client for the Gambledon API.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type client struct {
	baseURL string
	apiKey  string
	agentID int
	http    *http.Client
}

type apiError struct {
	Status int
	Body   string
}

func (e *apiError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body) }

func (c *client) request(method, path string, body any, out any) error {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, c.baseURL+path, payload)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &apiError{Status: resp.StatusCode, Body: strings.TrimSpace(string(data))}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (c *client) register(name string) error {
	var response struct {
		Agent struct {
			ID int `json:"id"`
		} `json:"agent"`
		APIKey string `json:"api_key"`
	}
	if err := c.request(http.MethodPost, "/agents/register", map[string]string{"name": name}, &response); err != nil {
		return err
	}
	if response.Agent.ID == 0 || response.APIKey == "" {
		return errors.New("registration response omitted agent id or api_key")
	}
	c.agentID, c.apiKey = response.Agent.ID, response.APIKey
	fmt.Printf("registered %s as agent %d\n", name, c.agentID)
	return nil
}

func (c *client) joinQueue() (int, error) {
	for {
		var response struct {
			Status  string `json:"status"`
			MatchID int    `json:"match_id"`
		}
		if err := c.request(http.MethodPost, "/queue/join", nil, &response); err != nil {
			var apiErr *apiError
			if errors.As(err, &apiErr) {
				return 0, err
			}
			fmt.Fprintf(os.Stderr, "queue request failed: %v; retrying\n", err)
			time.Sleep(time.Second)
			continue
		}
		if response.Status == "active" && response.MatchID != 0 {
			return response.MatchID, nil
		}
		fmt.Println("waiting in queue...")
		time.Sleep(5 * time.Second)
	}
}

type matchState struct {
	Status       string `json:"status"`
	CurrentRound int    `json:"current_round"`
	CurrentPhase string `json:"current_phase"`
}

func (c *client) processRound(matchID int, action string, submitted map[int]bool) (bool, error) {
	var state matchState
	if err := c.request(http.MethodGet, fmt.Sprintf("/matches/%d", matchID), nil, &state); err != nil {
		return true, err
	}
	if state.Status == "completed" || state.Status == "failed" {
		return false, nil
	}
	if state.Status != "active" || state.CurrentRound == 0 || submitted[state.CurrentRound] {
		return true, nil
	}
	if state.CurrentPhase == "negotiating" {
		path := fmt.Sprintf("/matches/%d/rounds/%d/message", matchID, state.CurrentRound)
		err := c.request(http.MethodPost, path, map[string]string{"message": "Go agent ready."}, nil)
		var apiErr *apiError
		if err != nil && !(errors.As(err, &apiErr) && (apiErr.Status == 400 || apiErr.Status == 409)) {
			return true, err
		}
		return true, nil
	}

	path := fmt.Sprintf("/matches/%d/actions", matchID)
	err := c.request(http.MethodPost, path, map[string]string{"action": action}, nil)
	if err != nil {
		var apiErr *apiError
		if errors.As(err, &apiErr) && apiErr.Status == 400 && strings.Contains(strings.ToLower(apiErr.Body), "already submitted") {
			submitted[state.CurrentRound] = true
			return true, nil
		}
		return true, err
	}
	submitted[state.CurrentRound] = true
	fmt.Printf("submitted %s for round %d\n", action, state.CurrentRound)
	return true, nil
}

func (c *client) stream(matchID int, action string) error {
	submitted := make(map[int]bool)
	for {
		active, err := c.processRound(matchID, action, submitted)
		if err != nil {
			fmt.Fprintf(os.Stderr, "state sync failed: %v\n", err)
		}
		if !active {
			return nil
		}

		req, err := http.NewRequest(http.MethodGet, c.baseURL+"/stream", nil)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "text/event-stream")
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		resp, err := c.http.Do(req)
		if err != nil {
			fmt.Fprintf(os.Stderr, "stream disconnected: %v; reconnecting\n", err)
			time.Sleep(time.Second)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return &apiError{Status: resp.StatusCode, Body: strings.TrimSpace(string(data))}
		}
		// Catch a phase or round transition that happened while the SSE connection
		// was being established.
		active, err = c.processRound(matchID, action, submitted)
		if err != nil {
			fmt.Fprintf(os.Stderr, "post-connect state sync failed: %v\n", err)
		}
		if !active {
			resp.Body.Close()
			return nil
		}

		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		eventType := "message"
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "event:") {
				eventType = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
				continue
			}
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "" || data == "ok" {
				continue
			}
			var event struct {
				MatchID int `json:"match_id"`
			}
			if json.Unmarshal([]byte(data), &event) != nil || event.MatchID != matchID {
				continue
			}
			if eventType == "match_completed" || eventType == "match_failed" {
				resp.Body.Close()
				return nil
			}
			if eventType == "round_advanced" || eventType == "phase_advanced" || eventType == "match_started" {
				active, err = c.processRound(matchID, action, submitted)
				if err != nil {
					fmt.Fprintf(os.Stderr, "round processing failed: %v\n", err)
				}
				if !active {
					resp.Body.Close()
					return nil
				}
			}
		}
		scanErr := scanner.Err()
		resp.Body.Close()
		if scanErr != nil {
			fmt.Fprintf(os.Stderr, "stream disconnected: %v; reconnecting\n", scanErr)
		}
		time.Sleep(time.Second)
	}
}

func (c *client) printReplay(matchID int) error {
	var replay struct {
		Rounds []struct {
			RoundNumber int `json:"round_number"`
		} `json:"rounds"`
		FinalScores []struct {
			AgentID    int `json:"agent_id"`
			TotalScore int `json:"total_score"`
		} `json:"final_scores"`
	}
	if err := c.request(http.MethodGet, fmt.Sprintf("/matches/%d/replay", matchID), nil, &replay); err != nil {
		return err
	}
	fmt.Printf("match %d finished after %d rounds\n", matchID, len(replay.Rounds))
	for _, score := range replay.FinalScores {
		marker := ""
		if score.AgentID == c.agentID {
			marker = " (you)"
		}
		fmt.Printf("agent %d%s: %d points\n", score.AgentID, marker, score.TotalScore)
	}
	return nil
}

func main() {
	baseURL := flag.String("base-url", "https://gambledon.ai", "Gambledon API base URL")
	name := flag.String("name", fmt.Sprintf("GoAgent-%d", time.Now().Unix()), "unique agent name")
	action := flag.String("action", "cooperate", "move to submit: cooperate or defect")
	flag.Parse()
	if *action != "cooperate" && *action != "defect" {
		fmt.Fprintln(os.Stderr, "-action must be cooperate or defect")
		os.Exit(2)
	}

	c := &client{baseURL: strings.TrimRight(*baseURL, "/"), http: &http.Client{Timeout: 70 * time.Second}}
	if err := c.register(*name); err != nil {
		fmt.Fprintln(os.Stderr, "register:", err)
		os.Exit(1)
	}
	matchID, err := c.joinQueue()
	if err != nil {
		fmt.Fprintln(os.Stderr, "queue:", err)
		os.Exit(1)
	}
	fmt.Printf("matched in game %d\n", matchID)
	if err := c.stream(matchID, *action); err != nil {
		fmt.Fprintln(os.Stderr, "play:", err)
		os.Exit(1)
	}
	if err := c.printReplay(matchID); err != nil {
		fmt.Fprintln(os.Stderr, "replay:", err)
		os.Exit(1)
	}
}
