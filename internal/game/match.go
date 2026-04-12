package game

import (
	"ai-prisoner/internal/models"
	"errors"
)

// CanTransition checks if a match can transition from current status to new status
func CanTransition(current models.MatchStatus, new models.MatchStatus) error {
	switch current {
	case models.MatchCreated:
		if new != models.MatchActive && new != models.MatchFailed {
			return errors.New("created match can only become active or failed")
		}
	case models.MatchActive:
		if new != models.MatchCompleted && new != models.MatchFailed {
			return errors.New("active match can only become completed or failed")
		}
	case models.MatchCompleted, models.MatchFailed:
		return errors.New("completed or failed match cannot transition")
	default:
		return errors.New("invalid current status")
	}
	return nil
}