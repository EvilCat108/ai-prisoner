-- Migration: Add response_time_ms column to actions table
ALTER TABLE actions ADD COLUMN response_time_ms INTEGER;
