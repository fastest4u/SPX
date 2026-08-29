-- Migration 039: Add per-team bidding_vehicle_type column
-- NULL means "poll all vehicle types" (same as no filter)
-- 13 = 6WH-6ล้อ[7.2m], 2 = 4WH-4ล้อ

ALTER TABLE teams ADD COLUMN bidding_vehicle_type INT NULL;
