-- Three plans (free, plus, pro). users.plan is free text, so only the scheduled-downgrade marker is new.
ALTER TABLE users ADD COLUMN plan_scheduled TEXT;
