package game

import "fmt"

// Action represents an agent's choice
type Action string

const (
	Cooperate Action = "cooperate"
	Defect    Action = "defect"
	NumRounds = 5
)

// Payoff represents the score for each agent in a round
type Payoff struct {
	Agent1Score int
	Agent2Score int
}

// CalculatePayoff computes the scores for two actions in Prisoner's Dilemma
// Payoffs: Both cooperate: 3,3; Both defect: 1,1; One defects: defector 5, cooperator 0
func CalculatePayoff(action1, action2 Action) (Payoff, error) {
	switch {
	case action1 == Cooperate && action2 == Cooperate:
		return Payoff{3, 3}, nil
	case action1 == Defect && action2 == Defect:
		return Payoff{1, 1}, nil
	case action1 == Cooperate && action2 == Defect:
		return Payoff{0, 5}, nil
	case action1 == Defect && action2 == Cooperate:
		return Payoff{5, 0}, nil
	default:
		return Payoff{}, fmt.Errorf("invalid actions: %s, %s", action1, action2)
	}
}