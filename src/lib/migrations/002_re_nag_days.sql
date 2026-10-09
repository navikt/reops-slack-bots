-- Re-remind cooldown as its own knob. Was coupled to scan_window_days, which
-- meant a message nagged late in the window aged out before ever being
-- re-nagged. 7 days is the old default halved — independent of scan window.
INSERT INTO settings (key, value) VALUES ('re_nag_days', '7')
ON CONFLICT (key) DO NOTHING;
