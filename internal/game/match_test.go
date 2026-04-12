package game

import (
	"ai-prisoner/internal/models"
	"testing"
)

func TestCanTransition(t *testing.T) {
	tests := []struct {
		current, new models.MatchStatus
		shouldError bool
	}{
		{models.MatchCreated, models.MatchActive, false},
		{models.MatchCreated, models.MatchFailed, false},
		{models.MatchCreated, models.MatchCompleted, true},
		{models.MatchActive, models.MatchCompleted, false},
		{models.MatchActive, models.MatchFailed, false},
		{models.MatchActive, models.MatchCreated, true},
		{models.MatchCompleted, models.MatchFailed, true},
	}

	for _, test := range tests {
		err := CanTransition(test.current, test.new)
		if (err != nil) != test.shouldError {
			t.Errorf("CanTransition(%s, %s) error: %v, want error: %v", test.current, test.new, err, test.shouldError)
		}
	}
}