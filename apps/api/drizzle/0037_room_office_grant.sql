INSERT INTO "owned_rooms" ("user_id", "room_id")
SELECT "id", 'room-office' FROM "user"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "ledger" ("user_id", "delta", "reason", "source", "item_ref", "idempotency_key")
SELECT "id", 0, 'grant', 'game', 'room:room-office', 'server:grant-room-office' FROM "user"
ON CONFLICT DO NOTHING;
