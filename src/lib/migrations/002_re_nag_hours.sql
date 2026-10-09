-- Re-remind cooldown as its own knob, in hours (168 = 7 days). Was coupled
-- to scan_window_days, which meant a message nagged late in the window aged
-- out before ever being re-nagged.
INSERT INTO settings (key, value) VALUES ('re_nag_hours', '168')
ON CONFLICT (key) DO NOTHING;
