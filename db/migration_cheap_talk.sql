-- Migration: Add message column to actions table for Cheap Talk
ALTER TABLE actions ADD COLUMN message TEXT;

