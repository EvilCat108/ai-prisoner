package game

import "testing"

func TestCalculatePayoff(t *testing.T) {
	tests := []struct {
		action1, action2 Action
		expected        Payoff
	}{
		{Cooperate, Cooperate, Payoff{3, 3}},
		{Defect, Defect, Payoff{1, 1}},
		{Cooperate, Defect, Payoff{0, 5}},
		{Defect, Cooperate, Payoff{5, 0}},
	}

	for _, test := range tests {
		payoff, err := CalculatePayoff(test.action1, test.action2)
		if err != nil {
			t.Errorf("Unexpected error: %v", err)
		}
		if payoff != test.expected {
			t.Errorf("CalculatePayoff(%s, %s) = %v, want %v", test.action1, test.action2, payoff, test.expected)
		}
	}
}

func TestCalculatePayoffInvalid(t *testing.T) {
	_, err := CalculatePayoff("invalid", Cooperate)
	if err == nil {
		t.Error("Expected error for invalid action")
	}
}